export type LedgerErrorCode =
  | "invalid_amount"
  | "invalid_currency"
  | "invalid_time_zone"
  | "invalid_month"
  | "invalid_posting"
  | "invalid_plan"
  | "invalid_fx_rate"
  | "user_required"
  | "account_not_found"
  | "category_not_found"
  | "currency_mismatch"
  | "not_found"
  | "conflict"
  | "fx_rate_missing";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

export function assertUserId(userId: string): string {
  if (typeof userId !== "string" || userId.length === 0 || userId.trim() !== userId) {
    throw new LedgerError("user_required", "userId is required");
  }
  return userId;
}
