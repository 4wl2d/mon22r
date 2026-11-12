import type { Account, Category } from "@mon22r/domain";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { addMonths, formatMonthTitle, type MonthPoint, sameMonth } from "./format";

/** A sentence about the state of the screen, with an optional way out. Announced to screen readers. */
export function Notice({
  text,
  action,
  tone = "plain",
}: {
  text: string;
  action?: { readonly label: string; readonly onClick: () => void };
  tone?: "plain" | "problem";
}) {
  return (
    <div className={tone === "problem" ? "notice problem" : "notice"} role={tone === "problem" ? "alert" : "status"}>
      <p>{text}</p>
      {action ? (
        <button type="button" className="button" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

const SKELETON_WIDTHS = [88, 71, 54, 79, 62, 85, 68, 51, 74, 57] as const;

/** Grey bars in the shape of the content, shown only until the first answer arrives. */
export function Skeleton({ lines }: { lines: number }) {
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-label="Загрузка">
      {SKELETON_WIDTHS.slice(0, lines).map((width) => (
        <span key={width} style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

export function MonthSwitcher({
  point,
  today,
  busy,
  onChange,
}: {
  point: MonthPoint;
  today: MonthPoint;
  busy: boolean;
  onChange: (point: MonthPoint) => void;
}) {
  const atStart = point.year <= 1 && point.month <= 1;
  const atEnd = point.year >= 9999 && point.month >= 12;
  const current = sameMonth(point, today);
  return (
    <div className="switcher">
      <button
        type="button"
        className="step"
        aria-label="Месяц раньше"
        disabled={atStart}
        onClick={() => onChange(addMonths(point, -1))}
      >
        ‹
      </button>
      <button
        type="button"
        className={busy ? "month-label busy" : "month-label"}
        disabled={current}
        aria-label={current ? formatMonthTitle(point) : `${formatMonthTitle(point)}, вернуться к текущему месяцу`}
        onClick={() => onChange(today)}
      >
        {formatMonthTitle(point)}
        {current ? null : <span className="month-hint">к текущему</span>}
      </button>
      <button
        type="button"
        className="step"
        aria-label="Месяц позже"
        disabled={atEnd}
        onClick={() => onChange(addMonths(point, 1))}
      >
        ›
      </button>
    </div>
  );
}

export type ChipOption = { readonly id: string; readonly label: string; readonly count?: number };

/** One row of choices, exactly one of which is on. Scrolls sideways when it does not fit. */
export function Chips({
  options,
  value,
  label,
  wrap = false,
  disabled = false,
  onChange,
}: {
  options: readonly ChipOption[];
  value: string | null;
  label: string;
  wrap?: boolean;
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <fieldset className={wrap ? "chips wrap" : "chips"}>
      <legend className="visually-hidden">{label}</legend>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="chip"
          aria-pressed={option.id === value}
          disabled={disabled}
          onClick={() => onChange(option.id)}
        >
          {option.label}
          {option.count === undefined ? null : <span className="chip-count">{option.count}</span>}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * A destructive action that needs a second tap. The first tap arms it and says what will happen;
 * it disarms by itself after a few seconds.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={armed ? "text-button danger" : "text-button"}
      disabled={disabled}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

/**
 * Text that turns into an input when tapped. Enter or leaving the field saves, Escape cancels.
 * `save` returns an error sentence to keep the field open, or null when the value was accepted.
 */
export function InlineEdit({
  value,
  display,
  label,
  inputMode,
  maxLength,
  save,
}: {
  value: string;
  display?: ReactNode;
  label: string;
  inputMode?: "text" | "decimal";
  maxLength?: number;
  save: (next: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const cancelled = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        className="editable"
        aria-label={`${label}: ${value}. Изменить`}
        onClick={() => {
          setDraft(value);
          setError("");
          setEditing(true);
        }}
      >
        {display ?? value}
      </button>
    );
  }

  async function commit() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = draft.trim();
    if (next === value.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const problem = await save(next);
    setSaving(false);
    if (problem === null) setEditing(false);
    else setError(problem);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") {
      cancelled.current = true;
      setEditing(false);
      setError("");
    }
  }

  return (
    <span className="inline-edit">
      <input
        ref={input}
        value={draft}
        aria-label={label}
        aria-invalid={error !== ""}
        inputMode={inputMode ?? "text"}
        maxLength={maxLength ?? 80}
        disabled={saving}
        enterKeyHint="done"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={onKeyDown}
      />
      {error ? <span className="field-error">{error}</span> : null}
    </span>
  );
}

export function categoryLabel(categories: readonly Category[], id: string | null): string {
  if (id === null) return "без категории";
  return categories.find((category) => category.id === id)?.name ?? "категория";
}

export function accountLabel(accounts: readonly Account[], id: string | null): string {
  if (id === null) return "счёт не выбран";
  return accounts.find((account) => account.id === id)?.name ?? "счёт";
}
