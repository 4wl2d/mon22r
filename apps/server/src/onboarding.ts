import { assertCurrency, assertTimeZone, DEFAULT_TIME_ZONE } from "@mon22r/domain";

export const STARTER_ACCOUNTS = [
  { name: "Поштанска", currency: "RSD" },
  { name: "Рубли", currency: "RUB" },
  { name: "UK", currency: "GBP" },
] as const;

export type OnboardingStep = "currency" | "timezone" | "accounts" | "ready";

export type OnboardingEvent =
  | { readonly type: "save-currency"; readonly homeCurrency: string }
  | { readonly type: "save-timezone"; readonly timeZone: string }
  | { readonly type: "finish"; readonly createStarterAccounts: boolean }
  | { readonly type: "invalid" };

const YES = new Set(["да", "yes", "создай", "создать"]);
const NO = new Set(["нет", "no", "не надо", "не нужно"]);
const ACCEPT_ZONE = new Set(["да", "ок", "ok", "europe/belgrade", "по умолчанию", "оставить"]);

/** Persisted user row -> the question still waiting. Null step means setup is finished. */
export function awaitingStep(input: {
  readonly userExists: boolean;
  readonly onboardingStep: "timezone" | "accounts" | null;
}): OnboardingStep {
  if (!input.userExists) return "currency";
  if (input.onboardingStep === null) return "ready";
  return input.onboardingStep;
}

export function decideOnboarding(step: Exclude<OnboardingStep, "ready">, text: string): OnboardingEvent {
  if (step === "currency") {
    const homeCurrency = parseHomeCurrency(text);
    return homeCurrency === null ? { type: "invalid" } : { type: "save-currency", homeCurrency };
  }
  if (step === "timezone") {
    const timeZone = parseTimeZoneChoice(text);
    return timeZone === null ? { type: "invalid" } : { type: "save-timezone", timeZone };
  }
  const choice = parseStarterAccountChoice(text);
  if (choice === null) return { type: "invalid" };
  return { type: "finish", createStarterAccounts: choice === "yes" };
}

export function starterAccountsIfConfirmed(
  choice: "yes" | "no" | null,
): readonly { readonly name: string; readonly currency: string }[] {
  if (choice !== "yes") return [];
  return STARTER_ACCOUNTS;
}

export function parseHomeCurrency(text: string): string | null {
  const token = text.trim();
  if (!/^[A-Za-z]{3}$/.test(token)) return null;
  try {
    return assertCurrency(token.toUpperCase());
  } catch {
    return null;
  }
}

export function parseTimeZoneChoice(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (ACCEPT_ZONE.has(trimmed.toLowerCase())) return DEFAULT_TIME_ZONE;
  try {
    return assertTimeZone(trimmed);
  } catch {
    return null;
  }
}

export function parseStarterAccountChoice(text: string): "yes" | "no" | null {
  const token = text.trim().toLowerCase();
  if (YES.has(token)) return "yes";
  if (NO.has(token)) return "no";
  return null;
}
