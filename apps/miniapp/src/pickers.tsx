import { useMemo, useState } from "react";

import { currencyName, deviceTimeZone, formatUtcOffset, listCurrencies, listTimeZones } from "./format";
import { Chips, Icon, Sheet } from "./ui";

export const COMMON_CURRENCIES = ["EUR", "RSD", "RUB", "GBP", "USD"] as const;
const OTHER = "other";

type Option = { readonly id: string; readonly label: string; readonly hint: string };

/** A searchable list of choices in a sheet. Picking one answers and leaves the closing to the caller. */
function PickerSheet({
  title,
  options,
  value,
  searchLabel,
  onPick,
  onClose,
}: {
  title: string;
  options: readonly Option[];
  value: string;
  searchLabel: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown =
    needle === ""
      ? options
      : options.filter((option) => `${option.label} ${option.hint}`.toLowerCase().includes(needle));
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="search">
        <Icon name="search" small />
        <input
          type="search"
          value={query}
          placeholder={searchLabel}
          aria-label={searchLabel}
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // The sheet can sit inside a form; Enter in the search must not submit it.
            if (event.key === "Enter") event.preventDefault();
          }}
        />
      </div>
      <div className="card rows options">
        {shown.map((option) => (
          <button
            key={option.id}
            type="button"
            className="option"
            aria-pressed={option.id === value}
            onClick={() => onPick(option.id)}
          >
            <span>
              {option.label}
              {option.hint ? <small>{option.hint}</small> : null}
            </span>
            {option.id === value ? <Icon name="check" /> : null}
          </button>
        ))}
        {shown.length === 0 ? <p className="row muted">Ничего не найдено.</p> : null}
      </div>
    </Sheet>
  );
}

export function CurrencySheet({
  title,
  value,
  onPick,
  onClose,
}: {
  title: string;
  value: string;
  onPick: (currency: string) => void;
  onClose: () => void;
}) {
  const options = useMemo(() => {
    const codes = new Set([...COMMON_CURRENCIES, ...listCurrencies()]);
    return [...codes].map((code) => ({ id: code, label: code, hint: currencyName(code) }));
  }, []);
  return (
    <PickerSheet
      title={title}
      options={options}
      value={value}
      searchLabel="Код или название"
      onPick={onPick}
      onClose={onClose}
    />
  );
}

export function TimeZoneSheet({
  value,
  onPick,
  onClose,
}: {
  value: string;
  onPick: (timeZone: string) => void;
  onClose: () => void;
}) {
  const options = useMemo(() => {
    const device = deviceTimeZone();
    // The device's zone and the current one come first: they are the likely answers.
    const zones = new Set([...(device === null ? [] : [device]), value, ...listTimeZones()]);
    const now = new Date();
    return [...zones].map((zone) => ({
      id: zone,
      label: zone.replaceAll("_", " "),
      hint: `${formatUtcOffset(zone, now)}${zone === device ? " · как на этом устройстве" : ""}`,
    }));
  }, [value]);
  return (
    <PickerSheet
      title="Часовой пояс"
      options={options}
      value={value}
      searchLabel="Город или регион"
      onPick={onPick}
      onClose={onClose}
    />
  );
}

/** The usual currencies one tap away, and every other one behind "Другая". */
export function CurrencyChoice({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (currency: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const uncommon = value !== "" && !COMMON_CURRENCIES.some((code) => code === value);
  const options = [
    ...COMMON_CURRENCIES.map((code) => ({ id: code, label: code })),
    { id: OTHER, label: uncommon ? value : "Другая" },
  ];
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <Chips
        options={options}
        value={uncommon ? OTHER : value}
        label={label}
        wrap
        disabled={disabled}
        onChange={(id) => {
          if (id === OTHER) setPicking(true);
          else onChange(id);
        }}
      />
      {picking ? (
        <CurrencySheet
          title={label}
          value={value}
          onPick={(currency) => {
            onChange(currency);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}
