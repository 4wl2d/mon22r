/**
 * Comparison key for a note or description: trimmed, lower-cased, single spaces.
 * Stored next to each transaction so a remembered category is an indexed lookup.
 */
export function noteKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
