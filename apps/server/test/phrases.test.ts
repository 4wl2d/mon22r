import { isTransaction, parseAmount } from "@mon22r/domain";
import { describe, expect, it } from "vitest";

import { formatEntry } from "../src/format.js";
import { nextCalendarMonth, parsePhrase, rememberedCategoryId, shiftLocalDays } from "../src/phrases.js";

const now = new Date("2026-11-12T10:00:00.000Z");
const zone = "Europe/Belgrade";

describe("phrases", () => {
  it("parses the capture phrases with domain amounts", () => {
    const coffee = parsePhrase("кофе 350", now, zone);
    expect(coffee).toMatchObject({
      type: "expense",
      note: "кофе",
      amountMinor: parseAmount("350").minor,
      currency: null,
      occurredAt: "2026-11-12T10:00:00.000Z",
    });

    const pounds = parsePhrase("кофе 4.50 gbp", now, zone);
    const parsedPounds = parseAmount("4.50 gbp");
    expect(pounds).toMatchObject({
      type: "expense",
      note: "кофе",
      amountMinor: parsedPounds.minor,
      currency: parsedPounds.currency,
    });

    const income = parsePhrase("+зп 180000", now, zone);
    expect(income).toMatchObject({
      type: "income",
      note: "зп",
      amountMinor: parseAmount("180000").minor,
      currency: null,
    });

    const plan = parsePhrase("план зп 180000 5", now, zone);
    expect(plan).toMatchObject({
      type: "plan",
      name: "зп",
      amountMinor: parseAmount("180000").minor,
      currency: null,
      dayOfMonth: 5,
      month: { year: 2026, month: 12 },
    });
    expect(isTransaction(plan)).toBe(false);

    const yesterday = parsePhrase("вчера такси 1200", now, zone);
    expect(yesterday).toMatchObject({
      type: "expense",
      note: "такси",
      amountMinor: parseAmount("1200").minor,
      occurredAt: "2026-11-11T10:00:00.000Z",
    });

    const transfer = parsePhrase("перевод 5000 на наличные", now, zone);
    expect(transfer).toMatchObject({
      type: "transfer",
      amountMinor: parseAmount("5000").minor,
      currency: null,
      destinationName: "наличные",
    });
    expect(isTransaction(transfer)).toBe(false);
  });

  it("uses the next calendar month in the user time zone", () => {
    expect(nextCalendarMonth(now, zone)).toEqual({ year: 2026, month: 12 });
    const newYear = new Date("2026-11-30T23:30:00.000Z");
    expect(nextCalendarMonth(newYear, zone)).toEqual({ year: 2027, month: 1 });
    expect(shiftLocalDays(newYear, zone, -1)).toBe("2026-11-29T23:30:00.000Z");
    expect(parsePhrase("план зп 180000 5", newYear, zone)).toMatchObject({ month: { year: 2027, month: 1 } });
  });

  it("remembers the latest category chosen for the same note", () => {
    const history = [
      { id: "old", description: "Кофе", categoryId: "food", createdAt: "2026-11-01T00:00:00.000Z" },
      { id: "blank", description: "кофе", categoryId: null, createdAt: "2026-11-02T00:00:00.000Z" },
      { id: "new", description: "кофе", categoryId: "cafe", createdAt: "2026-11-03T00:00:00.000Z" },
    ];
    expect(rememberedCategoryId("кофе", history)).toBe("cafe");
    expect(rememberedCategoryId("такси", history)).toBeNull();
  });

  it("formats the short confirmation line", () => {
    expect(formatEntry(parseAmount("350").minor, "RSD", "кофе", "Поштанска")).toBe("350 RSD · кофе · Поштанска");
    expect(formatEntry(parseAmount("4.50 gbp").minor, "GBP", "кофе", "UK")).toBe("4.50 GBP · кофе · UK");
    expect(formatEntry(parseAmount("180000").minor, "RSD", "зп", "Поштанска")).toBe("180000 RSD · зп · Поштанска");
  });
});
