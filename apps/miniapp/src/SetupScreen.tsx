import type { User } from "@mon22r/domain";
import { type FormEvent, useState } from "react";

import { errorText, setup } from "./api";
import { isTimeZone } from "./format";
import { hapticError, hapticSuccess } from "./telegram";

const CURRENCIES = ["EUR", "RSD", "RUB", "GBP"] as const;
const DEFAULT_ZONE = "Europe/Belgrade";

export function SetupScreen({ user, onReady }: { user: User | null; onReady: () => void }) {
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
      await setup({ homeCurrency, timeZone: zone, starterAccounts });
      hapticSuccess();
      onReady();
    } catch (caught) {
      hapticError();
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
        <label>
          Часовой пояс
          <input
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
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
          {saving ? "Сохраняю…" : "Продолжить"}
        </button>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
