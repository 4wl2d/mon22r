import type { Account, Category } from "@mon22r/domain";
import { type FormEvent, type ReactNode, useState } from "react";

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
import { currencyName, formatUtcOffset } from "./format";
import { CurrencyChoice, CurrencySheet, TimeZoneSheet } from "./pickers";
import { invalidate } from "./store";
import { hapticError, hapticSuccess, openExternal } from "./telegram";
import { byName, ConfirmButton, FieldError, Icon, Sheet, Switch, showToast } from "./ui";

export function SettingsScreen({ ledger, onLedger }: { ledger: Ledger; onLedger: LedgerChange }) {
  return (
    <section>
      <h1 className="screen-title">Настройки</h1>
      <div className="stack">
        <Accounts ledger={ledger} onLedger={onLedger} />
        <Categories ledger={ledger} onLedger={onLedger} />
        <Profile ledger={ledger} onLedger={onLedger} />
        <p className="section-note">
          Версия {ledger.version.slice(0, 7) || "dev"} · курсы:{" "}
          <button type="button" className="link" onClick={() => openExternal("https://www.exchangerate-api.com")}>
            Rates By Exchange Rate API
          </button>
        </p>
      </div>
    </section>
  );
}

/** Runs a write, confirms it in a toast, and reports a failure as a sentence. Returns whether it worked. */
async function attempt(action: () => Promise<void>, done: string, fallback: string): Promise<string | null> {
  try {
    await action();
    hapticSuccess();
    showToast(done);
    return null;
  } catch (caught) {
    hapticError();
    return errorText(caught, fallback);
  }
}

function Accounts({ ledger, onLedger }: { ledger: Ledger; onLedger: LedgerChange }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const active = ledger.accounts.filter((account) => !account.archived).sort(byName);
  const archived = ledger.accounts.filter((account) => account.archived).sort(byName);
  const open = ledger.accounts.find((account) => account.id === openId) ?? null;
  const fallback = active.find((account) => account.currency === ledger.user.homeCurrency);

  const row = (account: Account) => (
    <button key={account.id} type="button" className="row" onClick={() => setOpenId(account.id)}>
      <span className="row-title">
        {account.name}
        {ledger.defaultAccountId === account.id ? (
          <>
            {" "}
            <span className="tag accent">основной</span>
          </>
        ) : null}
      </span>
      <span className="row-value">
        {account.currency}
        <Icon name="forward" small />
      </span>
    </button>
  );

  return (
    <section>
      <h2 className="section-label">Счета</h2>
      <div className="card rows">
        {active.map(row)}
        <button type="button" className="row action" onClick={() => setAdding(true)}>
          <Icon name="plus" small />
          Добавить счёт
        </button>
      </div>
      <p className="section-note">
        {ledger.defaultAccountId !== null
          ? "Сумма без валюты, например «кофе 350», записывается на основной счёт."
          : fallback
            ? `Основной счёт не выбран: сумма без валюты записывается в ${ledger.user.homeCurrency}, на «${fallback.name}».`
            : `Основной счёт не выбран: сумма без валюты читается в ${ledger.user.homeCurrency}.`}
      </p>
      {archived.length > 0 ? (
        <details className="fold">
          <summary>
            Архив · {archived.length}
            <Icon name="forward" small />
          </summary>
          <div className="card rows">{archived.map(row)}</div>
        </details>
      ) : null}
      {open ? (
        <AccountSheet account={open} ledger={ledger} onLedger={onLedger} onClose={() => setOpenId(null)} />
      ) : null}
      {adding ? <NewAccountSheet ledger={ledger} onLedger={onLedger} onClose={() => setAdding(false)} /> : null}
    </section>
  );
}

function AccountSheet({
  account,
  ledger,
  onLedger,
  onClose,
}: {
  account: Account;
  ledger: Ledger;
  onLedger: LedgerChange;
  onClose: () => void;
}) {
  const [name, setName] = useState(account.name);
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

  async function run(action: () => Promise<void>, done: string, fallback: string, thenClose: boolean) {
    setSaving(true);
    setError("");
    const problem = await attempt(action, done, fallback);
    setSaving(false);
    if (problem !== null) setError(problem);
    else if (thenClose) onClose();
  }

  function rename(event: FormEvent) {
    event.preventDefault();
    const next = name.trim();
    if (next.length === 0) {
      setError("Укажите название.");
      return;
    }
    if (next === account.name) {
      onClose();
      return;
    }
    void run(
      async () => {
        const result = await updateAccount(account.id, { name: next });
        apply(result.account, result.defaultAccountId);
      },
      "Название сохранено",
      "Не удалось переименовать счёт.",
      true,
    );
  }

  return (
    <Sheet title={`${account.name} · ${account.currency}`} onClose={onClose}>
      <form className="field" onSubmit={rename}>
        <label className="field-label" htmlFor="account-name">
          Название
        </label>
        <div className="inline-form">
          <input
            id="account-name"
            value={name}
            maxLength={80}
            autoComplete="off"
            enterKeyHint="done"
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="button compact" disabled={saving || name.trim() === account.name}>
            Сохранить
          </button>
        </div>
      </form>
      {account.archived ? null : (
        <div className="card">
          <div className="row">
            <span>
              Основной счёт
              <small className="row-hint">Сюда записывается сумма без валюты</small>
            </span>
            <Switch
              checked={isDefault}
              label="Основной счёт"
              disabled={saving}
              onChange={(next) =>
                void run(
                  async () => {
                    const result = await updateSettings({ defaultAccountId: next ? account.id : null });
                    onLedger((current) => ({ ...current, defaultAccountId: result.defaultAccountId }));
                  },
                  next ? `Основной счёт: ${account.name}` : "Основной счёт не выбран",
                  "Не удалось выбрать счёт.",
                  false,
                )
              }
            />
          </div>
        </div>
      )}
      <FieldError text={error} />
      <button
        type="button"
        className="button secondary"
        disabled={saving}
        onClick={() =>
          void run(
            async () => {
              const result = await updateAccount(account.id, { archived: !account.archived });
              apply(result.account, result.defaultAccountId);
            },
            account.archived ? `«${account.name}» снова в работе` : `«${account.name}» в архиве`,
            "Не удалось изменить счёт.",
            true,
          )
        }
      >
        {account.archived ? "Вернуть из архива" : "Убрать в архив"}
      </button>
      {account.archived ? null : (
        <p className="section-note">В архиве счёт не предлагается для новых записей. Его записи остаются на месте.</p>
      )}
    </Sheet>
  );
}

function NewAccountSheet({
  ledger,
  onLedger,
  onClose,
}: {
  ledger: Ledger;
  onLedger: LedgerChange;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState(ledger.user.homeCurrency);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function add(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    if (nextName.length === 0) {
      setError("Укажите название.");
      return;
    }
    setSaving(true);
    setError("");
    const problem = await attempt(
      async () => {
        const created = await createAccount({ name: nextName, currency });
        onLedger((current) => ({ ...current, accounts: [...current.accounts, created] }));
      },
      `Счёт «${nextName}» добавлен`,
      "Не удалось добавить счёт.",
    );
    setSaving(false);
    if (problem === null) onClose();
    else setError(problem);
  }

  return (
    <Sheet title="Новый счёт" onClose={onClose}>
      <form className="stack" onSubmit={(event) => void add(event)}>
        <div className="field">
          <label className="field-label" htmlFor="new-account-name">
            Название
          </label>
          <input
            id="new-account-name"
            value={name}
            placeholder="Например, Наличные"
            maxLength={80}
            autoComplete="off"
            enterKeyHint="done"
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <CurrencyChoice label="Валюта счёта" value={currency} disabled={saving} onChange={setCurrency} />
        <FieldError text={error} />
        <button type="submit" className="button" disabled={saving} aria-busy={saving}>
          Добавить счёт
        </button>
      </form>
    </Sheet>
  );
}

function Categories({ ledger, onLedger }: { ledger: Ledger; onLedger: LedgerChange }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const open = ledger.categories.find((category) => category.id === openId) ?? null;

  async function add(event: FormEvent) {
    event.preventDefault();
    const next = name.trim();
    if (next.length === 0) return;
    setSaving(true);
    setError("");
    const problem = await attempt(
      async () => {
        const category = await createCategory(next);
        onLedger((current) => ({ ...current, categories: [...current.categories, category].sort(byName) }));
        setName("");
      },
      `Категория «${next}» добавлена`,
      "Не удалось добавить категорию.",
    );
    setSaving(false);
    if (problem !== null) setError(problem);
  }

  return (
    <section>
      <h2 className="section-label">Категории</h2>
      <div className="card rows">
        {ledger.categories.map((category) => (
          <button key={category.id} type="button" className="row" onClick={() => setOpenId(category.id)}>
            <span className="row-title">{category.name}</span>
            <span className="row-value">
              <Icon name="forward" small />
            </span>
          </button>
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
          <button type="submit" className="button compact plain" disabled={saving || name.trim() === ""}>
            Добавить
          </button>
        </form>
      </div>
      <FieldError text={error} />
      {ledger.categories.length === 0 ? (
        <p className="section-note">
          Категорию можно завести и прямо в чате: <span className="example">кофе 350 #еда</span>
        </p>
      ) : null}
      {open ? <CategorySheet category={open} onLedger={onLedger} onClose={() => setOpenId(null)} /> : null}
    </section>
  );
}

function CategorySheet({
  category,
  onLedger,
  onClose,
}: {
  category: Category;
  onLedger: LedgerChange;
  onClose: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function run(action: () => Promise<void>, done: string, fallback: string) {
    setSaving(true);
    setError("");
    const problem = await attempt(action, done, fallback);
    if (problem === null) {
      onClose();
      return;
    }
    setSaving(false);
    setError(problem);
  }

  function rename(event: FormEvent) {
    event.preventDefault();
    const next = name.trim();
    if (next.length === 0) {
      setError("Укажите название.");
      return;
    }
    if (next === category.name) {
      onClose();
      return;
    }
    void run(
      async () => {
        const renamed = await renameCategory(category.id, next);
        onLedger((current) => ({
          ...current,
          categories: current.categories.map((item) => (item.id === renamed.id ? renamed : item)).sort(byName),
        }));
      },
      "Название сохранено",
      "Не удалось переименовать категорию.",
    );
  }

  return (
    <Sheet title={category.name} onClose={onClose}>
      <form className="field" onSubmit={rename}>
        <label className="field-label" htmlFor="category-name">
          Название
        </label>
        <div className="inline-form">
          <input
            id="category-name"
            value={name}
            maxLength={80}
            autoComplete="off"
            enterKeyHint="done"
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="button compact" disabled={saving || name.trim() === category.name}>
            Сохранить
          </button>
        </div>
      </form>
      <FieldError text={error} />
      <ConfirmButton
        label="Удалить категорию"
        confirmLabel="Удалить, записи останутся"
        disabled={saving}
        onConfirm={() =>
          void run(
            async () => {
              await deleteCategory(category.id);
              onLedger((current) => ({
                ...current,
                categories: current.categories.filter((item) => item.id !== category.id),
              }));
              // Its transactions are now uncategorized in every cached month.
              invalidate("month:");
              invalidate("tx:");
            },
            `Категория «${category.name}» удалена`,
            "Не удалось удалить категорию.",
          )
        }
      />
      <p className="section-note">Записи этой категории останутся и станут записями без категории.</p>
    </Sheet>
  );
}

/** Home currency and time zone. Each is one choice from a list, saved as soon as it is made. */
function Profile({ ledger, onLedger }: { ledger: Ledger; onLedger: LedgerChange }) {
  const [picking, setPicking] = useState<"currency" | "zone" | null>(null);
  const [error, setError] = useState("");

  async function save(patch: { homeCurrency?: string; timeZone?: string }, done: string) {
    setPicking(null);
    setError("");
    const problem = await attempt(
      async () => {
        const result = await updateSettings(patch);
        onLedger((current) => ({ ...current, user: result.user, defaultAccountId: result.defaultAccountId }));
        // Month boundaries and the estimate depend on both values.
        invalidate("month:");
        invalidate("tx:");
      },
      done,
      "Не удалось сохранить.",
    );
    if (problem !== null) setError(problem);
  }

  const setting = (title: string, hint: string, value: ReactNode, onClick: () => void) => (
    <button type="button" className="row" onClick={onClick}>
      <span>
        {title}
        <small className="row-hint">{hint}</small>
      </span>
      <span className="row-value">
        {value}
        <Icon name="forward" small />
      </span>
    </button>
  );

  const offset = formatUtcOffset(ledger.user.timeZone);
  return (
    <section>
      <h2 className="section-label">Учёт</h2>
      <div className="card rows">
        {setting(
          "Домашняя валюта",
          currencyName(ledger.user.homeCurrency) || "В ней считается итог месяца",
          ledger.user.homeCurrency,
          () => setPicking("currency"),
        )}
        {setting("Часовой пояс", ledger.user.timeZone.replaceAll("_", " "), offset, () => setPicking("zone"))}
      </div>
      <p className="section-note">
        В домашней валюте считается итог месяца. По часовому поясу записи делятся на дни и месяцы.
      </p>
      <FieldError text={error} />
      {picking === "currency" ? (
        <CurrencySheet
          title="Домашняя валюта"
          value={ledger.user.homeCurrency}
          onClose={() => setPicking(null)}
          onPick={(homeCurrency) => {
            if (homeCurrency === ledger.user.homeCurrency) setPicking(null);
            else void save({ homeCurrency }, `Домашняя валюта: ${homeCurrency}`);
          }}
        />
      ) : null}
      {picking === "zone" ? (
        <TimeZoneSheet
          value={ledger.user.timeZone}
          onClose={() => setPicking(null)}
          onPick={(timeZone) => {
            if (timeZone === ledger.user.timeZone) setPicking(null);
            else void save({ timeZone }, `Часовой пояс: ${timeZone.replaceAll("_", " ")}`);
          }}
        />
      ) : null}
    </section>
  );
}
