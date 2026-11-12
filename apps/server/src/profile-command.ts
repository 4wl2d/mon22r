import { parseMapping, type CsvMapping } from "@mon22r/importers";

export function parseProfileCommand(text: string): { readonly name: string; readonly mapping: CsvMapping } | null {
  const match = /^профиль\s+([^|]+?)\s*\|\s*(.+)$/iu.exec(text.trim());
  const name = match?.[1]?.trim();
  const rest = match?.[2];
  if (name === undefined || name.length === 0 || rest === undefined) return null;
  const fields: Record<string, string> = {};
  for (const part of rest.split("|")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key.length === 0 || value.length === 0) return null;
    fields[key] = value;
  }
  if (fields.currencyColumn !== undefined) {
    fields.currency = fields.currencyColumn;
    delete fields.currencyColumn;
  } else if (fields.currency !== undefined && /^[A-Za-z]{3}$/.test(fields.currency) && fields.fixedCurrency === undefined) {
    fields.fixedCurrency = fields.currency.toUpperCase();
    delete fields.currency;
  }
  const mapping = parseMapping(fields);
  if (mapping === null) return null;
  return { name, mapping };
}
