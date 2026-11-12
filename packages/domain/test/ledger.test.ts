import { describe, expect, it } from "vitest";

import {
  appendTransaction,
  createIncomePlan,
  createTransaction,
  createTransfer,
  estimateInHomeCurrency,
  expectationFromPlan,
  isTransaction,
  matchInflowToExpectation,
  monthTotals,
  spendByCategory,
  totalsByCurrency,
  transactionFromStatementLine,
  type BankConnector,
  type Transaction,
} from "@mon22r/domain";

const userId = "user";
const belgrade = "Europe/Belgrade";
const november = { year: 2026, month: 11 };

function expense(overrides: Partial<Transaction> & Pick<Transaction, "id" | "amountMinor">): Transaction {
  return createTransaction({
    id: overrides.id,
    userId: overrides.userId ?? userId,
    accountId: overrides.accountId ?? "card",
    kind: "expense",
    amountMinor: overrides.amountMinor,
    currency: overrides.currency ?? "RSD",
    categoryId: overrides.categoryId === undefined ? "food" : overrides.categoryId,
    occurredAt: overrides.occurredAt ?? "2026-11-10T12:00:00.000Z",
    description: overrides.description ?? "",
    importIdentity: overrides.importIdentity ?? null,
  });
}

describe("transfers, refunds, and currencies", () => {
  it("keeps a transfer between own accounts out of income and expense", () => {
    const spent = expense({ id: "coffee", amountMinor: 35_000 });
    const salary = createTransaction({
      id: "salary",
      userId,
      accountId: "card",
      kind: "income",
      amountMinor: 18_000_000,
      currency: "RSD",
      occurredAt: "2026-11-05T12:00:00.000Z",
      description: "зп",
    });
    const [outflow, inflow] = createTransfer({
      userId,
      fromAccountId: "card",
      toAccountId: "cash",
      from: { minor: 500_000, currency: "RSD" },
      to: { minor: 500_000, currency: "RSD" },
      occurredAt: "2026-11-06T12:00:00.000Z",
      description: "на наличные",
      outflowId: "transfer-out",
      inflowId: "transfer-in",
      transferGroupId: "group-1",
    });

    expect(outflow.transferGroupId).toBe(inflow.transferGroupId);
    expect(outflow.kind).toBe("transfer");
    expect(inflow.kind).toBe("transfer");
    expect(outflow.direction).toBe("outflow");
    expect(inflow.direction).toBe("inflow");
    expect(totalsByCurrency([outflow, inflow])).toEqual([]);
    expect(monthTotals([spent, salary, outflow, inflow], november, belgrade)).toEqual([
      { currency: "RSD", incomeMinor: 18_000_000, expenseMinor: 35_000 },
    ]);
  });

  it("reduces the original category spend and does not count a refund as income", () => {
    const spent = expense({ id: "coffee", amountMinor: 100_000, categoryId: "food" });
    const refund = createTransaction({
      id: "refund",
      userId,
      accountId: "card",
      kind: "refund",
      amountMinor: 20_000,
      currency: "RSD",
      categoryId: "food",
      refundOfTransactionId: spent.id,
      occurredAt: "2026-11-11T12:00:00.000Z",
      description: "refund",
    });
    expect(refund.direction).toBe("inflow");
    expect(spendByCategory([spent, refund])).toEqual([
      { categoryId: "food", currency: "RSD", spentMinor: 80_000 },
    ]);
    expect(totalsByCurrency([spent, refund])).toEqual([
      { currency: "RSD", incomeMinor: 0, expenseMinor: 80_000 },
    ]);
  });

  it("keeps currencies apart and drops activity outside the Belgrade month", () => {
    const rsd = expense({ id: "rsd", amountMinor: 100, currency: "RSD" });
    const gbp = expense({ id: "gbp", amountMinor: 450, currency: "GBP", accountId: "uk" });
    const previousMonth = expense({
      id: "late-october",
      amountMinor: 9_999,
      occurredAt: "2026-10-31T22:00:00.000Z",
    });
    expect(totalsByCurrency([rsd, gbp])).toEqual([
      { currency: "GBP", incomeMinor: 0, expenseMinor: 450 },
      { currency: "RSD", incomeMinor: 0, expenseMinor: 100 },
    ]);
    expect(monthTotals([rsd, previousMonth], november, belgrade)).toEqual([
      { currency: "RSD", incomeMinor: 0, expenseMinor: 100 },
    ]);
  });
});

describe("income expectations", () => {
  it("matches a similar inflow without turning the plan into a transaction", () => {
    const plan = createIncomePlan({
      id: "plan-salary",
      userId,
      name: "зп",
      amountMinor: 100_000,
      currency: "RSD",
      dayOfMonth: 31,
      accountId: "card",
      recurrence: "monthly",
      startYear: 2026,
      startMonth: 2,
      remind: false,
      active: true,
    });
    const february = expectationFromPlan(plan, { year: 2026, month: 2 }, "exp-feb");
    const novemberExpectation = expectationFromPlan(plan, november, "exp-nov");
    expect(february?.dayOfMonth).toBe(28);
    expect(novemberExpectation).toMatchObject({
      status: "expected",
      receivedMinor: 0,
      matchedTransactionId: null,
      planId: plan.id,
    });
    expect(isTransaction(plan)).toBe(false);
    expect(isTransaction(novemberExpectation)).toBe(false);

    const transactions: Transaction[] = [];
    const inflow = createTransaction({
      id: "pay-1",
      userId,
      accountId: "card",
      kind: "income",
      amountMinor: 100_000,
      currency: "RSD",
      occurredAt: "2026-11-05T09:00:00.000Z",
      description: "зп",
    });
    transactions.push(inflow);
    const frozen = Object.freeze({ ...novemberExpectation! });
    const match = matchInflowToExpectation([frozen], {
      id: inflow.id,
      userId: inflow.userId,
      amountMinor: inflow.amountMinor,
      currency: inflow.currency,
      accountId: inflow.accountId,
    });

    expect(match?.status).toBe("received");
    expect(match?.expectation.matchedTransactionId).toBe(inflow.id);
    expect(match?.expectation.receivedMinor).toBe(100_000);
    expect(frozen.status).toBe("expected");
    expect(transactions.map((transaction) => transaction.id)).toEqual(["pay-1"]);
    expect(isTransaction(match?.expectation)).toBe(false);
  });

  it("marks a short similar amount as partial and ignores an amount that is not similar", () => {
    const expectation = expectationFromPlan(
      createIncomePlan({
        id: "plan",
        userId,
        name: "зп",
        amountMinor: 100_000,
        currency: "RSD",
        dayOfMonth: 5,
        accountId: null,
        recurrence: "once",
        startYear: 2026,
        startMonth: 11,
      }),
      november,
      "exp",
    );
    expect(expectation).not.toBeNull();
    const partial = matchInflowToExpectation([expectation!], {
      id: "pay-short",
      userId,
      amountMinor: 90_000,
      currency: "RSD",
      accountId: "card",
    });
    const unrelated = matchInflowToExpectation([expectation!], {
      id: "pay-other",
      userId,
      amountMinor: 50_000,
      currency: "RSD",
      accountId: "card",
    });
    expect(partial?.status).toBe("partial");
    expect(partial?.expectation.receivedMinor).toBe(90_000);
    expect(unrelated).toBeNull();
    expect(expectationFromPlan(
      createIncomePlan({
        id: "once",
        userId,
        name: "bonus",
        amountMinor: 100,
        currency: "RSD",
        dayOfMonth: 1,
        recurrence: "once",
        startYear: 2026,
        startMonth: 11,
      }),
      { year: 2026, month: 12 },
      "later",
    )).toBeNull();
  });
});

describe("statement identity", () => {
  it("does not append a second transaction for the same external key", () => {
    const line = {
      externalKey: "line-1",
      bookedAt: "2026-11-03T10:00:00.000Z",
      amountMinor: 120_050,
      currency: "RSD" as const,
      direction: "outflow" as const,
      description: "shop",
    };
    const first = transactionFromStatementLine({
      id: "tx-1",
      userId,
      accountId: "card",
      source: "tbank-csv",
      line,
    });
    const repeated = transactionFromStatementLine({
      id: "tx-2",
      userId,
      accountId: "card",
      source: "tbank-csv",
      line: { ...line, amountMinor: 1 },
    });
    const created = appendTransaction([], first);
    const again = appendTransaction(created.transactions, repeated);
    expect(created.status).toBe("created");
    expect(again.status).toBe("duplicate");
    expect(again.transactions).toHaveLength(1);
    expect(again.transaction.id).toBe("tx-1");
    expect(again.transaction.amountMinor).toBe(120_050);

    const otherUser = transactionFromStatementLine({
      id: "tx-3",
      userId: "other",
      accountId: "card",
      source: "tbank-csv",
      line,
    });
    const otherSource = transactionFromStatementLine({
      id: "tx-4",
      userId,
      accountId: "card",
      source: "alfa-xlsx",
      line,
    });
    expect(appendTransaction(again.transactions, otherUser).status).toBe("created");
    expect(appendTransaction(again.transactions, otherSource).status).toBe("created");
  });
});

describe("home currency estimate", () => {
  it("returns an estimate and leaves the stored amount unchanged", () => {
    const stored = Object.freeze(
      expense({ id: "stored", amountMinor: 35_050, currency: "RSD" }),
    );
    const estimate = estimateInHomeCurrency({
      parts: [{ minor: stored.amountMinor, currency: stored.currency }],
      homeCurrency: "EUR",
      rates: [
        {
          baseCurrency: "EUR",
          quoteCurrency: "RSD",
          numerator: 11_720,
          denominator: 100,
          asOf: "2026-11-10",
          source: "ecb",
        },
      ],
    });
    expect(stored.amountMinor).toBe(35_050);
    expect(estimate).toEqual({
      kind: "estimate",
      minor: 299,
      currency: "EUR",
      asOf: "2026-11-10",
      source: "ecb",
      usedConversion: true,
    });
  });
});

describe("BankConnector", () => {
  it("is a consent, account, and pull port with no stored password", () => {
    const connector: BankConnector = {
      async beginConsent() {
        return {
          consentId: "consent",
          authorizationUrl: "https://bank.example/consent",
          expiresAt: "2026-11-12T00:00:00.000Z",
        };
      },
      async listAccounts() {
        return [{ externalAccountId: "ext", name: "UK", currency: "GBP", mask: "1234" }];
      },
      async pullSince() {
        return [
          {
            externalKey: "line-1",
            bookedAt: "2026-11-01",
            amountMinor: 450,
            currency: "GBP",
            direction: "outflow",
            description: "coffee",
          },
        ];
      },
    };
    expect(Object.keys(connector).sort()).toEqual(["beginConsent", "listAccounts", "pullSince"]);
  });
});
