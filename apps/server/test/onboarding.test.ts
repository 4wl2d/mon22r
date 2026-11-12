import { describe, expect, it } from "vitest";

import { buttons, closePlanLabel, text, toast } from "../src/copy.js";
import {
  awaitingStep,
  decideOnboarding,
  parseStarterAccountChoice,
  STARTER_ACCOUNTS,
  starterAccountsIfConfirmed,
} from "../src/onboarding.js";

describe("onboarding decisions", () => {
  it("keeps the saved step so a restart continues instead of trapping the user", () => {
    expect(awaitingStep({ userExists: false, onboardingStep: null })).toBe("currency");
    expect(awaitingStep({ userExists: true, onboardingStep: "timezone" })).toBe("timezone");
    expect(awaitingStep({ userExists: true, onboardingStep: "accounts" })).toBe("accounts");
    expect(awaitingStep({ userExists: true, onboardingStep: null })).toBe("ready");
  });

  it("asks for a currency, then a time zone, then starter accounts only after an explicit yes", () => {
    expect(decideOnboarding("currency", "RSD")).toEqual({ type: "save-currency", homeCurrency: "RSD" });
    expect(decideOnboarding("currency", "gbp")).toEqual({ type: "save-currency", homeCurrency: "GBP" });
    expect(decideOnboarding("currency", "usd")).toEqual({ type: "save-currency", homeCurrency: "USD" });
    expect(decideOnboarding("currency", "кофе 350")).toEqual({ type: "invalid" });

    expect(decideOnboarding("timezone", "да")).toEqual({ type: "save-timezone", timeZone: "Europe/Belgrade" });
    expect(decideOnboarding("timezone", "Europe/London")).toEqual({ type: "save-timezone", timeZone: "Europe/London" });
    expect(decideOnboarding("timezone", "Belgrade")).toEqual({ type: "invalid" });

    expect(decideOnboarding("accounts", "да")).toEqual({ type: "finish", createStarterAccounts: true });
    expect(decideOnboarding("accounts", "нет")).toEqual({ type: "finish", createStarterAccounts: false });
    expect(decideOnboarding("accounts", "кофе 350")).toEqual({ type: "invalid" });
    expect(parseStarterAccountChoice("создать")).toBe("yes");
    expect(starterAccountsIfConfirmed("yes")).toEqual(STARTER_ACCOUNTS);
    expect(starterAccountsIfConfirmed("no")).toEqual([]);
    expect(starterAccountsIfConfirmed(null)).toEqual([]);
    expect(STARTER_ACCOUNTS).toEqual([
      { name: "Поштанска", currency: "RSD" },
      { name: "Рубли", currency: "RUB" },
      { name: "UK", currency: "GBP" },
    ]);
  });

  it("keeps bot copy free of exclamation marks", () => {
    const samples: string[] = [...Object.values(buttons)];
    for (const value of [...Object.values(text), ...Object.values(toast)]) {
      if (typeof value === "string") samples.push(value);
    }
    samples.push(
      text.noAccount("RSD"),
      text.noDestination("наличные"),
      text.currencyMismatch("Наличные", "RUB", "RSD"),
      text.importCounts({ new: 1, duplicate: 2, skipped: 3 }),
      text.importPreview({ new: 1, duplicate: 2, skipped: 3 }, "Наличные"),
      text.importDone(1, "Наличные"),
      text.mappingNeeded(["Date", "Amount"]),
      text.planSaved("180000", "RSD", "зп", "каждый месяц 5-го числа · с декабря 2026"),
      text.undone("−350 RSD · кофе"),
      toast.movedTo("Наличные"),
      closePlanLabel("зп"),
    );
    expect(samples.join("\n")).not.toContain("!");
  });
});
