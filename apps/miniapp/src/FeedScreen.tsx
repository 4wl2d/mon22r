import type { Category, Transaction } from "@mon22r/domain";
import { type FormEvent, useMemo, useState } from "react";

import type { Ledger, LedgerChange } from "./App";
import {
  categorizeTransactions,
  createCategory,
  deleteTransaction,
  errorText,
  getTransactions,
  updateTransaction,
} from "./api";
import { dayKey, formatClock, formatDayLabel, formatSigned, type MonthPoint, monthKey } from "./format";
import { invalidate, useQuery } from "./store";
import { hapticError, hapticSuccess } from "./telegram";
import {
  accountLabel,
  type ChipOption,
  Chips,
  ConfirmButton,
  categoryLabel,
  MonthSwitcher,
  Notice,
  Skeleton,
} from "./ui";

const ALL = "all";
const NONE = "none";

export function FeedScreen({
  ledger,
  onLedger,
  point,
  today,
  onMonth,
  filter,
  onFilter,
}: {
  ledger: Ledger;
  onLedger: LedgerChange;
  point: MonthPoint;
  today: MonthPoint;
  onMonth: (point: MonthPoint) => void;
  filter: string;
  onFilter: (filter: string) => void;
}) {
  const key = monthKey(point);
  const query = useQuery(`tx:${key}`, () => getTransactions(key), "Не удалось загрузить ленту.");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const [bulkError, setBulkError] = useState("");
  const [working, setWorking] = useState(false);
  const transactions = query.data;
  const timeZone = ledger.user.timeZone;

  const shown = useMemo(() => select(transactions ?? [], filter, search), [transactions, filter, search]);
  const groups = useMemo(() => groupByDay(shown, timeZone), [shown, timeZone]);
  const filters = useMemo(
    () => filterOptions(transactions ?? [], ledger.categories),
    [transactions, ledger.categories],
  );
  const narrowed = filter !== ALL || search.trim() !== "";
  const assignable = shown.filter((transaction) => transaction.kind !== "transfer");

  function replaceMany(changed: (transaction: Transaction) => Transaction) {
    query.update((current) => current.map(changed));
    // Totals and category bars on the month screen come from these rows.
    invalidate("month:");
  }

  async function assignAll(categoryId: string | null) {
    const ids = assignable.map((transaction) => transaction.id);
    if (ids.length === 0) return;
    setWorking(true);
    setBulkError("");
    try {
      await categorizeTransactions(ids, categoryId);
      const set = new Set(ids);
      replaceMany((transaction) => (set.has(transaction.id) ? { ...transaction, categoryId } : transaction));
      hapticSuccess();
      setBulk(false);
    } catch (caught) {
      hapticError();
      setBulkError(errorText(caught, "Не удалось назначить категорию."));
    } finally {
      setWorking(false);
    }
  }

  return (
    <section>
      <MonthSwitcher point={point} today={today} busy={query.loading} onChange={onMonth} />
      {transactions === undefined && query.error === null ? <Skeleton lines={8} /> : null}
      {query.error !== null ? (
        <Notice tone="problem" text={query.error} action={{ label: "Повторить", onClick: query.reload }} />
      ) : null}
      {transactions !== undefined && transactions.length === 0 ? (
        <Notice text="В этом месяце записей нет. Напишите боту, например: кофе 350" />
      ) : null}
      {transactions !== undefined && transactions.length > 0 ? (
        <>
          <input
            className="search"
            type="search"
            value={search}
            placeholder="Поиск по описанию"
            aria-label="Поиск по описанию"
            enterKeyHint="search"
            onChange={(event) => setSearch(event.target.value)}
          />
          <Chips options={filters} value={filter} label="Фильтр" onChange={onFilter} />
          {narrowed && assignable.length > 0 ? (
            <div className="bulk">
              <button
                type="button"
                className="text-button"
                aria-expanded={bulk}
                onClick={() => setBulk((value) => !value)}
              >
                Категория для всех найденных · {assignable.length}
              </button>
              {bulk ? (
                <CategoryPicker
                  ledger={ledger}
                  onLedger={onLedger}
                  value={undefined}
                  disabled={working}
                  onPick={(categoryId) => void assignAll(categoryId)}
                />
              ) : null}
              {bulkError ? (
                <p className="field-error" role="alert">
                  {bulkError}
                </p>
              ) : null}
            </div>
          ) : null}
          {shown.length === 0 ? (
            <Notice
              text="Ничего не найдено."
              action={{
                label: "Сбросить",
                onClick: () => {
                  setSearch("");
                  onFilter(ALL);
                },
              }}
            />
          ) : null}
          {groups.map((group) => (
            <section key={group.day}>
              <h2 className="day">{group.label}</h2>
              {group.items.map((transaction) => (
                <Operation
                  key={transaction.id}
                  transaction={transaction}
                  ledger={ledger}
                  onLedger={onLedger}
                  open={openId === transaction.id}
                  onToggle={() => setOpenId(openId === transaction.id ? null : transaction.id)}
                  onChanged={(next) => replaceMany((item) => (item.id === next.id ? next : item))}
                  onDeleted={(ids) => {
                    const gone = new Set(ids);
                    query.update((current) => current.filter((item) => !gone.has(item.id)));
                    invalidate("month:");
                    setOpenId(null);
                  }}
                />
              ))}
            </section>
          ))}
        </>
      ) : null}
    </section>
  );
}

function Operation({
  transaction,
  ledger,
  onLedger,
  open,
  onToggle,
  onChanged,
  onDeleted,
}: {
  transaction: Transaction;
  ledger: Ledger;
  onLedger: LedgerChange;
  open: boolean;
  onToggle: () => void;
  onChanged: (transaction: Transaction) => void;
  onDeleted: (ids: readonly string[]) => void;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const description = transaction.description.trim();
  const transfer = transaction.kind === "transfer";
  const sameCurrency = ledger.accounts.filter(
    (account) =>
      account.currency === transaction.currency && (!account.archived || account.id === transaction.accountId),
  );

  async function run(action: () => Promise<void>, fallback: string) {
    setSaving(true);
    setError("");
    try {
      await action();
      hapticSuccess();
    } catch (caught) {
      hapticError();
      setError(errorText(caught, fallback));
    } finally {
      setSaving(false);
    }
  }

  const details = [
    formatClock(transaction.occurredAt, ledger.user.timeZone),
    accountLabel(ledger.accounts, transaction.accountId),
  ];
  if (transaction.kind === "refund") details.push("возврат");
  if (transfer) details.push(transaction.direction === "outflow" ? "перевод со счёта" : "перевод на счёт");

  return (
    <article className={open ? "operation open" : "operation"}>
      <button type="button" className="operation-head" aria-expanded={open} onClick={onToggle}>
        <span className="operation-title">{description || kindTitle(transaction)}</span>
        <span className={amountClass(transaction)}>
          {formatSigned(transaction.amountMinor, transaction.currency, transaction.direction)}
        </span>
        <span className="operation-meta">
          {details.join(" · ")}
          {transfer ? null : (
            <>
              {" · "}
              <span className={transaction.categoryId === null ? "todo" : undefined}>
                {categoryLabel(ledger.categories, transaction.categoryId)}
              </span>
            </>
          )}
        </span>
      </button>
      {open ? (
        <div className="operation-body">
          {transfer ? null : (
            <CategoryPicker
              ledger={ledger}
              onLedger={onLedger}
              value={transaction.categoryId}
              disabled={saving}
              onPick={(categoryId) =>
                void run(
                  async () => onChanged(await updateTransaction(transaction.id, { categoryId })),
                  "Не удалось сохранить категорию.",
                )
              }
            />
          )}
          {sameCurrency.length > 1 ? (
            <label>
              Счёт
              <select
                value={transaction.accountId}
                disabled={saving}
                onChange={(event) =>
                  void run(
                    async () => onChanged(await updateTransaction(transaction.id, { accountId: event.target.value })),
                    "Не удалось перенести запись.",
                  )
                }
              >
                {sameCurrency.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="row-actions">
            <ConfirmButton
              label="Удалить"
              confirmLabel={transfer ? "Удалить обе стороны перевода" : "Удалить запись"}
              disabled={saving}
              onConfirm={() =>
                void run(async () => {
                  const removed = await deleteTransaction(transaction.id);
                  // "Already gone" still means it should leave the screen.
                  onDeleted(removed.length > 0 ? removed : [transaction.id]);
                }, "Не удалось удалить запись.")
              }
            />
          </div>
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Category choices as chips, most useful first, with a field to add a new one in place.
 * `value` undefined means "nothing selected yet" (bulk assignment).
 */
function CategoryPicker({
  ledger,
  onLedger,
  value,
  disabled,
  onPick,
}: {
  ledger: Ledger;
  onLedger: LedgerChange;
  value: string | null | undefined;
  disabled: boolean;
  onPick: (categoryId: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const options: ChipOption[] = [
    ...ledger.categories.map((category) => ({ id: category.id, label: category.name })),
    { id: NONE, label: "без категории" },
  ];

  async function add(event: FormEvent) {
    event.preventDefault();
    const next = name.trim();
    if (next.length === 0) return;
    setAdding(true);
    setError("");
    try {
      const category = await createCategory(next);
      onLedger((current) => ({ ...current, categories: [...current.categories, category].sort(byName) }));
      setName("");
      onPick(category.id);
    } catch (caught) {
      hapticError();
      setError(errorText(caught, "Не удалось добавить категорию."));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="picker">
      <Chips
        options={options}
        value={value === undefined ? null : (value ?? NONE)}
        label="Категория"
        wrap
        disabled={disabled}
        onChange={(id) => onPick(id === NONE ? null : id)}
      />
      <form className="inline-form" onSubmit={(event) => void add(event)}>
        <input
          value={name}
          placeholder="Новая категория"
          aria-label="Новая категория"
          maxLength={80}
          enterKeyHint="done"
          disabled={disabled || adding}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="text-button" disabled={disabled || adding || name.trim() === ""}>
          Добавить
        </button>
      </form>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function select(transactions: readonly Transaction[], filter: string, search: string): Transaction[] {
  const needle = search.trim().toLowerCase();
  return transactions.filter((transaction) => {
    if (filter === NONE && (transaction.categoryId !== null || transaction.kind === "transfer")) return false;
    if (filter !== ALL && filter !== NONE && transaction.categoryId !== filter) return false;
    return needle === "" || transaction.description.toLowerCase().includes(needle);
  });
}

/** "All", "uncategorized" when there is something to sort out, then the categories used this month. */
function filterOptions(transactions: readonly Transaction[], categories: readonly Category[]): ChipOption[] {
  const counts = new Map<string, number>();
  let uncategorized = 0;
  for (const transaction of transactions) {
    if (transaction.kind === "transfer") continue;
    if (transaction.categoryId === null) uncategorized += 1;
    else counts.set(transaction.categoryId, (counts.get(transaction.categoryId) ?? 0) + 1);
  }
  const options: ChipOption[] = [{ id: ALL, label: "все", count: transactions.length }];
  if (uncategorized > 0) options.push({ id: NONE, label: "без категории", count: uncategorized });
  const used = categories
    .filter((category) => counts.has(category.id))
    .sort((left, right) => (counts.get(right.id) ?? 0) - (counts.get(left.id) ?? 0));
  for (const category of used) options.push({ id: category.id, label: category.name, count: counts.get(category.id) });
  return options;
}

function amountClass(transaction: Transaction): string {
  if (transaction.kind === "transfer") return "operation-amount muted";
  return transaction.direction === "inflow" ? "operation-amount inflow" : "operation-amount";
}

function kindTitle(transaction: Transaction): string {
  if (transaction.kind === "expense") return "трата";
  if (transaction.kind === "income") return "поступление";
  if (transaction.kind === "refund") return "возврат";
  return "перевод";
}

function groupByDay(
  transactions: readonly Transaction[],
  timeZone: string,
): readonly { day: string; label: string; items: Transaction[] }[] {
  const sorted = [...transactions].sort((left, right) => {
    const time = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    if (time !== 0 && !Number.isNaN(time)) return time;
    return right.id.localeCompare(left.id);
  });
  const groups: { day: string; label: string; items: Transaction[] }[] = [];
  for (const transaction of sorted) {
    const day = dayKey(transaction.occurredAt, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(transaction);
    else groups.push({ day, label: formatDayLabel(transaction.occurredAt, timeZone), items: [transaction] });
  }
  return groups;
}

function byName(left: Category, right: Category): number {
  return left.name.localeCompare(right.name, "ru");
}
