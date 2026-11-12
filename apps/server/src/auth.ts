import { parse, validate } from "@tma.js/init-data-node";

export class AccessError extends Error {
  constructor() {
    super("Нет доступа.");
    this.name = "AccessError";
  }
}

/** Authorization: tma <raw init data>. The signature is checked with the bot token. */
export function telegramUserId(header: string | undefined, botToken: string, allowed: ReadonlySet<number>): number {
  if (header === undefined) throw new AccessError();
  const trimmed = header.trim();
  const prefix = "tma ";
  if (trimmed.length <= prefix.length || trimmed.slice(0, prefix.length).toLowerCase() !== prefix) throw new AccessError();
  const raw = trimmed.slice(prefix.length);
  try {
    validate(raw, botToken, { expiresIn: 86_400 });
    const id = parse(raw).user?.id;
    if (id === undefined || !Number.isSafeInteger(id) || !allowed.has(id)) throw new AccessError();
    return id;
  } catch (error) {
    if (error instanceof AccessError) throw error;
    throw new AccessError();
  }
}

export function parseAllowedIds(value: string | undefined): ReadonlySet<number> {
  if (value === undefined) throw new Error("ALLOWED_TELEGRAM_IDS is required");
  const ids = new Set<number>();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    if (!/^\d+$/.test(trimmed)) throw new Error(`ALLOWED_TELEGRAM_IDS contains "${trimmed}"`);
    const id = Number(trimmed);
    if (!Number.isSafeInteger(id)) throw new Error("ALLOWED_TELEGRAM_IDS is too large");
    ids.add(id);
  }
  return ids;
}
