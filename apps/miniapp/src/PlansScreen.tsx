import { useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { Account, ExpectationStatus, IncomeExpectation, IncomePlan, PlanRecurrence } from "@mon22r/domain";
import {
  copyPlans,
  errorText,
  getAccounts,
  getPlans,
  updateExpectationStatus,
  updatePlanAmount,
  type PlanRow,
} from "./api";
import {
  addMonths,
  currentMonth,
  formatMinor,
  formatMinorInput,
  formatMonthTitle,
  monthKey,
  parseMinorInput,
} from "./format";
import { accountLabel, Status, useResource } from "./ui";

const STATUS_LABEL: Record<ExpectationStatus, string> = {
  expected: "ожидается",
  received: "пришло",
  partial: "пришло частично",
  skipped: "не будет",
};

const STATUSES = ["expected", "received", "partial", "skipped"] as const;

export function PlansScreen({ timeZone }: { timeZone: string }) {
  const today = currentMonth(timeZone);
  const upcoming = addMonths(today, 1);
  const fromMonth = monthKey(today);
  const toMonth = monthKey(upcoming);
  const { resource, reload, setData } = useResource(toMonth, () => loadPlans(toMonth), "Не удалось загрузить план.");
  const [note, setNote] = useState("");
  const [copying, setCopying] = useState(false);

  async function repeatPlan() {
    setCopying(true);
    setNote("");
    try {
      await copyPlans(fromMonth, toMonth);
      setNote("План текущего месяца записан на следующий.");
      reload();
    } catch (error) {
      setNote(errorText(error, "Не удалось повторить план."));
    } finally {
      setCopying(false);
    }
  }

  function replace(next: readonly PlanRow[]) {
    if (resource.status !== "ready") return;
    setData({ ...resource.data, plans: next });
  }

  return (
    <section>
      <h1>Следующий месяц</h1>
      <p className="subhead">{formatMonthTitle(upcoming)}</p>
      {resource.status === "loading" ? <Status text="Загрузка." /> : null}
      {resource.status === "error" ? (
        <Status text={resource.message} action={{ label: "Повторить", onClick: reload }} />
      ) : null}
      {resource.status === "ready" ? (
        <div className="stack">
          {resource.data.plans.length === 0 ? <p>На следующий месяц ничего не ожидается.</p> : null}
          {resource.data.plans.map((row) => (
            <PlanCard
              key={rowKey(row)}
              row={row}
              accounts={resource.data.accounts}
              onAmount={(plan) => replace(resource.data.plans.map((item) => (sameRow(item, row) ? withPlan(item, plan) : item)))}
              onStatus={(expectation) =>
                replace(resource.data.plans.map((item) => (sameRow(item, row) ? withExpectation(item, expectation) : item)))
              }
            />
          ))}
          <button type="button" className="button" onClick={() => void repeatPlan()} disabled={copying} aria-busy={copying}>
            Повторить план этого месяца
          </button>
          {note ? <p>{note}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function PlanCard({
  row,
  accounts,
  onAmount,
  onStatus,
}: {
  row: PlanRow;
  accounts: readonly Account[];
  onAmount: (plan: IncomePlan) => void;
  onStatus: (expectation: IncomeExpectation) => void;
}) {
  const view = fields(row);
  const [error, setError] = useState("");
  return (
    <article className={view.status === "skipped" ? "plan quiet" : "plan"}>
      <h2 className="plan-name">{view.name}</h2>
      {view.planId ? (
        <AmountEditor
          amountMinor={view.amountMinor}
          currency={view.currency}
          planId={view.planId}
          onSaved={onAmount}
        />
      ) : (
        <p>{formatMinor(view.amountMinor, view.currency)}</p>
      )}
      <p className="meta">{planMeta(view.dayOfMonth, accountLabel(accounts, view.accountId), view.recurrence)}</p>
      {view.receivedMinor > 0 ? <p className="received">получено {formatMinor(view.receivedMinor, view.currency)}</p> : null}
      <StatusControl
        status={view.status}
        expectationId={view.expectationId}
        onSaved={onStatus}
        onError={setError}
      />
      {error ? <p className="field-error">{error}</p> : null}
    </article>
  );
}

function AmountEditor({
  amountMinor,
  currency,
  planId,
  onSaved,
}: {
  amountMinor: number;
  currency: string;
  planId: string;
  onSaved: (plan: IncomePlan) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const skip = useRef(false);

  function openEditor() {
    setDraft(formatMinorInput(amountMinor, currency));
    setError("");
    setEditing(true);
  }

  if (!editing) {
    return (
      <button type="button" className="amount" onClick={openEditor}>
        {formatMinor(amountMinor, currency)}
      </button>
    );
  }

  async function commit(value: string) {
    if (skip.current) {
      skip.current = false;
      return;
    }
    const parsed = parseMinorInput(value, currency);
    if (parsed === null) {
      setError("Сумма не читается.");
      return;
    }
    if (parsed <= 0) {
      setError("Сумма должна быть больше нуля.");
      return;
    }
    if (parsed === amountMinor) {
      setEditing(false);
      setError("");
      return;
    }
    setSaving(true);
    try {
      const plan = await updatePlanAmount(planId, parsed, currency);
      onSaved(plan);
      setEditing(false);
      setError("");
    } catch (caught) {
      setError(errorText(caught, "Не удалось сохранить сумму."));
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") {
      skip.current = true;
      setEditing(false);
      setError("");
    }
  }

  return (
    <form
      className="inline-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
      }}
    >
      <input
        inputMode="decimal"
        autoFocus
        value={draft}
        disabled={saving}
        aria-label="Сумма"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit(draft)}
        onKeyDown={onKeyDown}
      />
      {error ? <p className="field-error">{error}</p> : null}
    </form>
  );
}

function StatusControl({
  status,
  expectationId,
  onSaved,
  onError,
}: {
  status: ExpectationStatus;
  expectationId: string | null;
  onSaved: (expectation: IncomeExpectation) => void;
  onError: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  if (!expectationId) return <p className="meta">{STATUS_LABEL[status]}</p>;
  const id = expectationId;

  async function change(next: ExpectationStatus) {
    if (next === status) return;
    setSaving(true);
    onError("");
    try {
      const expectation = await updateExpectationStatus(id, next);
      onSaved(expectation);
    } catch (caught) {
      onError(errorText(caught, "Не удалось сохранить статус."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <label>
      Статус
      <select value={status} disabled={saving} onChange={(event) => void change(readStatusValue(event.target.value))}>
        {STATUSES.map((item) => (
          <option key={item} value={item}>
            {STATUS_LABEL[item]}
          </option>
        ))}
      </select>
    </label>
  );
}

function readStatusValue(value: string): ExpectationStatus {
  if (value === "received" || value === "partial" || value === "skipped") return value;
  return "expected";
}

function fields(row: PlanRow): {
  name: string;
  amountMinor: number;
  currency: string;
  dayOfMonth: number;
  accountId: string | null;
  recurrence: PlanRecurrence | null;
  status: ExpectationStatus;
  receivedMinor: number;
  planId: string | null;
  expectationId: string | null;
} {
  const plan = row.plan;
  const expectation = row.expectation;
  return {
    name: plan?.name ?? expectation?.name ?? "",
    amountMinor: plan?.amountMinor ?? expectation?.expectedMinor ?? 0,
    currency: plan?.currency ?? expectation?.currency ?? "",
    dayOfMonth: plan?.dayOfMonth ?? expectation?.dayOfMonth ?? 1,
    accountId: plan?.accountId ?? expectation?.accountId ?? null,
    recurrence: plan?.recurrence ?? null,
    status: expectation?.status ?? "expected",
    receivedMinor: expectation?.receivedMinor ?? 0,
    planId: plan?.id ?? expectation?.planId ?? null,
    expectationId: expectation && expectation.id.length > 0 ? expectation.id : null,
  };
}

function withPlan(row: PlanRow, plan: IncomePlan): PlanRow {
  const open = row.expectation;
  const expectation =
    open && open.status === "expected" && open.receivedMinor === 0
      ? {
          ...open,
          name: plan.name,
          expectedMinor: plan.amountMinor,
          currency: plan.currency,
          accountId: plan.accountId,
          dayOfMonth: plan.dayOfMonth,
        }
      : open;
  return { plan, expectation };
}

function withExpectation(row: PlanRow, expectation: IncomeExpectation): PlanRow {
  return { ...row, expectation };
}

function sameRow(left: PlanRow, right: PlanRow): boolean {
  return rowKey(left) === rowKey(right);
}

function rowKey(row: PlanRow): string {
  return row.plan?.id ?? row.expectation?.id ?? "plan";
}

function recurrenceLabel(recurrence: PlanRecurrence): string {
  return recurrence === "monthly" ? "каждый месяц" : "один раз";
}

function planMeta(day: number, account: string, recurrence: PlanRecurrence | null): string {
  const parts = [`день ${day}`, account];
  if (recurrence) parts.push(recurrenceLabel(recurrence));
  return parts.join(" · ");
}

async function loadPlans(month: string): Promise<{ plans: readonly PlanRow[]; accounts: readonly Account[] }> {
  const [plans, accounts] = await Promise.all([getPlans(month), getAccounts()]);
  return { plans, accounts };
}
