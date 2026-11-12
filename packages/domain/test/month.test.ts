import { DEFAULT_TIME_ZONE, monthContaining, monthRange, transactionFromStatementLine } from "@mon22r/domain";
import { describe, expect, it } from "vitest";

const belgrade = "Europe/Belgrade";

describe("calendar months in Europe/Belgrade", () => {
  it("uses the IANA zone instead of UTC month boundaries", () => {
    expect(DEFAULT_TIME_ZONE).toBe(belgrade);

    const november = monthRange({ year: 2026, month: 11 }, belgrade);
    expect(november.startInclusive.toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(november.endExclusive.toISOString()).toBe("2026-11-30T23:00:00.000Z");

    expect(monthContaining(new Date("2026-10-31T22:59:59.999Z"), belgrade)).toEqual({
      year: 2026,
      month: 10,
    });
    expect(monthContaining(new Date("2026-10-31T23:00:00.000Z"), belgrade)).toEqual({
      year: 2026,
      month: 11,
    });
    expect(monthContaining(new Date("2026-11-30T22:59:59.999Z"), belgrade)).toEqual({
      year: 2026,
      month: 11,
    });
    expect(monthContaining(new Date("2026-11-30T23:00:00.000Z"), belgrade)).toEqual({
      year: 2026,
      month: 12,
    });

    const july = monthRange({ year: 2026, month: 7 }, belgrade);
    expect(july.startInclusive.toISOString()).toBe("2026-06-30T22:00:00.000Z");
    expect(july.endExclusive.toISOString()).toBe("2026-07-31T22:00:00.000Z");

    const october = monthRange({ year: 2026, month: 10 }, belgrade);
    expect(october.startInclusive.toISOString()).toBe("2026-09-30T22:00:00.000Z");
  });

  it("treats a date-only statement line as Belgrade midnight", () => {
    const transaction = transactionFromStatementLine({
      id: "line",
      userId: "user",
      accountId: "account",
      source: "statement",
      line: {
        externalKey: "row-1",
        bookedAt: "2026-11-01",
        amountMinor: 100,
        currency: "RSD",
        direction: "outflow",
        description: "shop",
      },
    });
    expect(transaction.occurredAt).toBe("2026-10-31T23:00:00.000Z");
    expect(monthContaining(new Date(transaction.occurredAt), belgrade)).toEqual({
      year: 2026,
      month: 11,
    });
  });
});
