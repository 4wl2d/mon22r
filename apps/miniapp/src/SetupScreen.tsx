import { useState } from "react";
import type { FormEvent } from "react";
import type { User } from "@mon22r/domain";
import { errorText, setup } from "./api";
import { isTimeZone } from "./format";

const CURRENCIES = ["RSD", "RUB", "GBP"] as const;
const DEFAULT_ZONE = "Europe/Belgrade";

export function SetupScreen({ user, onReady }: { user: User | null; onReady: (user: User) => void }) {
  const [currency, setCurrency] = useState(user?.homeCurrency ?? "");
  const [timeZone, setTimeZone] = useState(user?.timeZone ?? DEFAULT_ZONE);
  const [starterAccounts, setStarterAccounts] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const homeCurrency = currency.trim().toUpperCase();
    const zone = timeZone.trim();
    if (!/^[A-Z]{3}$/.test(homeCurrency)) {
      setError("Укажите валюту из трёх букв.");
      return;
    }
    if (!isTimeZone(zone)) {
      setError("Часовой пояс не распознан.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const user = await setup({ homeCurrency, timeZone: zone, starterAccounts });
      onReady(user);
    } catch (caught) {
      setError(errorText(caught, "Не удалось сохранить настройку."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h1>Настройка</h1>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <div>
          <label>
            Домашняя валюта
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
        </div>
        <label>
          Часовой пояс
          <input
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={starterAccounts}
            onChange={(event) => setStarterAccounts(event.target.checked)}
          />
          <span>Создать счета Поштанска · RSD, Рубли · RUB и UK · GBP</span>
        </label>
        <button type="submit" className="button" disabled={saving} aria-busy={saving}>
          Продолжить
        </button>
        {error ? <p className="field-error">{error}</p> : null}
      </form>
    </section>
  );
}
