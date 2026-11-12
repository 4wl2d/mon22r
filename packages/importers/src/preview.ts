import { type CurrencyCode, type Direction, type PulledStatementLine, parseAmount } from "@mon22r/domain";

import { type CsvMapping, cell, currencyFromCell, headerFingerprint, parseCsvTable } from "./csv.js";

export const SKIP_REASONS = ["opening_balance", "closing_balance", "cashback_points", "unparsed"] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

export type PreviewRow = {
  readonly status: "new" | "duplicate" | "skipped";
  readonly reason: SkipReason | null;
  readonly line: PulledStatementLine | null;
};

export type PreviewCounts = {
  readonly new: number;
  readonly duplicate: number;
  readonly skipped: number;
};

export type ImportPreview = {
  readonly headers: readonly string[];
  readonly fingerprint: string;
  readonly rows: readonly PreviewRow[];
  readonly counts: PreviewCounts;
};

const SKIP_RULES: readonly { readonly reason: Exclude<SkipReason, "unparsed">; readonly pattern: RegExp }[] = [
  { reason: "opening_balance", pattern: /opening balance/i },
  { reason: "closing_balance", pattern: /closing balance/i },
  { reason: "cashback_points", pattern: /cashback points/i },
];

export function previewCsv(input: {
  readonly csv: string;
  readonly mapping: CsvMapping;
  readonly isDuplicate: (externalKey: string) => boolean;
}): ImportPreview {
  const table = parseCsvTable(input.csv);
  const fingerprint = headerFingerprint(table.headers);
  const seen = new Set<string>();
  const rows: PreviewRow[] = [];
  for (const record of table.records) {
    const rowText = Object.values(record).join(" ");
    const description = cell(record, input.mapping.description).trim();
    const skipped = skipReason(`${description}\n${rowText}`);
    if (skipped !== null) {
      rows.push({ status: "skipped", reason: skipped, line: null });
      continue;
    }
    const line = lineFromRecord(record, input.mapping);
    if (line === null) {
      rows.push({ status: "skipped", reason: "unparsed", line: null });
      continue;
    }
    const duplicate = seen.has(line.externalKey) || input.isDuplicate(line.externalKey);
    seen.add(line.externalKey);
    rows.push({
      status: duplicate ? "duplicate" : "new",
      reason: null,
      line,
    });
  }
  return { headers: table.headers, fingerprint, rows, counts: countRows(rows) };
}

export function countRows(rows: readonly PreviewRow[]): PreviewCounts {
  let created = 0;
  let duplicate = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.status === "new") created += 1;
    else if (row.status === "duplicate") duplicate += 1;
    else skipped += 1;
  }
  return { new: created, duplicate, skipped };
}

export function skipReason(text: string): Exclude<SkipReason, "unparsed"> | null {
  for (const rule of SKIP_RULES) {
    if (rule.pattern.test(text)) return rule.reason;
  }
  return null;
}

function lineFromRecord(record: Record<string, string>, mapping: CsvMapping): PulledStatementLine | null {
  const bookedAt = normalizeBookedAt(cell(record, mapping.date));
  const description = cell(record, mapping.description).trim();
  const amount = readAmount(record, mapping);
  const currency = readCurrency(record, mapping);
  if (bookedAt === null || amount === null || currency === null) return null;
  const externalKey = externalKeyFor(record, mapping, {
    bookedAt,
    direction: amount.direction,
    amountMinor: amount.minor,
    currency,
    description,
  });
  if (externalKey.length === 0) return null;
  return {
    externalKey,
    bookedAt,
    amountMinor: amount.minor,
    currency,
    direction: amount.direction,
    description,
  };
}

function readAmount(
  record: Record<string, string>,
  mapping: CsvMapping,
): { minor: number; direction: Direction } | null {
  if (mapping.debit !== undefined || mapping.credit !== undefined) {
    const debit = mapping.debit === undefined ? "" : cell(record, mapping.debit).trim();
    const credit = mapping.credit === undefined ? "" : cell(record, mapping.credit).trim();
    if (debit.length > 0 && credit.length === 0) return absoluteAmount(debit, "outflow");
    if (credit.length > 0 && debit.length === 0) return absoluteAmount(credit, "inflow");
    return null;
  }
  if (mapping.amount === undefined) return null;
  const raw = cell(record, mapping.amount).trim();
  if (raw.length === 0) return null;
  const directed = directionOverride(mapping.direction === undefined ? "" : cell(record, mapping.direction));
  const signed = parseSignedAmount(raw);
  if (signed === null) return null;
  return directed === null ? signed : { minor: signed.minor, direction: directed };
}

function absoluteAmount(raw: string, direction: Direction): { minor: number; direction: Direction } | null {
  const signed = parseSignedAmount(raw);
  if (signed === null) return null;
  return { minor: signed.minor, direction };
}

function parseSignedAmount(raw: string): { minor: number; direction: Direction } | null {
  let numeric = raw.trim();
  let direction: Direction = "inflow";
  if (numeric.startsWith("(") && numeric.endsWith(")")) {
    direction = "outflow";
    numeric = numeric.slice(1, -1).trim();
  }
  if (numeric.startsWith("-")) {
    direction = "outflow";
    numeric = numeric.slice(1).trim();
  } else if (numeric.startsWith("+")) {
    numeric = numeric.slice(1).trim();
  }
  try {
    const parsed = parseAmount(numeric);
    if (parsed.minor <= 0) return null;
    return { minor: parsed.minor, direction };
  } catch {
    return null;
  }
}

function directionOverride(value: string): Direction | null {
  const token = value.trim().toLowerCase();
  if (token.length === 0) return null;
  if (token === "out" || token === "outflow" || token === "debit" || token === "expense" || token === "-")
    return "outflow";
  if (token === "in" || token === "inflow" || token === "credit" || token === "income" || token === "+")
    return "inflow";
  return null;
}

function readCurrency(record: Record<string, string>, mapping: CsvMapping): CurrencyCode | null {
  if (mapping.currency !== undefined) {
    const fromColumn = currencyFromCell(cell(record, mapping.currency));
    if (fromColumn !== null) return fromColumn;
  }
  return mapping.fixedCurrency ?? null;
}

function externalKeyFor(
  record: Record<string, string>,
  mapping: CsvMapping,
  line: {
    readonly bookedAt: string;
    readonly direction: Direction;
    readonly amountMinor: number;
    readonly currency: string;
    readonly description: string;
  },
): string {
  if (mapping.externalKey !== undefined) {
    const value = cell(record, mapping.externalKey).trim();
    if (value.length > 0) return value;
  }
  return [line.bookedAt, line.direction, String(line.amountMinor), line.currency, line.description].join("|");
}

function normalizeBookedAt(value: string): string | null {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso?.[1] !== undefined && iso[2] !== undefined && iso[3] !== undefined) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(trimmed);
  const day = dmy?.[1];
  const month = dmy?.[2];
  const year = dmy?.[3];
  if (day !== undefined && month !== undefined && year !== undefined) {
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return null;
}
