import type { Account, Category } from "@mon22r/domain";
import { type FormEvent, useState } from "react";

import type { Ledger, LedgerChange } from "./App";
import {
  createAccount,
  createCategory,
  deleteCategory,
  errorText,
  renameCategory,
  updateAccount,
  updateSettings,
} from "./api";
import { isTimeZone } from "./format";
import { invalidate } from "./store";
import { hapticError, hapticSuccess, openExternal } from "./telegram";
import { ConfirmButton, InlineEdit } from "./ui";

const CURRENCIES = ["EUR", "RSD", "RUB", "GBP"] as const;

export function SettingsScreen({ ledger, onLedger }: { ledger: Ledger; onLedger: LedgerChange }) {
  return (
    <section className="settings">
      <Accounts ledger={ledger} onLedger={onLedger} />
      <Categories ledger={ledger} onLedger={onLedger} />
      <Profile ledger={ledger} onLedger={onLedger} />
      <p className="caption">
        Версия {ledger.version.slice(0, 7) || "dev"} · курсы:{" "}
        <button type="button" className="link" onClick={() => openExternal("https://www.exchangerate-api.com")}>
          Rates By Exchange Rate API
        </button>
      </p>
    </section>
  );
}

function Accounts({ ledger, onLedger }: { ledger: Ledger; onLedger: LedgerChange }) {
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const active = ledger.accounts.filter((account) => !account.archived).sort(byName);
  const archived = ledger.accounts.filter((account) => account.archived).sort(byName);
  const fallback = ledger.accounts.find(
    (account) => !account.archived && account.currency === ledger.user.homeCurrency,
  );

  async function add(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    const nextCurrency = currency.trim().toUpperCase();
    if (nextName.length === 0) {
      setError("Укажите название.");
      return;
    }
    if (!/^[A-Z]{3}$/.test(nextCurrency)) {
      setError("Укажите валюту из трёх букв.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const created = await createAccount({ name: nextName, currency: nextCurrency });
      onLedger((current) => ({ ...current, accounts: [...current.accounts, created] }));
      setName("");
      setCurrency("");
      hapticSuccess();
    } catch (caught) {
      hapticError();
      setError(errorText(caught, "Не удалось добавить счёт."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>Счета</h2>
      <p className="muted">
        {ledger.defaultAccountId === null
          ? fallback
            ? `Сумма без валюты записывается в ${ledger.user.homeCurrency}, на «${fallback.name}». Чтобы писать «кофе 350» в другой валюте, выберите основной счёт.`
            : `Сумма без валюты записывается в ${ledger.user.homeCurrency}. Выберите основной счёт, чтобы писать «кофе 350» без валюты.`
          : "Сумма без валюты записывается на основной счёт."}
      </p>
      {active.length === 0 ? <p>Активных счетов нет.</p> : null}
      {active.map((account) => (
        <AccountRow key={account.id} account={account} ledger={ledger} onLedger={onLedger} />
      ))}
      {archived.length > 0 ? (
        <details className="fold">
          <summary>Архив · {archived.length}</summary>
          {archived.map((account) => (
            <AccountRow key={account.id} account={account} ledger={ledger} onLedger={onLedger} />
          ))}
        </details>
      ) : null}
      <details className="fold">
        <summary>Добавить счёт</summary>
        <form className="stack" onSubmit={(event) => void add(event)}>
          <label>
            Название
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoComplete="off" />
          </label>
          <div>
            <label>
              Валюта
              <input
                value={currency}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                maxLength={3}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="chips wrap plain">
              {CURRENCIES.map((code) => (
                <button
                  key={code}
                  type="button"
                  className="chip"
                  aria-pressed={currency === code}
                  onClick={() => setCurrency(code)}
                >
                  {code}
                </button>
              ))}
            </div>
          </div>
          <button type="submit" className="button" disabled={saving} aria-busy={saving}>
            Добавить
          </button>
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      </details>
    </section>
  );
}

function AccountRow({ account, ledger, onLedger }: { account: Account; ledger: Ledger; onLedger: LedgerChange }) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const isDefault = ledger.defaultAccountId === account.id;

  function apply(next: Account, defaultAccountId: string | null) {
    onLedger((current) => ({
      ...current,
      defaultAccountId,
      accounts: current.accounts.map((item) => (item.id === next.id ? next : item)),
    }));
  }

  async function rename(name: string): Promise<string | null> {
    if (name.length === 0) return "Укажите название.";
    try {
      const result = await updateAccount(account.id, { name });
      apply(result.account, result.defaultAccountId);
      hapticSuccess();
      return null;
    } catch (caught) {
      hapticError();
      return errorText(caught, "Не удалось переименовать счёт.");
    }
  }

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

  return (
    <article className="line">
      <div className="line-top">
        <InlineEdit value={account.name} label="Название счёта" save={rename} />
        <span className="muted">{account.currency}</span>
      </div>
      <div className="line-actions">
        {account.archived ? null : isDefault ? (
          <span className="badge">основной</span>
        ) : (
          <button
            type="button"
            className="text-button"
            disabled={saving}
            onClick={() =>
              void run(async () => {
                const result = await updateSettings({ defaultAccountId: account.id });
                onLedger((current) => ({ ...current, defaultAccountId: result.defaultAccountId }));
              }, "Не удалось выбрать счёт.")
            }
          >
            сделать основным
          </button>
        )}
        <button
          type="button"
          className="text-button"
          disabled={saving}
          onClick={() =>
            void run(async () => {
              const result = await updateAccount(account.id, { archived: !account.archived });
              apply(result.account, result.defaultAccountId);
            }, "Не удалось изменить счёт.")
          }
        >
          {account.archived ? "вернуть" : "в архив"}
        </button>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function Categories({ ledger, onLedger }: { ledger: Ledger; onLedger: LedgerChange }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function add(event: FormEvent) {
    event.preventDefault();
    const next = name.trim();
    if (next.length === 0) {
      setError("Укажите название.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const category = await createCategory(next);
      onLedger((current) => ({ ...current, categories: [...current.categories, category].sort(byName) }));
      setName("");
      hapticSuccess();
    } catch (caught) {
      hapticError();
      setError(errorText(caught, "Не удалось добавить категорию."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>Категории</h2>
      {ledger.categories.length === 0 ? (
        <p className="muted">Категорий пока нет. Добавьте здесь или прямо в чате: кофе 350 #еда</p>
      ) : null}
      {ledger.categories.map((category) => (
        <CategoryRow key={category.id} category={category} onLedger={onLedger} />
      ))}
      <form className="inline-form" onSubmit={(event) => void add(event)}>
        <input
          value={name}
          placeholder="Новая категория"
          aria-label="Новая категория"
          maxLength={80}
          enterKeyHint="done"
          disabled={saving}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="text-button" disabled={saving || name.trim() === ""}>
          Добавить
        </button>
      </form>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function CategoryRow({ category, onLedger }: { category: Category; onLedger: LedgerChange }) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function rename(name: string): Promise<string | null> {
    if (name.length === 0) return "Укажите название.";
    try {
      const next = await renameCategory(category.id, name);
      onLedger((current) => ({
        ...current,
        categories: current.categories.map((item) => (item.id === next.id ? next : item)).sort(byName),
      }));
      hapticSuccess();
      return null;
    } catch (caught) {
      hapticError();
      return errorText(caught, "Не удалось переименовать категорию.");
    }
  }

  async function remove() {
    setSaving(true);
    setError("");
    try {
      await deleteCategory(category.id);
      onLedger((current) => ({ ...current, categories: current.categories.filter((item) => item.id !== category.id) }));
      // Its transactions are now uncategorized in every cached month.
      invalidate("month:");
      invalidate("tx:");
      hapticSuccess();
    } catch (caught) {
      hapticError();
      setError(errorText(caught, "Не удалось удалить категорию."));
      setSaving(false);
    }
  }

  return (
    <article className="line">
      <div className="line-top">
        <InlineEdit value={category.name} label="Название категории" save={rename} />
        <ConfirmButton
          label="удалить"
          confirmLabel="удалить, записи останутся"
          disabled={saving}
          onConfirm={() => void remove()}
        />
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function Profile({ ledger, onLedger }: { ledger: Ledger; onLedger: LedgerChange }) {
  const [currency, setCurrency] = useState(ledger.user.homeCurrency);
  const [timeZone, setTimeZone] = useState(ledger.user.timeZone);
  const [note, setNote] = useState<{ readonly text: string; readonly problem: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const changed =
    currency.trim().toUpperCase() !== ledger.user.homeCurrency || timeZone.trim() !== ledger.user.timeZone;

  async function save(event: FormEvent) {
    event.preventDefault();
    const homeCurrency = currency.trim().toUpperCase();
    const zone = timeZone.trim();
    if (!/^[A-Z]{3}$/.test(homeCurrency)) {
      setNote({ text: "Укажите валюту из трёх букв.", problem: true });
      return;
    }
    if (!isTimeZone(zone)) {
      setNote({ text: "Часовой пояс не распознан.", problem: true });
      return;
    }
    setSaving(true);
    setNote(null);
    try {
      const result = await updateSettings({ homeCurrency, timeZone: zone });
      onLedger((current) => ({ ...current, user: result.user, defaultAccountId: result.defaultAccountId }));
      // Month boundaries and the estimate depend on both values.
      invalidate("month:");
      invalidate("tx:");
      hapticSuccess();
      setNote({ text: "Сохранено.", problem: false });
    } catch (caught) {
      hapticError();
      setNote({ text: errorText(caught, "Не удалось сохранить."), problem: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>Учёт</h2>
      <form className="stack" onSubmit={(event) => void save(event)}>
        <label>
          Домашняя валюта, в ней считается итог месяца
          <input
            value={currency}
            onChange={(event) => setCurrency(event.target.value.toUpperCase())}
            maxLength={3}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          Часовой пояс, по нему делятся дни и месяцы
          <input
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
          />
        </label>
        {changed ? (
          <button type="submit" className="button" disabled={saving} aria-busy={saving}>
            Сохранить
          </button>
        ) : null}
        {note ? (
          <p className={note.problem ? "field-error" : "muted"} role={note.problem ? "alert" : "status"}>
            {note.text}
          </p>
        ) : null}
      </form>
    </section>
  );
}

function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name, "ru");
}
