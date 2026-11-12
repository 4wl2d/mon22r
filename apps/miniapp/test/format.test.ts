import { describe, expect, it } from "vitest";

import {
  addMonths,
  compareMonths,
  currentMonth,
  dayKey,
  formatAmount,
  formatDateTime,
  formatDayHeading,
  formatMinor,
  formatMinorInput,
  formatMonthTitle,
  formatShare,
  formatSigned,
  formatSignedAmount,
  formatUtcOffset,
  monthKey,
  parseMinorInput,
  plural,
  sameMonth,
} from "../src/format.js";

const SPACE = " ";

describe("mini app formatting", () => {
  it("shows minor units as grouped major units and never changes the stored number", () => {
    expect(formatMinor(18_000_050, "RSD")).toBe(`180${SPACE}000,50 RSD`);
    expect(formatMinor(-45_000, "EUR")).toBe("−450,00 EUR");
    expect(formatMinor(1200, "JPY")).toBe(`1${SPACE}200 JPY`);
    expect(formatMinor(1234, "KWD")).toBe("1,234 KWD");
    expect(formatAmount(-8_355_850, "RSD")).toBe(`−83${SPACE}558,50`);
    expect(formatSigned(35_000, "RSD", "outflow")).toBe("−350,00 RSD");
    expect(formatSigned(250_000, "EUR", "inflow")).toBe(`+2${SPACE}500,00 EUR`);
  });

  it("reads a typed amount back exactly, and refuses what it cannot read", () => {
    expect(parseMinorInput("180 000,50", "RSD")).toBe(18_000_050);
    expect(parseMinorInput("1.200,5", "EUR")).toBe(120_050);
    expect(parseMinorInput("1,200.50", "GBP")).toBe(120_050);
    expect(parseMinorInput("1200", "JPY")).toBe(1200);
    expect(parseMinorInput("12.5", "JPY")).toBeNull();
    expect(parseMinorInput("12,345", "RSD")).toBe(1_234_500);
    expect(parseMinorInput("12,3456", "RSD")).toBeNull();
    expect(parseMinorInput("-5", "RSD")).toBeNull();
    expect(parseMinorInput("abc", "RSD")).toBeNull();
    expect(parseMinorInput("", "RSD")).toBeNull();
    // What the editor shows is what it reads back.
    for (const minor of [1, 99, 100, 18_000_050, 999_999_999]) {
      expect(parseMinorInput(formatMinorInput(minor, "RSD"), "RSD")).toBe(minor);
    }
  });

  it("moves between months across year ends and compares them", () => {
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 11 }, -14)).toEqual({ year: 2025, month: 9 });
    expect(monthKey({ year: 2026, month: 3 })).toBe("2026-03");
    expect(formatMonthTitle({ year: 2026, month: 11 })).toBe("Ноябрь 2026");
    expect(sameMonth({ year: 2026, month: 11 }, { year: 2026, month: 11 })).toBe(true);
    expect(compareMonths({ year: 2026, month: 12 }, { year: 2027, month: 1 })).toBeLessThan(0);
  });

  it("uses the ledger's time zone for the current month and for day boundaries", () => {
    const lateEvening = new Date("2026-11-30T23:30:00.000Z");
    expect(currentMonth("Europe/Belgrade", lateEvening)).toEqual({ year: 2026, month: 12 });
    expect(currentMonth("UTC", lateEvening)).toEqual({ year: 2026, month: 11 });
    expect(dayKey("2026-11-30T23:30:00.000Z", "Europe/Belgrade")).toBe("2026-12-01");
    expect(currentMonth("Not/AZone", lateEvening)).toEqual({ year: 2026, month: 11 });
  });

  it("signs a result by its value and leaves zero unsigned", () => {
    expect(formatSignedAmount(250_000, "EUR")).toBe(`+2${SPACE}500,00`);
    expect(formatSignedAmount(-8_355_850, "RSD")).toBe(`−83${SPACE}558,50`);
    expect(formatSignedAmount(0, "EUR")).toBe("0,00");
  });

  it("names a day relative to today in the ledger's time zone, not the device's", () => {
    const now = new Date("2026-11-12T10:00:00.000Z");
    expect(formatDayHeading("2026-11-12T08:00:00.000Z", "Europe/Belgrade", now)).toBe("Сегодня, 12 ноября");
    expect(formatDayHeading("2026-11-11T08:00:00.000Z", "Europe/Belgrade", now)).toBe("Вчера, 11 ноября");
    expect(formatDayHeading("2026-11-10T08:00:00.000Z", "Europe/Belgrade", now)).toBe("10 ноября, вт");
    // 23:30 UTC on the 11th is already the 12th in Belgrade, so it belongs to today there.
    expect(formatDayHeading("2026-11-11T23:30:00.000Z", "Europe/Belgrade", now)).toBe("Сегодня, 12 ноября");
    expect(formatDayHeading("2026-11-11T23:30:00.000Z", "UTC", now)).toBe("Вчера, 11 ноября");
    expect(formatDateTime("2026-11-10T11:14:00.000Z", "Europe/Belgrade")).toBe("10 ноября, 12:14");
    expect(formatUtcOffset("Europe/Belgrade", now)).toBe("UTC+1");
  });

  it("picks the Russian plural form and rounds shares without hiding a sliver", () => {
    const forms = (count: number) => plural(count, "запись", "записи", "записей");
    expect([1, 2, 5, 11, 12, 21, 22, 25, 101, 111].map(forms)).toEqual([
      "запись",
      "записи",
      "записей",
      "записей",
      "записей",
      "запись",
      "записи",
      "записей",
      "запись",
      "записей",
    ]);
    expect(formatShare(6_500_000, 8_355_850)).toBe("78%");
    expect(formatShare(1, 8_355_850)).toBe("<1%");
    expect(formatShare(-500, 8_355_850)).toBe("");
    expect(formatShare(500, 0)).toBe("");
  });
});
