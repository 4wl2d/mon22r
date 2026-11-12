import { LedgerError, parseAmount } from "@mon22r/domain";
import { describe, expect, it } from "vitest";

describe("parseAmount", () => {
  it("parses spaced comma decimals, dotted decimals, and whole amounts", () => {
    expect(parseAmount("1 200,50")).toEqual({ minor: 120_050, currency: null });
    expect(parseAmount("4.50")).toEqual({ minor: 450, currency: null });
    expect(parseAmount("1200")).toEqual({ minor: 120_000, currency: null });
    expect(parseAmount("1\u00A0200,50")).toEqual({ minor: 120_050, currency: null });
    expect(parseAmount("1.200")).toEqual({ minor: 120_000, currency: null });
    expect(parseAmount("1.200,50")).toEqual({ minor: 120_050, currency: null });
  });

  it("reads rsd, rub, Cyrillic р, gbp, and £", () => {
    expect(parseAmount("1 200,50 rsd")).toEqual({ minor: 120_050, currency: "RSD" });
    expect(parseAmount("4.50 gbp")).toEqual({ minor: 450, currency: "GBP" });
    expect(parseAmount("1200 rub")).toEqual({ minor: 120_000, currency: "RUB" });
    expect(parseAmount("1200 р")).toEqual({ minor: 120_000, currency: "RUB" });
    expect(parseAmount("£4.50")).toEqual({ minor: 450, currency: "GBP" });
    expect(parseAmount("4.50 £")).toEqual({ minor: 450, currency: "GBP" });
    expect(parseAmount("1200р")).toEqual({ minor: 120_000, currency: "RUB" });
  });

  it("uses a zero exponent for yen and refuses extra fraction digits", () => {
    expect(parseAmount("1200 jpy")).toEqual({ minor: 1200, currency: "JPY" });
    expect(() => parseAmount("4.50 jpy")).toThrow(LedgerError);
    expect(() => parseAmount("12.3456")).toThrow(LedgerError);
  });
});
