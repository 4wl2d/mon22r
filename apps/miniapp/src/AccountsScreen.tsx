import { useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Account } from "@mon22r/domain";
import { createAccount, errorText, getAccounts, updateAccount } from "./api";
import { Status, useResource } from "./ui";

const CURRENCIES = ["RSD", "RUB", "GBP"] as const;

export function AccountsScreen() {
  const { resource, reload, setData } = useResource("accounts", getAccounts, "Не удалось загрузить счета.");
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  async function addAccount(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    const nextCurrency = currency.trim().toUpperCase();
    if (nextName.length === 0) {
      setFormError("Укажите название.");
      return;
    }
    if (!/^[A-Z]{3}$/.test(nextCurrency)) {
      setFormError("Укажите валюту из трёх букв.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const created = await createAccount({ name: nextName, currency: nextCurrency });
      if (resource.status === "ready") setData([...resource.data, created]);
      setName("");
      setCurrency("");
    } catch (error) {
      setFormError(errorText(error, "Не удалось добавить счёт."));
    } finally {
      setSaving(false);
    }
  }

  function replace(account: Account) {
    if (resource.status !== "ready") return;
    setData(resource.data.map((item) => (item.id === account.id ? account : item)));
  }

  const accounts = resource.status === "ready" ? resource.data : [];
  const active = accounts.filter((account) => !account.archived).sort(byName);
  const archived = accounts.filter((account) => account.archived).sort(byName);

  return (
    <section>
      <h1>Счета</h1>
      {resource.status === "loading" ? <Status text="Загрузка." /> : null}
      {resource.status === "error" ? (
        <Status text={resource.message} action={{ label: "Повторить", onClick: reload }} />
      ) : null}
      {resource.status === "ready" && active.length === 0 && archived.length === 0 ? <p>Счетов нет.</p> : null}
      {resource.status === "ready" && active.length === 0 && archived.length > 0 ? <p>Активных счетов нет.</p> : null}
      {active.map((account) => (
        <AccountRow key={account.id} account={account} onChange={replace} />
      ))}
      {archived.length > 0 ? (
        <section className="panel">
          <h2>Архив</h2>
          {archived.map((account) => (
            <AccountRow key={account.id} account={account} onChange={replace} />
          ))}
        </section>
      ) : null}
      {resource.status === "ready" ? (
        <form className="panel" onSubmit={(event) => void addAccount(event)}>
          <h2>Новый счёт</h2>
          <label>
            Название
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
          </label>
          <label>
            Валюта
            <input
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              maxLength={3}
              autoCapitalize="characters"
              spellCheck={false}
            />
          </label>
          <div className="choices">
            {CURRENCIES.map((code) => (
              <button key={code} type="button" aria-pressed={currency === code} onClick={() => setCurrency(code)}>
                {code}
              </button>
            ))}
          </div>
          <button type="submit" className="button" disabled={saving}>
            Добавить
          </button>
          {formError ? <p className="field-error">{formError}</p> : null}
        </form>
      ) : null}
    </section>
  );
}

function AccountRow({ account, onChange }: { account: Account; onChange: (account: Account) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.name);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const skip = useRef(false);

  async function saveName() {
    if (skip.current) {
      skip.current = false;
      return;
    }
    const next = draft.trim();
    if (next.length === 0) {
      setError("Укажите название.");
      return;
    }
    if (next === account.name) {
      setEditing(false);
      setError("");
      return;
    }
    setSaving(true);
    try {
      onChange(await updateAccount(account.id, { name: next }));
      setEditing(false);
      setError("");
    } catch (caught) {
      setError(errorText(caught, "Не удалось переименовать счёт."));
    } finally {
      setSaving(false);
    }
  }

  async function setArchived(archived: boolean) {
    setSaving(true);
    setError("");
    try {
      onChange(await updateAccount(account.id, { archived }));
    } catch (caught) {
      setError(errorText(caught, "Не удалось изменить счёт."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="account">
      <div className="account-top">
        {editing ? (
          <input
            value={draft}
            autoFocus
            disabled={saving}
            aria-label="Название"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                skip.current = true;
                setDraft(account.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button type="button" className="amount" onClick={() => setEditing(true)}>
            {account.name}
          </button>
        )}
        <span>{account.currency}</span>
      </div>
      <div className="account-actions">
        <button type="button" className="text-button" disabled={saving} onClick={() => void setArchived(!account.archived)}>
          {account.archived ? "вернуть" : "в архив"}
        </button>
      </div>
      {error ? <p className="field-error">{error}</p> : null}
    </article>
  );
}

function byName(left: Account, right: Account): number {
  return left.name.localeCompare(right.name, "ru");
}
