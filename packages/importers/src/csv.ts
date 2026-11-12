import { assertCurrency, parseAmount, type CurrencyCode } from "@mon22r/domain";

/**
 * Column names are the header cells from the file the user confirmed.
 * A signed amount uses a leading minus or parentheses as outflow.
 * `fixedCurrency` is an ISO code when the file has no currency column.
 */
export type CsvMapping = {
  readonly date: string;
  readonly description: string;
  readonly amount?: string;
  readonly debit?: string;
  readonly credit?: string;
  readonly direction?: string;
  readonly currency?: string;
  readonly fixedCurrency?: CurrencyCode;
  readonly externalKey?: string;
};

export type CsvTable = {
  readonly headers: readonly string[];
  readonly records: readonly Record<string, string>[];
};

export function headerFingerprint(headers: readonly string[]): string {
  return headers.map((header) => header.trim().toLowerCase().replace(/\s+/g, " ")).join("|");
}

export function parseCsvTable(csv: string): CsvTable {
  const text = csv.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (text.trim().length === 0) return { headers: [], records: [] };
  const delimiter = detectDelimiter(text);
  const matrix = parseMatrix(text, delimiter);
  const headerRow = matrix[0];
  if (headerRow === undefined) return { headers: [], records: [] };
  const headers = headerRow.map((header) => header.trim());
  const records: Record<string, string>[] = [];
  for (const row of matrix.slice(1)) {
    if (row.every((cell) => cell.trim().length === 0)) continue;
    const record: Record<string, string> = {};
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      if (header === undefined || header.length === 0 || Object.hasOwn(record, header)) continue;
      record[header] = row[index] ?? "";
    }
    records.push(record);
  }
  return { headers, records };
}

export function cell(record: Record<string, string>, header: string): string {
  if (Object.hasOwn(record, header)) return record[header] ?? "";
  const wanted = header.trim().toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.trim().toLowerCase() === wanted) return value;
  }
  return "";
}

export function headersCover(headers: readonly string[], mapping: CsvMapping): boolean {
  const have = new Set(headers.map((header) => header.trim().toLowerCase()));
  const needed = [
    mapping.date,
    mapping.description,
    mapping.amount,
    mapping.debit,
    mapping.credit,
    mapping.direction,
    mapping.currency,
    mapping.externalKey,
  ];
  return needed.every((column) => column === undefined || have.has(column.trim().toLowerCase()));
}

export function parseMapping(value: unknown): CsvMapping | null {
  if (!isRecord(value)) return null;
  const date = requiredString(value.date);
  const description = requiredString(value.description);
  if (date === null || description === null) return null;
  const amount = optionalString(value.amount);
  const debit = optionalString(value.debit);
  const credit = optionalString(value.credit);
  if (amount === undefined && debit === undefined && credit === undefined) return null;
  const fixedRaw = optionalString(value.fixedCurrency);
  let fixedCurrency: CurrencyCode | undefined;
  if (fixedRaw !== undefined) {
    try {
      fixedCurrency = assertCurrency(fixedRaw.toUpperCase());
    } catch {
      return null;
    }
  }
  const mapping: CsvMapping = {
    date,
    description,
    ...(amount === undefined ? {} : { amount }),
    ...(debit === undefined ? {} : { debit }),
    ...(credit === undefined ? {} : { credit }),
    ...(optionalString(value.direction) === undefined ? {} : { direction: optionalString(value.direction) }),
    ...(optionalString(value.currency) === undefined ? {} : { currency: optionalString(value.currency) }),
    ...(fixedCurrency === undefined ? {} : { fixedCurrency }),
    ...(optionalString(value.externalKey) === undefined ? {} : { externalKey: optionalString(value.externalKey) }),
  };
  return mapping;
}

export function currencyFromCell(value: string): CurrencyCode | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^[A-Za-z]{3}$/.test(trimmed)) {
    try {
      return assertCurrency(trimmed.toUpperCase());
    } catch {
      return null;
    }
  }
  try {
    return parseAmount(`1 ${trimmed}`).currency;
  } catch {
    return null;
  }
}

function detectDelimiter(text: string): string {
  const first = firstLine(text);
  const counts = new Map<string, number>([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  for (const char of first) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let best = ",";
  let bestCount = -1;
  for (const [delimiter, count] of counts) {
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function firstLine(text: string): string {
  let quoted = false;
  let line = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        line += '"';
        index += 1;
        continue;
      }
      quoted = !quoted;
      line += char;
      continue;
    }
    if (char === "\n" && !quoted) break;
    line += char ?? "";
  }
  return line;
}

function parseMatrix(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cellValue = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cellValue += '"';
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === delimiter) {
      row.push(cellValue);
      cellValue = "";
      continue;
    }
    if (!quoted && char === "\n") {
      row.push(cellValue);
      rows.push(row);
      row = [];
      cellValue = "";
      continue;
    }
    cellValue += char ?? "";
  }
  if (cellValue.length > 0 || row.length > 0) {
    row.push(cellValue);
    rows.push(row);
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
