import type { Account, Category, Transaction } from "@mon22r/domain";
import type { FormEvent } from "react";
import { useState } from "react";
import { createCategory, errorText, getAccounts, getCategories, getTransactions, updateTransaction } from "./api";
import { dayKey, formatClock, formatDayLabel, formatMinor, type MonthPoint, monthKey } from "./format";
import { accountLabel, categoryLabel, MonthSwitcher, Status, useResource } from "./ui";

type FeedData = {
  readonly transactions: readonly Transaction[];
  readonly accounts: readonly Account[];
  readonly categories: readonly Category[];
};

export function FeedScreen({
  timeZone,
  point,
  onChange,
}: {
  timeZone: string;
  point: MonthPoint;
  onChange: (point: MonthPoint) => void;
}) {
  const key = monthKey(point);
  const { resource, reload, setData } = useResource(key, () => loadFeed(key), "Не удалось загрузить ленту.");
  const [categoryName, setCategoryName] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  async function addCategory(event: FormEvent) {
    event.preventDefault();
    const name = categoryName.trim();
    if (name.length === 0) {
      setFormError("Укажите название.");
      return;
    }
    if (resource.status !== "ready") return;
    const current = resource.data;
    setSaving(true);
    setFormError("");
    try {
      const category = await createCategory(name);
      setData({ ...current, categories: [...current.categories, category].sort(byCategoryName) });
      setCategoryName("");
    } catch (error) {
      setFormError(errorText(error, "Не удалось добавить категорию."));
    } finally {
      setSaving(false);
    }
  }

  function replace(transactions: readonly Transaction[]) {
    if (resource.status !== "ready") return;
    setData({ ...resource.data, transactions });
  }

  return (
    <section>
      <h1>Лента</h1>
      <MonthSwitcher point={point} onChange={onChange} />
      {resource.status === "loading" ? <Status text="Загрузка." /> : null}
      {resource.status === "error" ? (
        <Status text={resource.message} action={{ label: "Повторить", onClick: reload }} />
      ) : null}
      {resource.status === "ready" ? (
        <>
          {resource.data.transactions.length === 0 ? <p>В этом месяце операций нет.</p> : null}
          <FeedList timeZone={timeZone} data={resource.data} onChange={(transactions) => replace(transactions)} />
          <form className="panel" onSubmit={(event) => void addCategory(event)}>
            <label>
              Новая категория
              <input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} maxLength={80} />
            </label>
            <div className="row-actions">
              <button type="submit" className="button" disabled={saving}>
                Добавить
              </button>
            </div>
            {formError ? <p className="field-error">{formError}</p> : null}
          </form>
        </>
      ) : null}
    </section>
  );
}

function FeedList({
  timeZone,
  data,
  onChange,
}: {
  timeZone: string;
  data: FeedData;
  onChange: (transactions: readonly Transaction[]) => void;
}) {
  const groups = groupTransactions(data.transactions, timeZone);
  return (
    <>
      {groups.map((group) => (
        <section key={group.day}>
          <h2 className="day">{group.label}</h2>
          {group.items.map((transaction) => (
            <Operation
              key={transaction.id}
              transaction={transaction}
              timeZone={timeZone}
              accounts={data.accounts}
              categories={data.categories}
              onChange={(next) => onChange(data.transactions.map((item) => (item.id === next.id ? next : item)))}
            />
          ))}
        </section>
      ))}
    </>
  );
}

function Operation({
  transaction,
  timeZone,
  accounts,
  categories,
  onChange,
}: {
  transaction: Transaction;
  timeZone: string;
  accounts: readonly Account[];
  categories: readonly Category[];
  onChange: (transaction: Transaction) => void;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const description = transaction.description.trim();
  const sameCurrency = accounts.filter(
    (account) =>
      account.currency === transaction.currency && (!account.archived || account.id === transaction.accountId),
  );

  async function save(patch: { categoryId?: string | null; accountId?: string }) {
    setSaving(true);
    setError("");
    try {
      onChange(await updateTransaction(transaction.id, patch));
    } catch (caught) {
      setError(errorText(caught, "Не удалось сохранить операцию."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="operation">
      <div className="feed-top">
        <time dateTime={transaction.occurredAt}>{formatClock(transaction.occurredAt, timeZone)}</time>
        <span>{formatMinor(transaction.amountMinor, transaction.currency)}</span>
      </div>
      {description ? <h3>{description}</h3> : null}
      <p className="kind">{kindTitle(transaction)}</p>
      {transaction.kind === "refund" ? (
        <p>
          {transaction.categoryId === null
            ? "уменьшает траты без категории"
            : `уменьшает категорию «${categoryLabel(categories, transaction.categoryId)}»`}
        </p>
      ) : null}
      <div className="controls">
        {transaction.kind === "transfer" ? null : (
          <label>
            Категория
            <select
              value={transaction.categoryId ?? ""}
              disabled={saving}
              onChange={(event) => void save({ categoryId: event.target.value === "" ? null : event.target.value })}
            >
              <option value="">без категории</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
              {transaction.categoryId && !categories.some((category) => category.id === transaction.categoryId) ? (
                <option value={transaction.categoryId}>неизвестная категория</option>
              ) : null}
            </select>
          </label>
        )}
        <label>
          Счёт
          <select
            value={transaction.accountId}
            disabled={saving}
            onChange={(event) => void save({ accountId: event.target.value })}
          >
            {sameCurrency.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
            {sameCurrency.some((account) => account.id === transaction.accountId) ? null : (
              <option value={transaction.accountId}>{accountLabel(accounts, transaction.accountId)}</option>
            )}
          </select>
        </label>
      </div>
      {error ? <p className="field-error">{error}</p> : null}
    </article>
  );
}

function kindTitle(transaction: Transaction): string {
  if (transaction.kind === "expense") return "трата";
  if (transaction.kind === "income") return "поступление";
  if (transaction.kind === "refund") return "возврат";
  return transaction.direction === "outflow" ? "перевод со счёта" : "перевод на счёт";
}

function groupTransactions(
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
    const label = formatDayLabel(transaction.occurredAt, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(transaction);
    else groups.push({ day, label, items: [transaction] });
  }
  return groups;
}

function byCategoryName(left: Category, right: Category): number {
  return left.name.localeCompare(right.name, "ru");
}

async function loadFeed(month: string): Promise<FeedData> {
  const [transactions, accounts, categories] = await Promise.all([
    getTransactions(month),
    getAccounts(),
    getCategories(),
  ]);
  return { transactions, accounts, categories };
}
