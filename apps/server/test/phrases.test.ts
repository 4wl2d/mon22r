import { isTransaction, parseAmount } from "@mon22r/domain";
import { describe, expect, it } from "vitest";

import { entryHtml, entryLine, formatMinor, transferHtml, transferLine } from "../src/format.js";
import { nextCalendarMonth, parsePhrase, shiftLocalDays } from "../src/phrases.js";

const now = new Date("2026-11-12T10:00:00.000Z");
const zone = "Europe/Belgrade";

describe("phrases", () => {
  it("parses the capture phrases with domain amounts", () => {
    expect(parsePhrase("кофе 350", now, zone)).toEqual({
      type: "expense",
      note: "кофе",
      amountMinor: parseAmount("350").minor,
      currency: null,
      occurredAt: "2026-11-12T10:00:00.000Z",
      categoryName: null,
    });
    expect(parsePhrase("кофе 4.50 gbp", now, zone)).toMatchObject({
      type: "expense",
      note: "кофе",
      amountMinor: 450,
      currency: "GBP",
    });
    expect(parsePhrase("+зп 180000", now, zone)).toMatchObject({
      type: "income",
      note: "зп",
      amountMinor: 18_000_000,
      currency: null,
    });
    expect(parsePhrase("возврат кроссовки 5000", now, zone)).toMatchObject({
      type: "refund",
      note: "кроссовки",
      amountMinor: 500_000,
    });

    const plan = parsePhrase("план зп 180000 5", now, zone);
    expect(plan).toMatchObject({
      type: "plan",
      name: "зп",
      amountMinor: 18_000_000,
      currency: null,
      dayOfMonth: 5,
      month: { year: 2026, month: 12 },
    });
    expect(isTransaction(plan)).toBe(false);
  });

  it("reads a category tag anywhere in the line and keeps it out of the note", () => {
    expect(parsePhrase("кофе 350 #еда", now, zone)).toMatchObject({
      note: "кофе",
      amountMinor: 35_000,
      categoryName: "еда",
    });
    expect(parsePhrase("#еда_вне_дома обед 1200 rsd", now, zone)).toMatchObject({
      note: "обед",
      currency: "RSD",
      categoryName: "еда вне дома",
    });
    expect(parsePhrase("#еда", now, zone)).toBeNull();
  });

  it("understands currency words and symbols but not ordinary three-letter words", () => {
    expect(parsePhrase("кофе 350 дин", now, zone)).toMatchObject({ note: "кофе", currency: "RSD" });
    expect(parsePhrase("обед 12 евро", now, zone)).toMatchObject({ note: "обед", currency: "EUR", amountMinor: 1200 });
    expect(parsePhrase("обед €12,50", now, zone)).toMatchObject({ note: "обед", currency: "EUR", amountMinor: 1250 });
    expect(parsePhrase("книга $20", now, zone)).toMatchObject({ note: "книга", currency: "USD" });
    expect(parsePhrase("такси 1200р", now, zone)).toMatchObject({ note: "такси", currency: "RUB" });
    // `bus` is not a currency, so it stays in the note and the amount is bare.
    expect(parsePhrase("city bus 150", now, zone)).toMatchObject({
      note: "city bus",
      currency: null,
      amountMinor: 15_000,
    });
    expect(parsePhrase("кофе 5 xyz", now, zone)).toBeNull();
  });

  it("takes the decimal places of a bare amount from the currency it will be booked in", () => {
    expect(parsePhrase("суши 1200", now, zone, "JPY")).toMatchObject({ amountMinor: 1200, currency: null });
    expect(parsePhrase("суши 12.5", now, zone, "JPY")).toBeNull();
    expect(parsePhrase("суши 1200", now, zone, "RSD")).toMatchObject({ amountMinor: 120_000 });
  });

  it("dates an entry with a word or a calendar day, never in the future", () => {
    expect(parsePhrase("вчера такси 1200", now, zone)).toMatchObject({
      note: "такси",
      occurredAt: "2026-11-11T10:00:00.000Z",
    });
    expect(parsePhrase("5.11 такси 1200", now, zone)).toMatchObject({
      note: "такси",
      occurredAt: "2026-11-05T10:00:00.000Z",
    });
    expect(parsePhrase("05.11.2025 такси 1200", now, zone)).toMatchObject({ occurredAt: "2025-11-05T10:00:00.000Z" });
    // December has not come yet this year, so the day belongs to last December.
    expect(parsePhrase("24.12 подарки 9000", now, zone)).toMatchObject({ occurredAt: "2025-12-24T10:00:00.000Z" });
    expect(parsePhrase("31.02 такси 1200", now, zone)).toBeNull();
    expect(parsePhrase("13.11.2026 такси 1200", now, zone)).toBeNull();
    // A one-digit "month" is a quantity, not a date.
    expect(parsePhrase("1.5 литра молока 200", now, zone)).toMatchObject({
      note: "1.5 литра молока",
      occurredAt: "2026-11-12T10:00:00.000Z",
    });
  });

  it("reads transfers with an optional source and an optional arrival amount", () => {
    const simple = parsePhrase("перевод 5000 на наличные", now, zone);
    expect(simple).toEqual({
      type: "transfer",
      amountMinor: 500_000,
      currency: null,
      sourceName: null,
      destinationText: "наличные",
      occurredAt: "2026-11-12T10:00:00.000Z",
    });
    expect(isTransaction(simple)).toBe(false);
    expect(parsePhrase("перевод 500 eur с евро на карта 58600", now, zone)).toMatchObject({
      amountMinor: 50_000,
      currency: "EUR",
      sourceName: "евро",
      destinationText: "карта 58600",
    });
    expect(parsePhrase("перевод на наличные", now, zone)).toBeNull();
  });

  it("uses the next calendar month in the user time zone", () => {
    expect(nextCalendarMonth(now, zone)).toEqual({ year: 2026, month: 12 });
    const newYear = new Date("2026-11-30T23:30:00.000Z");
    expect(nextCalendarMonth(newYear, zone)).toEqual({ year: 2027, month: 1 });
    expect(shiftLocalDays(newYear, zone, -1)).toBe("2026-11-29T23:30:00.000Z");
    expect(parsePhrase("план зп 180000 5", newYear, zone)).toMatchObject({ month: { year: 2027, month: 1 } });
  });

  it("formats confirmations with grouped thousands and no empty fraction", () => {
    expect(formatMinor(35_000, "RSD")).toBe("350");
    expect(formatMinor(18_000_050, "RSD")).toBe("180\u00A0000,50");
    expect(formatMinor(1200, "JPY")).toBe("1\u00A0200");
    const coffee = { kind: "expense", amountMinor: 35_000, currency: "RSD", description: "кофе" } as const;
    // The amount carries its direction; an expense or refund without a category says so.
    expect(entryHtml(coffee, "Поштанска", null)).toBe("<b>−350\u00A0RSD</b> · кофе\nПоштанска · без категории");
    expect(entryLine(coffee, "Поштанска", null)).toBe("−350\u00A0RSD · кофе · Поштанска");
    const salary = { kind: "income", amountMinor: 18_000_000, currency: "RSD", description: "зп" } as const;
    expect(entryHtml(salary, "Поштанска", null)).toBe("<b>+180\u00A0000\u00A0RSD</b> · зп\nПоштанска");
    const refund = { kind: "refund", amountMinor: 450, currency: "GBP", description: "кофе" } as const;
    expect(entryHtml(refund, "UK", "Еда")).toBe("<b>+4,50\u00A0GBP</b> · кофе\nUK · возврат · Еда");
    expect(entryLine(refund, "UK", "Еда")).toBe("+4,50\u00A0GBP · кофе · UK · возврат · Еда");
    const euros = { amountMinor: 50_000, currency: "EUR" };
    const dinars = { amountMinor: 5_860_000, currency: "RSD" };
    expect(transferHtml(euros, dinars, "Евро", "Карта")).toBe(
      "<b>500\u00A0EUR → 58\u00A0600\u00A0RSD</b> · перевод\nЕвро → Карта",
    );
    const same = { amountMinor: 500_000, currency: "RSD" };
    expect(transferHtml(same, same, "Карта", "Наличные")).toBe(
      "<b>5\u00A0000\u00A0RSD</b> · перевод\nКарта → Наличные",
    );
    expect(transferLine(same, same, "Карта", "Наличные")).toBe("перевод 5\u00A0000\u00A0RSD · Карта → Наличные");
  });

  it("escapes names and notes in every chat line", () => {
    const entry = { kind: "expense", amountMinor: 100, currency: "RSD", description: "<i>a</i> & b" } as const;
    expect(entryHtml(entry, "A<B", "C>D")).toBe("<b>−1\u00A0RSD</b> · &lt;i&gt;a&lt;/i&gt; &amp; b\nA&lt;B · C&gt;D");
    expect(entryLine(entry, "A<B", null)).toBe("−1\u00A0RSD · &lt;i&gt;a&lt;/i&gt; &amp; b · A&lt;B");
    const amount = { amountMinor: 100, currency: "RSD" };
    expect(transferHtml(amount, amount, "A<B", "C&D")).toBe("<b>1\u00A0RSD</b> · перевод\nA&lt;B → C&amp;D");
    expect(transferLine(amount, amount, "A<B", "C&D")).toBe("перевод 1\u00A0RSD · A&lt;B → C&amp;D");
  });
});
