import type { User } from "@mon22r/domain";
import { type FormEvent, useState } from "react";

import { errorText, setup } from "./api";
import { deviceTimeZone, formatUtcOffset } from "./format";
import { CurrencyChoice, TimeZoneSheet } from "./pickers";
import { hapticError, hapticSuccess } from "./telegram";
import { FieldError, Icon } from "./ui";

const DEFAULT_ZONE = "Europe/Belgrade";

/**
 * First run: the two things the ledger cannot guess for itself, then the door to the app.
 * The time zone starts from the device's, so most owners only choose a currency.
 */
export function SetupScreen({ user, onReady }: { user: User | null; onReady: () => void }) {
  const [currency, setCurrency] = useState(user?.homeCurrency ?? "");
  const [timeZone, setTimeZone] = useState(user?.timeZone ?? deviceTimeZone() ?? DEFAULT_ZONE);
  const [starterAccounts, setStarterAccounts] = useState(false);
  const [pickingZone, setPickingZone] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (currency === "") {
      setError("Выберите домашнюю валюту.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await setup({ homeCurrency: currency, timeZone, starterAccounts });
      hapticSuccess();
      onReady();
    } catch (caught) {
      hapticError();
      setError(errorText(caught, "Не удалось сохранить настройку."));
      setSaving(false);
    }
  }

  return (
    <section>
      <p className="wordmark">mon22r</p>
      <p className="lead">Учёт расходов и доходов. Два вопроса, и можно начинать.</p>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <CurrencyChoice
          label="Домашняя валюта — в ней считается итог месяца"
          value={currency}
          disabled={saving}
          onChange={(next) => {
            setCurrency(next);
            setError("");
          }}
        />
        <div className="field">
          <span className="field-label">Часовой пояс — по нему делятся дни и месяцы</span>
          <div className="card">
            <button type="button" className="row" disabled={saving} onClick={() => setPickingZone(true)}>
              <span className="row-title">{timeZone.replaceAll("_", " ")}</span>
              <span className="row-value">
                {formatUtcOffset(timeZone)}
                <Icon name="forward" small />
              </span>
            </button>
          </div>
        </div>
        <label className="card check">
          <input
            type="checkbox"
            checked={starterAccounts}
            disabled={saving}
            onChange={(event) => setStarterAccounts(event.target.checked)}
          />
          <span>
            Создать стартовые счета
            <small>Поштанска · RSD, Рубли · RUB и UK · GBP. Названия можно изменить позже.</small>
          </span>
        </label>
        <FieldError text={error} />
        <button type="submit" className="button" disabled={saving} aria-busy={saving}>
          {saving ? "Сохраняю…" : "Начать"}
        </button>
      </form>
      {pickingZone ? (
        <TimeZoneSheet
          value={timeZone}
          onClose={() => setPickingZone(false)}
          onPick={(next) => {
            setTimeZone(next);
            setPickingZone(false);
          }}
        />
      ) : null}
    </section>
  );
}
