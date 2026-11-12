import {
  createAccount,
  createUser,
  findTransactionByImportKey,
  listTransactions,
  type Mon22rDb,
  migrate,
  openDatabase,
  recordTransaction,
} from "@mon22r/db";
import { isTransaction } from "@mon22r/domain";
import { type CsvMapping, commitStatementLines, headerFingerprint, parseCsvTable, previewCsv } from "@mon22r/importers";
import { afterEach, describe, expect, it } from "vitest";

const open: Mon22rDb[] = [];

function database(): Mon22rDb {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open) db.close();
  open.length = 0;
});

const sample = `Date,Description,Amount,Currency,Id
2026-11-01,opening balance,1000.00,RSD,bal-open
2026-11-02,coffee,-350.00,RSD,row-coffee
2026-11-03,salary,180000.00,RSD,row-salary
2026-11-04,closing balance,5000.00,RSD,bal-close
2026-11-05,cashback points,15,RSD,points
2026-11-02,coffee,-350.00,RSD,row-coffee
`;

const mapping: CsvMapping = {
  date: "Date",
  description: "Description",
  amount: "Amount",
  currency: "Currency",
  externalKey: "Id",
};

describe("csv preview", () => {
  it("asks for a mapping when the header has no saved profile shape yet", () => {
    const table = parseCsvTable("A,B,C\n1,2,3\n");
    expect(table.headers).toEqual(["A", "B", "C"]);
    expect(headerFingerprint(table.headers)).toBe("a|b|c");
    expect(headerFingerprint([" Date ", "Amount"])).toBe(headerFingerprint(["date", "amount"]));
  });

  it("classifies new, duplicate, and skipped rows without a second dedupe table", () => {
    const db = database();
    const user = createUser(db, { id: "user-a", homeCurrency: "RSD", timeZone: "Europe/Belgrade" });
    const account = createAccount(db, user.id, { id: "acct", name: "Поштанска", currency: "RSD" });
    const isDuplicate = (externalKey: string) =>
      findTransactionByImportKey(db, user.id, "sample", externalKey) !== null;
    const first = previewCsv({ csv: sample, mapping, isDuplicate });
    expect(first.counts).toEqual({ new: 2, duplicate: 1, skipped: 3 });
    expect(first.rows.filter((row) => row.reason === "opening_balance")).toHaveLength(1);
    expect(first.rows.filter((row) => row.reason === "closing_balance")).toHaveLength(1);
    expect(first.rows.filter((row) => row.reason === "cashback_points")).toHaveLength(1);
    const coffee = first.rows.find((row) => row.line?.externalKey === "row-coffee" && row.status === "new");
    expect(coffee?.line).toMatchObject({
      amountMinor: 35_000,
      currency: "RSD",
      direction: "outflow",
      description: "coffee",
    });
    expect(isTransaction(coffee?.line)).toBe(false);

    const lines = first.rows.flatMap((row) => (row.line === null ? [] : [row.line]));
    const commit = (rows: typeof lines) =>
      commitStatementLines({
        userId: user.id,
        accountId: account.id,
        source: "sample",
        timeZone: "Europe/Belgrade",
        lines: rows,
        now: new Date("2026-11-12T10:00:00.000Z"),
        record: (row) => recordTransaction(db, user.id, row),
      });
    const written = commit(lines);
    expect(written.created).toBe(2);
    expect(written.duplicate).toBe(1);
    expect(written.transactions.map((transaction) => transaction.kind).sort()).toEqual(["expense", "income"]);
    expect(findTransactionByImportKey(db, user.id, "sample", "row-coffee")).toMatchObject({
      amountMinor: 35_000,
      kind: "expense",
      occurredAt: "2026-11-01T23:00:00.000Z",
    });
    expect(listTransactions(db, user.id)).toHaveLength(2);

    const again = commit(lines);
    expect(again.created).toBe(0);
    expect(again.duplicate).toBe(3);
    expect(listTransactions(db, user.id)).toHaveLength(2);
    const repeated = previewCsv({ csv: sample, mapping, isDuplicate });
    expect(repeated.counts).toEqual({ new: 0, duplicate: 3, skipped: 3 });
  });

  it("reimports a file with no id column as nothing new", () => {
    const db = database();
    const user = createUser(db, { id: "user-a", homeCurrency: "GBP", timeZone: "Europe/Belgrade" });
    const account = createAccount(db, user.id, { id: "uk", name: "UK", currency: "GBP" });
    const csv = `Date,Description,Amount
02.11.2026,"coffee, shop",-3.50
`;
    const quoted: CsvMapping = { date: "Date", description: "Description", amount: "Amount", fixedCurrency: "GBP" };
    const preview = previewCsv({ csv, mapping: quoted, isDuplicate: () => false });
    expect(preview.rows[0]?.line).toMatchObject({
      bookedAt: "2026-11-02",
      description: "coffee, shop",
      amountMinor: 350,
      currency: "GBP",
      direction: "outflow",
    });
    const lines = preview.rows.flatMap((row) => (row.line === null ? [] : [row.line]));
    const once = commitStatementLines({
      userId: user.id,
      accountId: account.id,
      source: "quoted",
      timeZone: "Europe/Belgrade",
      lines,
      record: (row) => recordTransaction(db, user.id, row),
    });
    const twice = commitStatementLines({
      userId: user.id,
      accountId: account.id,
      source: "quoted",
      timeZone: "Europe/Belgrade",
      lines,
      record: (row) => recordTransaction(db, user.id, row),
    });
    expect(once.created).toBe(1);
    expect(twice.created).toBe(0);
    expect(listTransactions(db, user.id)).toHaveLength(1);
  });
});
