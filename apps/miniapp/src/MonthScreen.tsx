import type {
  CategorySpend,
  CurrencyTotals,
  ExpectationStatus,
  HomeCurrencyEstimate,
  IncomeExpectation,
  IncomePlan,
} from "@mon22r/domain";
import { useState } from "react";

import type { Ledger } from "./App";
import { errorText, getMonth, type MonthView, updateExpectationStatus, updatePlan } from "./api";
import {
  compareMonths,
  formatAmount,
  formatMinor,
  formatMinorInput,
  formatRateDate,
  type MonthPoint,
  monthKey,
  parseMinorInput,
} from "./format";
import { invalidate, useQuery } from "./store";
import { hapticError, hapticSuccess, openExternal } from "./telegram";
import { accountLabel, ConfirmButton, categoryLabel, InlineEdit, MonthSwitcher, Notice, Skeleton } from "./ui";

const STATUS_LABEL: Record<ExpectationStatus, string> = {
  expected: "ожидается",
  received: "пришло",
  partial: "пришло частично",
  skipped: "не будет",
};

const STATUSES = ["expected", "received", "partial", "skipped"] as const;

export function MonthScreen({
  ledger,
  point,
  today,
  onMonth,
  onOpenCategory,
}: {
  ledger: Ledger;
  point: MonthPoint;
  today: MonthPoint;
  onMonth: (point: MonthPoint) => void;
  onOpenCategory: (categoryId: string | null) => void;
}) {
  const key = monthKey(point);
  const query = useQuery(`month:${key}`, () => getMonth(key), "Не удалось загрузить месяц.");
  const view = query.data;

  return (
    <section>
      <MonthSwitcher point={point} today={today} busy={query.loading} onChange={onMonth} />
      {view === undefined && query.error === null ? <Skeleton lines={7} /> : null}
      {query.error !== null ? (
        <Notice tone="problem" text={query.error} action={{ label: "Повторить", onClick: query.reload }} />
      ) : null}
      {view !== undefined ? (
        <>
          <Totals
            view={view}
            ledger={ledger}
            future={compareMonths(point, today) > 0}
            onOpenCategory={onOpenCategory}
          />
          <Expected
            view={view}
            ledger={ledger}
            upcoming={compareMonths(point, today) >= 0}
            onChanged={() => invalidate("month:")}
            onView={(next) => query.update(next)}
          />
        </>
      ) : null}
    </section>
  );
}

function Totals({
  view,
  ledger,
  future,
  onOpenCategory,
}: {
  view: MonthView;
  ledger: Ledger;
  future: boolean;
  onOpenCategory: (categoryId: string | null) => void;
}) {
  const currencies = view.totalsByCurrency.map((row) => row.currency);
  if (currencies.length === 0) {
    return (
      <Notice
        text={future ? "Этот месяц ещё не начался." : "В этом месяце записей нет. Напишите боту, например: кофе 350"}
      />
    );
  }
  return (
    <>
      {view.estimateInHomeCurrency?.usedConversion ? <Estimate estimate={view.estimateInHomeCurrency} /> : null}
      {currencies.map((currency) => (
        <CurrencyBlock
          key={currency}
          currency={currency}
          totals={view.totalsByCurrency.find((row) => row.currency === currency) ?? null}
          spend={view.categorySpend.filter((row) => row.currency === currency)}
          ledger={ledger}
          onOpenCategory={onOpenCategory}
        />
      ))}
    </>
  );
}

/** The month in one number. It is an estimate at today's rate, and is labeled as one. */
function Estimate({ estimate }: { estimate: HomeCurrencyEstimate }) {
  return (
    <div className="headline">
      <p className="headline-number">
        {formatAmount(estimate.minor, estimate.currency)}
        <span className="headline-code">{estimate.currency}</span>
      </p>
      <p className="caption">
        итог месяца во всех валютах, оценка
        {estimate.asOf ? ` по курсу на ${formatRateDate(estimate.asOf)}` : ""}
        {" · "}
        <button type="button" className="link" onClick={() => openExternal("https://www.exchangerate-api.com")}>
          Rates By Exchange Rate API
        </button>
      </p>
    </div>
  );
}

function CurrencyBlock({
  currency,
  totals,
  spend,
  ledger,
  onOpenCategory,
}: {
  currency: string;
  totals: CurrencyTotals | null;
  spend: readonly CategorySpend[];
  ledger: Ledger;
  onOpenCategory: (categoryId: string | null) => void;
}) {
  const rows = [...spend]
    .filter((row) => row.spentMinor !== 0)
    .sort((left, right) => right.spentMinor - left.spentMinor);
  const peak = rows.reduce((max, row) => Math.max(max, row.spentMinor), 0);
  return (
    <section className="currency-block">
      <h2 className="currency">{currency}</h2>
      {totals ? (
        <dl className="totals">
          <div>
            <dt>ушло</dt>
            <dd>{formatAmount(totals.expenseMinor, currency)}</dd>
          </div>
          <div>
            <dt>пришло</dt>
            <dd>{formatAmount(totals.incomeMinor, currency)}</dd>
          </div>
          <div className="total-net">
            <dt>остаток</dt>
            <dd>{formatAmount(totals.incomeMinor - totals.expenseMinor, currency)}</dd>
          </div>
        </dl>
      ) : null}
      {rows.length > 0 ? (
        <ul className="categories">
          {rows.map((row) => {
            const width = peak > 0 && row.spentMinor > 0 ? (row.spentMinor / peak) * 100 : 0;
            return (
              <li key={row.categoryId ?? "none"}>
                <button type="button" className="category" onClick={() => onOpenCategory(row.categoryId)}>
                  <span className={row.categoryId === null ? "category-name todo" : "category-name"}>
                    {categoryLabel(ledger.categories, row.categoryId)}
                  </span>
                  <span>{formatAmount(row.spentMinor, currency)}</span>
                  <span className="track" aria-hidden="true">
                    <span style={{ width: `${width}%` }} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function Expected({
  view,
  ledger,
  upcoming,
  onChanged,
  onView,
}: {
  view: MonthView;
  ledger: Ledger;
  upcoming: boolean;
  onChanged: () => void;
  onView: (next: (current: MonthView) => MonthView) => void;
}) {
  if (view.expectations.length === 0) {
    if (!upcoming) return null;
    return (
      <section className="panel">
        <h2>Ожидается</h2>
        <p className="muted">Ожидаемых поступлений нет. Добавить можно в чате: план зп 180000 5</p>
      </section>
    );
  }
  return (
    <section className="panel">
      <h2>Ожидается</h2>
      {view.expectations.map((expectation) => (
        <ExpectedLine
          key={expectation.id}
          expectation={expectation}
          plan={view.plans.find((plan) => plan.id === expectation.planId) ?? null}
          ledger={ledger}
          onExpectation={(next) =>
            onView((current) => ({
              ...current,
              expectations: current.expectations.map((item) => (item.id === next.id ? next : item)),
            }))
          }
          onChanged={onChanged}
        />
      ))}
    </section>
  );
}

function ExpectedLine({
  expectation,
  plan,
  ledger,
  onExpectation,
  onChanged,
}: {
  expectation: IncomeExpectation;
  plan: IncomePlan | null;
  ledger: Ledger;
  onExpectation: (expectation: IncomeExpectation) => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const open = expectation.status === "expected" && expectation.receivedMinor === 0;

  async function changeStatus(status: ExpectationStatus) {
    if (status === expectation.status) return;
    setSaving(true);
    setError("");
    try {
      onExpectation(await updateExpectationStatus(expectation.id, status));
      hapticSuccess();
    } catch (caught) {
      hapticError();
      setError(errorText(caught, "Не удалось сохранить статус."));
    } finally {
      setSaving(false);
    }
  }

  async function saveAmount(text: string): Promise<string | null> {
    if (plan === null) return null;
    const minor = parseMinorInput(text, plan.currency);
    if (minor === null) return "Сумма не читается.";
    if (minor <= 0) return "Сумма должна быть больше нуля.";
    try {
      await updatePlan(plan.id, { amountMinor: minor, currency: plan.currency });
      hapticSuccess();
      // Open lines of this plan follow the new amount in every month, so every cached month is outdated.
      onChanged();
      return null;
    } catch (caught) {
      hapticError();
      return errorText(caught, "Не удалось сохранить сумму.");
    }
  }

  async function stop() {
    if (plan === null) return;
    setSaving(true);
    setError("");
    try {
      await updatePlan(plan.id, { active: false });
      hapticSuccess();
      onChanged();
    } catch (caught) {
      hapticError();
      setError(errorText(caught, "Не удалось убрать план."));
    } finally {
      setSaving(false);
    }
  }

  const meta = [`${expectation.dayOfMonth}-го`, accountLabel(ledger.accounts, expectation.accountId)];
  if (plan?.recurrence === "monthly") meta.push("каждый месяц");

  return (
    <article className={expectation.status === "skipped" ? "line quiet" : "line"}>
      <div className="line-top">
        <h3>{expectation.name}</h3>
        {plan !== null && open ? (
          <InlineEdit
            value={formatMinorInput(expectation.expectedMinor, expectation.currency)}
            display={formatMinor(expectation.expectedMinor, expectation.currency)}
            label="Сумма"
            inputMode="decimal"
            maxLength={20}
            save={saveAmount}
          />
        ) : (
          <span>{formatMinor(expectation.expectedMinor, expectation.currency)}</span>
        )}
      </div>
      <p className="meta">{meta.join(" · ")}</p>
      {expectation.receivedMinor > 0 && expectation.status !== "received" ? (
        <p className="meta">получено {formatMinor(expectation.receivedMinor, expectation.currency)}</p>
      ) : null}
      <div className="line-actions">
        <label className="compact">
          <span className="visually-hidden">Статус</span>
          <select
            value={expectation.status}
            disabled={saving}
            onChange={(event) => void changeStatus(readStatus(event.target.value))}
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </label>
        {plan !== null ? (
          <ConfirmButton
            label="больше не ждать"
            confirmLabel="убрать из следующих месяцев"
            disabled={saving}
            onConfirm={() => void stop()}
          />
        ) : null}
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function readStatus(value: string): ExpectationStatus {
  if (value === "received" || value === "partial" || value === "skipped") return value;
  return "expected";
}
