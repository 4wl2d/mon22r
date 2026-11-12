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
import {
  dayKey,
  formatClock,
  formatDateTime,
  formatDayHeading,
  formatSigned,
  type MonthPoint,
  monthKey,
  plural,
} from "./format";
import { invalidate, useQuery } from "./store";
import { canReturnToChat, hapticError, hapticSelect, hapticSuccess, returnToChat } from "./telegram";
import {
  accountLabel,
  byName,
  type ChipOption,
  Chips,
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

const ALL = "all";
const NONE = "none";

export function EntriesScreen({
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
  const query = useQuery(`tx:${key}`, () => getTransactions(key), "Не удалось загрузить записи.");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
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
  const open = transactions?.find((transaction) => transaction.id === openId) ?? null;

  function replaceMany(changed: (transaction: Transaction) => Transaction) {
    query.update((current) => current.map(changed));
    // Totals and category bars on the month screen come from these rows.
    invalidate("month:");
  }

  return (
    <section>
      <header className="topbar">
        <MonthSwitcher point={point} today={today} busy={query.loading} onChange={onMonth} />
      </header>
      {transactions === undefined && query.error === null ? <Skeleton blocks={[48, 36, 180, 240]} /> : null}
      {query.error !== null ? (
        <Notice tone="problem" text={query.error} action={{ label: "Повторить", onClick: query.reload }} />
      ) : null}
      {transactions !== undefined && transactions.length === 0 ? (
        <Notice
          title="Записей пока нет"
          text={
            <>
              Напишите боту в чате, например <span className="example">кофе 350</span>
            </>
          }
          action={canReturnToChat() ? { label: "Перейти в чат", onClick: returnToChat } : undefined}
        />
      ) : null}
      {transactions !== undefined && transactions.length > 0 ? (
        <>
          <div className="filterbar">
            <div className="search">
              <Icon name="search" small />
              <input
                type="search"
                value={search}
                placeholder="Поиск по описанию"
                aria-label="Поиск по описанию"
                enterKeyHint="search"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <Chips
              options={filters}
              value={filter}
              label="Фильтр по категории"
              onChange={(id) => {
                hapticSelect();
                onFilter(id);
              }}
            />
          </div>
          {narrowed && assignable.length > 0 ? (
            <div className="bulk">
              <span>
                {plural(assignable.length, "Найдена", "Найдено", "Найдено")} {assignable.length}{" "}
                {plural(assignable.length, "запись", "записи", "записей")}
              </span>
              <button type="button" className="button compact plain" onClick={() => setBulk(true)}>
                Категория для всех
              </button>
            </div>
          ) : null}
          {shown.length === 0 ? (
            <Notice
              text="Ничего не найдено."
              action={{
                label: "Сбросить поиск и фильтр",
                onClick: () => {
                  setSearch("");
                  onFilter(ALL);
                },
              }}
            />
          ) : null}
          {groups.map((group) => (
            <section key={group.day} className="day-group">
              <h2 className="day">
                <span>{group.label}</span>
                {group.spent ? <span>{group.spent}</span> : null}
              </h2>
              <div className="card rows">
                {group.items.map((transaction) => (
                  <EntryRow
                    key={transaction.id}
                    transaction={transaction}
                    ledger={ledger}
                    onOpen={() => setOpenId(transaction.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </>
      ) : null}
      {open ? (
        <EntrySheet
          transaction={open}
          ledger={ledger}
          onLedger={onLedger}
          onClose={() => setOpenId(null)}
          onChanged={(next) => replaceMany((item) => (item.id === next.id ? next : item))}
          onDeleted={(ids) => {
            const gone = new Set(ids);
            query.update((current) => current.filter((item) => !gone.has(item.id)));
            invalidate("month:");
          }}
        />
      ) : null}
      {bulk ? (
        <BulkSheet
          ids={assignable.map((transaction) => transaction.id)}
          ledger={ledger}
          onLedger={onLedger}
          onClose={() => setBulk(false)}
          onAssigned={(ids, categoryId) => {
            const set = new Set(ids);
            replaceMany((transaction) => (set.has(transaction.id) ? { ...transaction, categoryId } : transaction));
          }}
        />
      ) : null}
    </section>
  );
}

function EntryRow({ transaction, ledger, onOpen }: { transaction: Transaction; ledger: Ledger; onOpen: () => void }) {
  const details = [
    formatClock(transaction.occurredAt, ledger.user.timeZone),
    accountLabel(ledger.accounts, transaction.accountId),
    ...kindNotes(transaction),
  ];
  return (
    <button type="button" className="row" onClick={onOpen}>
      <span className="row-title">{titleOf(transaction)}</span>
      <span className={amountClass(transaction)}>
        {formatSigned(transaction.amountMinor, transaction.currency, transaction.direction)}
      </span>
      <span className="row-meta">
        <span>{details.join(" · ")}</span>
        {transaction.categoryId !== null ? (
          <span className="tag">{categoryLabel(ledger.categories, transaction.categoryId)}</span>
        ) : needsCategory(transaction) ? (
          <span className="tag todo">без категории</span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * One entry and what can be done with it: set the category, move it to another account of the same currency,
 * or delete it. Each action finishes the visit: the sheet closes and a line confirms what happened.
 */
function EntrySheet({
  transaction,
  ledger,
  onLedger,
  onClose,
  onChanged,
  onDeleted,
}: {
  transaction: Transaction;
  ledger: Ledger;
  onLedger: LedgerChange;
  onClose: () => void;
  onChanged: (transaction: Transaction) => void;
  onDeleted: (ids: readonly string[]) => void;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const transfer = transaction.kind === "transfer";
  const sameCurrency = ledger.accounts.filter(
    (account) =>
      account.currency === transaction.currency && (!account.archived || account.id === transaction.accountId),
  );

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

  const details = [
    formatDateTime(transaction.occurredAt, ledger.user.timeZone),
    accountLabel(ledger.accounts, transaction.accountId),
    ...kindNotes(transaction),
  ];

  return (
    <Sheet title={titleOf(transaction)} onClose={onClose}>
      <div className="sheet-lead">
        <p className={transaction.direction === "inflow" && !transfer ? "sheet-amount positive" : "sheet-amount"}>
          {formatSigned(transaction.amountMinor, transaction.currency, transaction.direction)}
        </p>
        <p className="muted">{details.join(" · ")}</p>
      </div>
      {transfer ? null : (
        <CategoryPicker
          ledger={ledger}
          onLedger={onLedger}
          value={transaction.categoryId}
          disabled={saving}
          onPick={(categoryId, name) => {
            if (categoryId === transaction.categoryId) {
              onClose();
              return;
            }
            void run(
              async () => onChanged(await updateTransaction(transaction.id, { categoryId })),
              categoryId === null ? "Категория снята" : `Категория: ${name}`,
              "Не удалось сохранить категорию.",
            );
          }}
        />
      )}
      {sameCurrency.length > 1 ? (
        <div className="field">
          <span className="field-label">Счёт</span>
          <Chips
            options={sameCurrency.map((account) => ({ id: account.id, label: account.name }))}
            value={transaction.accountId}
            label="Счёт"
            wrap
            disabled={saving}
            onChange={(accountId) => {
              if (accountId === transaction.accountId) return;
              void run(
                async () => onChanged(await updateTransaction(transaction.id, { accountId })),
                `Перенесено: ${accountLabel(ledger.accounts, accountId)}`,
                "Не удалось перенести запись.",
              );
            }}
          />
        </div>
      ) : null}
      <FieldError text={error} />
      <ConfirmButton
        label={transfer ? "Удалить перевод" : "Удалить запись"}
        confirmLabel={transfer ? "Удалить обе стороны перевода" : "Удалить насовсем"}
        disabled={saving}
        onConfirm={() =>
          void run(
            async () => {
              const removed = await deleteTransaction(transaction.id);
              // "Already gone" still means it should leave the screen.
              onDeleted(removed.length > 0 ? removed : [transaction.id]);
            },
            transfer ? "Перевод удалён" : "Запись удалена",
            "Не удалось удалить запись.",
          )
        }
      />
    </Sheet>
  );
}

/** One category for everything the search and the filter found. */
function BulkSheet({
  ids,
  ledger,
  onLedger,
  onClose,
  onAssigned,
}: {
  ids: readonly string[];
  ledger: Ledger;
  onLedger: LedgerChange;
  onClose: () => void;
  onAssigned: (ids: readonly string[], categoryId: string | null) => void;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const count = `${ids.length} ${plural(ids.length, "записи", "записей", "записей")}`;

  async function assign(categoryId: string | null, name: string) {
    setSaving(true);
    setError("");
    try {
      await categorizeTransactions(ids, categoryId);
      onAssigned(ids, categoryId);
      hapticSuccess();
      showToast(categoryId === null ? `Категория снята: ${ids.length}` : `${name}: ${ids.length}`);
      onClose();
    } catch (caught) {
      hapticError();
      setError(errorText(caught, "Не удалось назначить категорию."));
      setSaving(false);
    }
  }

  return (
    <Sheet title={`Категория для ${count}`} onClose={onClose}>
      <CategoryPicker
        ledger={ledger}
        onLedger={onLedger}
        value={undefined}
        disabled={saving}
        onPick={(categoryId, name) => void assign(categoryId, name)}
      />
      <FieldError text={error} />
    </Sheet>
  );
}

/**
 * Category choices as chips, with a field to add a new one in place.
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
  onPick: (categoryId: string | null, name: string) => void;
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
      onPick(category.id, category.name);
    } catch (caught) {
      hapticError();
      setError(errorText(caught, "Не удалось добавить категорию."));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="field">
      <span className="field-label">Категория</span>
      <Chips
        options={options}
        value={value === undefined ? null : (value ?? NONE)}
        label="Категория"
        wrap
        disabled={disabled}
        onChange={(id) => {
          if (id === NONE) onPick(null, "");
          else onPick(id, categoryLabel(ledger.categories, id));
        }}
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
        <button type="submit" className="button compact secondary" disabled={disabled || adding || name.trim() === ""}>
          Добавить
        </button>
      </form>
      <FieldError text={error} />
    </div>
  );
}

/** An expense or a refund without a category is unfinished; an income or a transfer is fine without one. */
function needsCategory(transaction: Transaction): boolean {
  return transaction.categoryId === null && (transaction.kind === "expense" || transaction.kind === "refund");
}

function select(transactions: readonly Transaction[], filter: string, search: string): Transaction[] {
  const needle = search.trim().toLowerCase();
  return transactions.filter((transaction) => {
    if (filter === NONE && !needsCategory(transaction)) return false;
    if (filter !== ALL && filter !== NONE && transaction.categoryId !== filter) return false;
    return needle === "" || transaction.description.toLowerCase().includes(needle);
  });
}

/** "All", "uncategorized" when there is something to sort out, then the categories used this month. */
function filterOptions(transactions: readonly Transaction[], categories: readonly Category[]): ChipOption[] {
  const counts = new Map<string, number>();
  let uncategorized = 0;
  for (const transaction of transactions) {
    if (needsCategory(transaction)) uncategorized += 1;
    else if (transaction.categoryId !== null) {
      counts.set(transaction.categoryId, (counts.get(transaction.categoryId) ?? 0) + 1);
    }
  }
  const options: ChipOption[] = [{ id: ALL, label: "Все", count: transactions.length }];
  if (uncategorized > 0) options.push({ id: NONE, label: "Без категории", count: uncategorized });
  const used = categories
    .filter((category) => counts.has(category.id))
    .sort((left, right) => (counts.get(right.id) ?? 0) - (counts.get(left.id) ?? 0));
  for (const category of used) options.push({ id: category.id, label: category.name, count: counts.get(category.id) });
  return options;
}

function amountClass(transaction: Transaction): string {
  if (transaction.kind === "transfer") return "amount transfer";
  return transaction.direction === "inflow" ? "amount inflow" : "amount";
}

function titleOf(transaction: Transaction): string {
  const description = transaction.description.trim();
  if (description !== "") return description;
  if (transaction.kind === "expense") return "Расход";
  if (transaction.kind === "income") return "Доход";
  if (transaction.kind === "refund") return "Возврат";
  return "Перевод";
}

function kindNotes(transaction: Transaction): string[] {
  if (transaction.kind === "refund") return ["возврат"];
  if (transaction.kind === "transfer") {
    return [transaction.direction === "outflow" ? "перевод со счёта" : "перевод на счёт"];
  }
  return [];
}

type DayGroup = {
  readonly day: string;
  readonly label: string;
  /** What the day cost, when all of its spending is in one currency. */
  readonly spent: string | null;
  readonly items: Transaction[];
};

function groupByDay(transactions: readonly Transaction[], timeZone: string): readonly DayGroup[] {
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
    else groups.push({ day, label: formatDayHeading(transaction.occurredAt, timeZone), items: [transaction] });
  }
  return groups.map((group) => ({ ...group, spent: daySpend(group.items) }));
}

function daySpend(items: readonly Transaction[]): string | null {
  const spending = items.filter((item) => item.kind === "expense" || item.kind === "refund");
  const currency = spending[0]?.currency;
  if (currency === undefined || spending.some((item) => item.currency !== currency)) return null;
  const spent = spending.reduce(
    (sum, item) => sum + (item.kind === "expense" ? item.amountMinor : -item.amountMinor),
    0,
  );
  if (spent <= 0) return null;
  return formatSigned(spent, currency, "outflow");
}
