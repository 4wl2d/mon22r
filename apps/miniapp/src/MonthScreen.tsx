import type {
  CategorySpend,
  CurrencyTotals,
  ExpectationStatus,
  HomeCurrencyEstimate,
  IncomeExpectation,
  IncomePlan,
} from "@mon22r/domain";
import { type FormEvent, useState } from "react";

import type { Ledger } from "./App";
import { errorText, getMonth, type MonthView, updateExpectationStatus, updatePlan } from "./api";
import {
  compareMonths,
  formatAmount,
  formatMinor,
  formatMinorInput,
  formatRateDate,
  formatShare,
  formatSignedAmount,
  type MonthPoint,
  monthKey,
  parseMinorInput,
} from "./format";
import { invalidate, useQuery } from "./store";
import { canReturnToChat, hapticError, hapticSuccess, openExternal, returnToChat } from "./telegram";
import {
  accountLabel,
  ConfirmButton,
  categoryLabel,
  FieldError,
  Icon,
  MonthSwitcher,
  Notice,
  Sheet,
  Skeleton,
  showToast,
} from "./ui";

const STATUS_LABEL: Record<ExpectationStatus, string> = {
  expected: "ожидается",
  received: "пришло",
  partial: "пришло частично",
  skipped: "не будет",
};

const STATUS_TAG: Record<ExpectationStatus, string> = {
  expected: "tag",
  received: "tag positive",
  partial: "tag accent",
  skipped: "tag",
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
      <header className="topbar">
        <MonthSwitcher point={point} today={today} busy={query.loading} onChange={onMonth} />
      </header>
      <div className="stack">
        {view === undefined && query.error === null ? <Skeleton blocks={[176, 260, 96]} /> : null}
        {query.error !== null ? (
          <Notice tone="problem" text={query.error} action={{ label: "Повторить", onClick: query.reload }} />
        ) : null}
        {view !== undefined ? (
          <>
            <Overview
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
      </div>
    </section>
  );
}

function Overview({
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
  const home = ledger.user.homeCurrency;
  // The home currency first, the rest in the order the server gives them.
  const totals = [...view.totalsByCurrency].sort(
    (left, right) => Number(right.currency === home) - Number(left.currency === home),
  );
  if (totals.length === 0) {
    if (future) return <Notice text="Этот месяц ещё не начался." />;
    return (
      <Notice
        title="Записей пока нет"
        text={
          <>
            Напишите боту в чате, например <span className="example">кофе 350</span>
          </>
        }
        action={canReturnToChat() ? { label: "Перейти в чат", onClick: returnToChat } : undefined}
      />
    );
  }
  const expense = view.expenseInHomeCurrency;
  const income = view.incomeInHomeCurrency;
  const net = view.estimateInHomeCurrency;
  const headline = expense !== null && income !== null && net !== null ? { expense, income, net } : null;
  // With one currency, and that the home one, the headline is exact and already says what the card would.
  const exact = headline !== null && !headline.net.usedConversion;
  return (
    <>
      {headline ? <Headline {...headline} /> : null}
      <section>
        <h2 className="section-label">{exact ? "Категории расходов" : "По валютам"}</h2>
        <div className="stack tight">
          {net === null ? (
            <p className="section-note">Для общего итога в {home} не хватает курса, поэтому суммы только по валютам.</p>
          ) : null}
          {totals.map((row) => (
            <CurrencyCard
              key={row.currency}
              totals={row}
              withTotals={!exact}
              spend={view.categorySpend.filter((item) => item.currency === row.currency)}
              ledger={ledger}
              onOpenCategory={onOpenCategory}
            />
          ))}
        </div>
      </section>
    </>
  );
}

/**
 * The month at a glance: what was spent, what came in, and the difference, in the home currency.
 * With several currencies these are estimates at the day's rate, and are labeled as such.
 */
function Headline({
  expense,
  income,
  net,
}: {
  expense: HomeCurrencyEstimate;
  income: HomeCurrencyEstimate;
  net: HomeCurrencyEstimate;
}) {
  const currency = net.currency;
  return (
    <section className="card hero">
      <h2 className="eyebrow">{net.usedConversion ? `Расходы · оценка в ${currency}` : "Расходы"}</h2>
      <p className="hero-number">
        {formatAmount(expense.minor, currency)}
        <span className="hero-code">{currency}</span>
      </p>
      <dl className="stats">
        <div>
          <dt>Доходы</dt>
          <dd className={income.minor > 0 ? "positive" : undefined}>{formatSignedAmount(income.minor, currency)}</dd>
        </div>
        <div>
          <dt>Итог месяца</dt>
          <dd>{formatSignedAmount(net.minor, currency)}</dd>
        </div>
      </dl>
      {net.usedConversion ? (
        <p className="caption">
          Все валюты пересчитаны{net.asOf ? ` по курсу на ${formatRateDate(net.asOf)}` : ""}
          {" · "}
          <button type="button" className="link" onClick={() => openExternal("https://www.exchangerate-api.com")}>
            Rates By Exchange Rate API
          </button>
        </p>
      ) : null}
    </section>
  );
}

function CurrencyCard({
  totals,
  withTotals,
  spend,
  ledger,
  onOpenCategory,
}: {
  totals: CurrencyTotals;
  withTotals: boolean;
  spend: readonly CategorySpend[];
  ledger: Ledger;
  onOpenCategory: (categoryId: string | null) => void;
}) {
  const currency = totals.currency;
  const rows = [...spend]
    .filter((row) => row.spentMinor !== 0)
    .sort((left, right) => right.spentMinor - left.spentMinor);
  const peak = rows.reduce((max, row) => Math.max(max, row.spentMinor), 0);
  const spent = rows.reduce((sum, row) => sum + Math.max(0, row.spentMinor), 0);
  if (!withTotals && rows.length === 0) {
    return <p className="section-note">В этом месяце расходов нет.</p>;
  }
  return (
    <section className="card">
      {withTotals ? (
        <>
          <div className="currency-head">
            <h3 className="currency-code">{currency}</h3>
            <span className="amount">{formatSignedAmount(totals.incomeMinor - totals.expenseMinor, currency)}</span>
          </div>
          <p className="currency-flows">
            <span>
              расходы <b>{formatAmount(totals.expenseMinor, currency)}</b>
            </span>
            <span>
              доходы <b>{formatAmount(totals.incomeMinor, currency)}</b>
            </span>
          </p>
        </>
      ) : null}
      {rows.length > 0 ? (
        <ul className={withTotals ? "bars" : "bars alone"}>
          {rows.map((row) => {
            const width = peak > 0 && row.spentMinor > 0 ? Math.max(2, (row.spentMinor / peak) * 100) : 0;
            return (
              <li key={row.categoryId ?? "none"}>
                <button
                  type="button"
                  className={row.categoryId === null ? "bar-row todo" : "bar-row"}
                  onClick={() => onOpenCategory(row.categoryId)}
                >
                  <span className="bar-name">{categoryLabel(ledger.categories, row.categoryId)}</span>
                  <span>{formatAmount(row.spentMinor, currency)}</span>
                  <span className="bar-share">{formatShare(row.spentMinor, spent)}</span>
                  <span className="bar-track" aria-hidden="true">
                    <span className="bar-fill" style={{ width: `${width}%` }} />
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
  const [openId, setOpenId] = useState<string | null>(null);
  const open = view.expectations.find((item) => item.id === openId) ?? null;
  if (view.expectations.length === 0 && !upcoming) return null;
  return (
    <section>
      <h2 className="section-label">Ожидаемые доходы</h2>
      {view.expectations.length > 0 ? (
        <div className="card rows">
          {view.expectations.map((expectation) => (
            <button
              key={expectation.id}
              type="button"
              className={expectation.status === "skipped" ? "row quiet" : "row"}
              onClick={() => setOpenId(expectation.id)}
            >
              <span className="row-title">{expectation.name}</span>
              <span className="amount">{formatMinor(expectation.expectedMinor, expectation.currency)}</span>
              <span className="row-meta">
                {expectation.dayOfMonth}-го · {accountLabel(ledger.accounts, expectation.accountId)}
                <span className={STATUS_TAG[expectation.status]}>{STATUS_LABEL[expectation.status]}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <p className="section-note">
        Новый план добавляется в чате: <span className="example">план зп 180000 5</span>
      </p>
      {open ? (
        <ExpectationSheet
          expectation={open}
          plan={view.plans.find((plan) => plan.id === open.planId) ?? null}
          ledger={ledger}
          onClose={() => setOpenId(null)}
          onExpectation={(next) =>
            onView((current) => ({
              ...current,
              expectations: current.expectations.map((item) => (item.id === next.id ? next : item)),
            }))
          }
          onChanged={onChanged}
        />
      ) : null}
    </section>
  );
}

function ExpectationSheet({
  expectation,
  plan,
  ledger,
  onClose,
  onExpectation,
  onChanged,
}: {
  expectation: IncomeExpectation;
  plan: IncomePlan | null;
  ledger: Ledger;
  onClose: () => void;
  onExpectation: (expectation: IncomeExpectation) => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [amount, setAmount] = useState(formatMinorInput(expectation.expectedMinor, expectation.currency));
  const untouched = expectation.status === "expected" && expectation.receivedMinor === 0;

  async function run(action: () => Promise<void>, done: string, fallback: string) {
    setSaving(true);
    setError("");
    try {
      await action();
      hapticSuccess();
      showToast(done);
      onClose();
    } catch (caught) {
      hapticError();
      setError(errorText(caught, fallback));
      setSaving(false);
    }
  }

  function saveAmount(event: FormEvent) {
    event.preventDefault();
    if (plan === null) return;
    const minor = parseMinorInput(amount, plan.currency);
    if (minor === null) {
      setError("Сумма не читается.");
      return;
    }
    if (minor <= 0) {
      setError("Сумма должна быть больше нуля.");
      return;
    }
    if (minor === expectation.expectedMinor) {
      onClose();
      return;
    }
    void run(
      async () => {
        await updatePlan(plan.id, { amountMinor: minor, currency: plan.currency });
        // Open lines of this plan follow the new amount in every month, so every cached month is outdated.
        onChanged();
      },
      "Сумма плана обновлена",
      "Не удалось сохранить сумму.",
    );
  }

  const details = [`${expectation.dayOfMonth}-го числа`, accountLabel(ledger.accounts, expectation.accountId)];
  if (plan?.recurrence === "monthly") details.push("каждый месяц");

  return (
    <Sheet title={expectation.name} onClose={onClose}>
      <div className="sheet-lead">
        <p className="sheet-amount">{formatMinor(expectation.expectedMinor, expectation.currency)}</p>
        <p className="muted">{details.join(" · ")}</p>
        {expectation.receivedMinor > 0 && expectation.status !== "received" ? (
          <p className="muted">Уже пришло {formatMinor(expectation.receivedMinor, expectation.currency)}</p>
        ) : null}
      </div>
      <div className="field">
        <span className="field-label">В этом месяце</span>
        <div className="card rows">
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className="option"
              aria-pressed={status === expectation.status}
              disabled={saving}
              onClick={() => {
                if (status === expectation.status) {
                  onClose();
                  return;
                }
                void run(
                  async () => onExpectation(await updateExpectationStatus(expectation.id, status)),
                  `${expectation.name}: ${STATUS_LABEL[status]}`,
                  "Не удалось сохранить статус.",
                );
              }}
            >
              <span>{STATUS_LABEL[status]}</span>
              {status === expectation.status ? <Icon name="check" /> : null}
            </button>
          ))}
        </div>
      </div>
      {plan !== null && untouched ? (
        <form className="field" onSubmit={saveAmount}>
          <label className="field-label" htmlFor="plan-amount">
            Сумма плана, {plan.currency}
          </label>
          <div className="inline-form">
            <input
              id="plan-amount"
              value={amount}
              inputMode="decimal"
              maxLength={20}
              autoComplete="off"
              enterKeyHint="done"
              disabled={saving}
              onChange={(event) => setAmount(event.target.value)}
            />
            <button type="submit" className="button compact" disabled={saving}>
              Сохранить
            </button>
          </div>
        </form>
      ) : null}
      <FieldError text={error} />
      {plan !== null ? (
        <ConfirmButton
          label="Больше не ждать этот доход"
          confirmLabel="Убрать из следующих месяцев"
          disabled={saving}
          onConfirm={() =>
            void run(
              async () => {
                await updatePlan(plan.id, { active: false });
                onChanged();
              },
              "План остановлен",
              "Не удалось убрать план.",
            )
          }
        />
      ) : null}
    </Sheet>
  );
}
