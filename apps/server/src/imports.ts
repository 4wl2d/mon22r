import {
  findStatementProfileByFingerprint,
  findTransactionByImportKey,
  insertImportPreview,
  listAccounts,
  readImportPreview,
  readUserFlags,
  recordTransaction,
  removeImportPreview,
  saveStatementProfile,
  updateImportPreviewAccount,
  updateStoredUser,
  type Mon22rDb,
} from "@mon22r/db";
import { LedgerError, type Account, type PulledStatementLine, type Transaction, type User } from "@mon22r/domain";
import {
  commitStatementLines,
  headerFingerprint,
  headersCover,
  parseCsvTable,
  parseMapping,
  previewCsv,
  type PreviewCounts,
  type PreviewRow,
} from "@mon22r/importers";

import { parseProfileCommand } from "./profile-command.js";

export type PendingCsv = {
  readonly fingerprint: string;
  readonly headers: readonly string[];
};

export type UploadResult =
  | { readonly type: "empty" }
  | { readonly type: "mapping_required"; readonly fingerprint: string; readonly headers: readonly string[] }
  | { readonly type: "mixed_currency" }
  | { readonly type: "no_account"; readonly currency: string }
  | {
      readonly type: "currency_mismatch";
      readonly accountName: string;
      readonly accountCurrency: string;
      readonly fileCurrency: string;
    }
  | { readonly type: "counts"; readonly counts: PreviewCounts; readonly source: string; readonly rows: readonly PreviewRow[] }
  | {
      readonly type: "choose_account";
      readonly previewId: string;
      readonly accounts: readonly Account[];
      readonly counts: PreviewCounts;
      readonly rows: readonly PreviewRow[];
    }
  | {
      readonly type: "ready";
      readonly previewId: string;
      readonly account: Account;
      readonly counts: PreviewCounts;
      readonly source: string;
      readonly rows: readonly PreviewRow[];
    };

export function previewUpload(
  db: Mon22rDb,
  user: User,
  csv: string,
  options?: { readonly accountId?: string; readonly mapping?: unknown; readonly profileName?: string },
): UploadResult {
  const table = parseCsvTable(csv);
  if (table.headers.length === 0) return { type: "empty" };
  const fingerprint = headerFingerprint(table.headers);
  let profile = findStatementProfileByFingerprint(db, user.id, fingerprint);
  const mapping = options?.mapping === undefined ? null : parseMapping(options.mapping);
  if (options?.mapping !== undefined && mapping === null) {
    throw new LedgerError("invalid_posting", "Column mapping is invalid");
  }
  if (mapping !== null) {
    if (!headersCover(table.headers, mapping)) throw new LedgerError("invalid_posting", "Column mapping does not match the header");
    const name = profile?.name ?? options?.profileName?.trim();
    if (name === undefined || name.length === 0) throw new LedgerError("invalid_posting", "Profile name is required");
    profile = saveStatementProfile(db, user.id, { name, fingerprint, mappingJson: JSON.stringify(mapping) });
  }
  if (profile === null) {
    updateStoredUser(db, user.id, { pendingCsvJson: JSON.stringify({ fingerprint, headers: table.headers }) });
    return { type: "mapping_required", fingerprint, headers: table.headers };
  }
  const storedMapping = parseMapping(readJson(profile.mappingJson));
  if (storedMapping === null) {
    updateStoredUser(db, user.id, { pendingCsvJson: JSON.stringify({ fingerprint, headers: table.headers }) });
    return { type: "mapping_required", fingerprint, headers: table.headers };
  }
  updateStoredUser(db, user.id, { pendingCsvJson: null });
  const preview = previewCsv({
    csv,
    mapping: storedMapping,
    isDuplicate: (externalKey) => findTransactionByImportKey(db, user.id, profile.name, externalKey) !== null,
  });
  const lines = preview.rows.flatMap((row) => (row.line === null ? [] : [row.line]));
  if (lines.length === 0) return { type: "counts", counts: preview.counts, source: profile.name, rows: preview.rows };
  const currencies = uniqueCurrencies(lines);
  const fileCurrency = currencies[0];
  if (fileCurrency === undefined || currencies.length !== 1) return { type: "mixed_currency" };
  const accounts = listAccounts(db, user.id).filter((account) => !account.archived && account.currency === fileCurrency);
  if (options?.accountId !== undefined) {
    const account = accounts.find((item) => item.id === options.accountId) ?? null;
    if (account === null) {
      const any = listAccounts(db, user.id).find((item) => item.id === options.accountId) ?? null;
      if (any === null) throw new LedgerError("account_not_found", "Account was not found for this user");
      return { type: "currency_mismatch", accountName: any.name, accountCurrency: any.currency, fileCurrency };
    }
    const stored = insertImportPreview(db, user.id, {
      source: profile.name,
      accountId: account.id,
      linesJson: encodePreview(lines, preview.counts.skipped),
    });
    return { type: "ready", previewId: stored.id, account, counts: preview.counts, source: profile.name, rows: preview.rows };
  }
  if (accounts.length === 0) return { type: "no_account", currency: fileCurrency };
  if (accounts.length > 1) {
    const stored = insertImportPreview(db, user.id, {
      source: profile.name,
      accountId: null,
      linesJson: encodePreview(lines, preview.counts.skipped),
    });
    return { type: "choose_account", previewId: stored.id, accounts, counts: preview.counts, rows: preview.rows };
  }
  const account = accounts[0];
  if (account === undefined) return { type: "no_account", currency: fileCurrency };
  const stored = insertImportPreview(db, user.id, {
    source: profile.name,
    accountId: account.id,
    linesJson: encodePreview(lines, preview.counts.skipped),
  });
  return { type: "ready", previewId: stored.id, account, counts: preview.counts, source: profile.name, rows: preview.rows };
}

export function commitStoredPreview(
  db: Mon22rDb,
  user: User,
  previewId: string,
): { readonly created: number; readonly duplicate: number; readonly transactions: readonly Transaction[] } {
  const preview = readImportPreview(db, user.id, previewId);
  if (preview === null) throw new LedgerError("not_found", "Import preview was not found for this user");
  if (preview.accountId === null) throw new LedgerError("invalid_posting", "Account is required");
  const lines = decodePreview(preview.linesJson).lines;
  const apply = db.sqlite.transaction(() => {
    const result = commitStatementLines({
      userId: user.id,
      accountId: preview.accountId ?? "",
      source: preview.source,
      timeZone: user.timeZone,
      lines,
      record: (row) => recordTransaction(db, user.id, row),
    });
    removeImportPreview(db, user.id, preview.id);
    return result;
  });
  return apply();
}

export function assignPreviewAccount(db: Mon22rDb, user: User, previewId: string, accountId: string): UploadResult {
  const preview = readImportPreview(db, user.id, previewId);
  if (preview === null) throw new LedgerError("not_found", "Import preview was not found for this user");
  const stored = decodePreview(preview.linesJson);
  const lines = stored.lines;
  const currencies = uniqueCurrencies(lines);
  const fileCurrency = currencies[0];
  if (fileCurrency === undefined || currencies.length !== 1) return { type: "mixed_currency" };
  const account = listAccounts(db, user.id).find((item) => item.id === accountId) ?? null;
  if (account === null || account.archived) throw new LedgerError("account_not_found", "Account was not found for this user");
  if (account.currency !== fileCurrency) {
    return { type: "currency_mismatch", accountName: account.name, accountCurrency: account.currency, fileCurrency };
  }
  updateImportPreviewAccount(db, user.id, preview.id, account.id);
  const rows: PreviewRow[] = lines.map((line) => ({
    status: findTransactionByImportKey(db, user.id, preview.source, line.externalKey) === null ? "new" : "duplicate",
    reason: null,
    line,
  }));
  return {
    type: "ready",
    previewId: preview.id,
    account,
    counts: {
      new: rows.filter((row) => row.status === "new").length,
      duplicate: rows.filter((row) => row.status === "duplicate").length,
      skipped: stored.skipped,
    },
    source: preview.source,
    rows,
  };
}

export function savePendingProfile(db: Mon22rDb, user: User, command: string): "saved" | "missing" | "bad" | "columns" {
  const flags = readUserFlags(db, user.id);
  const pending = parsePendingCsv(flags?.pendingCsvJson ?? null);
  if (pending === null) return "missing";
  const parsed = parseProfileCommand(command);
  if (parsed === null) return "bad";
  if (!headersCover(pending.headers, parsed.mapping)) return "columns";
  saveStatementProfile(db, user.id, {
    name: parsed.name,
    fingerprint: pending.fingerprint,
    mappingJson: JSON.stringify(parsed.mapping),
  });
  updateStoredUser(db, user.id, { pendingCsvJson: null });
  return "saved";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function parsePendingCsv(value: string | null): PendingCsv | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const fingerprint = "fingerprint" in parsed ? parsed.fingerprint : undefined;
    const headers = "headers" in parsed ? parsed.headers : undefined;
    if (typeof fingerprint !== "string" || fingerprint.length === 0 || !Array.isArray(headers)) return null;
    const names: string[] = [];
    for (const header of headers) {
      if (typeof header !== "string") return null;
      names.push(header);
    }
    return { fingerprint, headers: names };
  } catch {
    return null;
  }
}

function encodePreview(lines: readonly PulledStatementLine[], skipped: number): string {
  return JSON.stringify({ lines, skipped });
}

function decodePreview(json: string): { readonly lines: PulledStatementLine[]; readonly skipped: number } {
  const parsed = readJson(json);
  if (Array.isArray(parsed)) return { lines: parseStoredLines(parsed), skipped: 0 };
  if (!isRecord(parsed) || !Array.isArray(parsed.lines)) throw new LedgerError("invalid_posting", "Import preview is invalid");
  const skipped = typeof parsed.skipped === "number" && Number.isSafeInteger(parsed.skipped) ? parsed.skipped : 0;
  return { lines: parseStoredLines(parsed.lines), skipped };
}

function parseStoredLines(parsed: unknown[]): PulledStatementLine[] {
  const lines: PulledStatementLine[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) throw new LedgerError("invalid_posting", "Import preview is invalid");
    const line = item as Partial<PulledStatementLine>;
    if (
      typeof line.externalKey !== "string" ||
      typeof line.bookedAt !== "string" ||
      typeof line.amountMinor !== "number" ||
      typeof line.currency !== "string" ||
      (line.direction !== "inflow" && line.direction !== "outflow") ||
      typeof line.description !== "string"
    ) {
      throw new LedgerError("invalid_posting", "Import preview is invalid");
    }
    lines.push({
      externalKey: line.externalKey,
      bookedAt: line.bookedAt,
      amountMinor: line.amountMinor,
      currency: line.currency,
      direction: line.direction,
      description: line.description,
    });
  }
  return lines;
}

function uniqueCurrencies(lines: readonly PulledStatementLine[]): string[] {
  return [...new Set(lines.map((line) => line.currency))].sort();
}
