import type { Account, Category } from "@mon22r/domain";
import { type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { addMonths, formatMonthTitle, type MonthPoint, sameMonth } from "./format";
import { hapticSelect, holdBackButton } from "./telegram";

const ICONS = {
  back: "M15 5l-7 7 7 7",
  forward: "M9 5l7 7-7 7",
  close: "M6 6l12 12M18 6L6 18",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5l4.5 4.5L19 7.5",
  month: "M5 20V11M12 20V4M19 20v-6",
  entries: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, small = false }: { name: IconName; small?: boolean }) {
  return (
    <svg className={small ? "icon small" : "icon"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  );
}

/**
 * What a screen says when it has nothing to list or could not load, with one way forward.
 * Announced to screen readers; a problem interrupts, the rest waits its turn.
 */
export function Notice({
  title,
  text,
  action,
  tone = "plain",
}: {
  title?: string;
  text: ReactNode;
  action?: { readonly label: string; readonly onClick: () => void };
  tone?: "plain" | "problem";
}) {
  return (
    <div className="card notice" role={tone === "problem" ? "alert" : "status"}>
      {title ? <p className="notice-title">{title}</p> : null}
      <p>{text}</p>
      {action ? (
        <button type="button" className={tone === "problem" ? "button" : "button secondary"} onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/** Grey blocks in the shape of the cards to come, shown only until the first answer arrives. */
export function Skeleton({ blocks }: { blocks: readonly number[] }) {
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-label="Загрузка">
      {blocks.map((height, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are a fixed, unordered placeholder.
        <span key={index} className="skeleton-block" style={{ height }} />
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
  const go = (next: MonthPoint) => {
    hapticSelect();
    onChange(next);
  };
  return (
    <div className="switcher">
      <button
        type="button"
        className="icon-button"
        aria-label="Месяц раньше"
        disabled={atStart}
        onClick={() => go(addMonths(point, -1))}
      >
        <Icon name="back" />
      </button>
      <button
        type="button"
        className={busy ? "month-label busy" : "month-label"}
        disabled={current}
        aria-label={current ? formatMonthTitle(point) : `${formatMonthTitle(point)}, вернуться к текущему месяцу`}
        onClick={() => go(today)}
      >
        {formatMonthTitle(point)}
        {current ? null : <span className="month-hint">к текущему месяцу</span>}
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Месяц позже"
        disabled={atEnd}
        onClick={() => go(addMonths(point, 1))}
      >
        <Icon name="forward" />
      </button>
    </div>
  );
}

export type ChipOption = { readonly id: string; readonly label: string; readonly count?: number };

/** A set of choices, at most one of which is on. In a row it scrolls sideways; wrapped it shows them all. */
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
          <span>{option.label}</span>
          {option.count === undefined ? null : <span className="chip-count">{option.count}</span>}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * A panel that rises over the screen for one object and what can be done with it.
 * It is a modal dialog: focus stays inside, Escape, the scrim, the close control,
 * and the Telegram back button all close it. The parent renders it only while it is open.
 */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    const release = holdBackButton(() => close.current());
    return () => {
      release();
      if (element?.open) element.close();
    };
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click is the scrim; the keyboard closes with Escape (onCancel) or the close control.
    <dialog
      ref={dialog}
      className="sheet"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click that lands on the dialog itself is a click on the scrim around the panel.
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="sheet-frame">
        <div className="sheet-head">
          <h2 className="sheet-title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </dialog>
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
      className={armed ? "button danger armed" : "button danger"}
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

/** An on/off setting. */
export function Switch({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function FieldError({ text }: { text: string }) {
  if (text === "") return null;
  return (
    <p className="field-error" role="alert">
      {text}
    </p>
  );
}

const TOAST_MS = 2600;
let toastMessage: { readonly text: string; readonly id: number } | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const toastListeners = new Set<() => void>();

function publishToast(next: typeof toastMessage): void {
  toastMessage = next;
  for (const listener of toastListeners) listener();
}

/** Confirms a finished action in a line that goes away by itself. */
export function showToast(text: string): void {
  clearTimeout(toastTimer);
  publishToast({ text, id: Date.now() });
  toastTimer = setTimeout(() => publishToast(null), TOAST_MS);
}

/** The place toasts appear. Rendered once, above the navigation. */
export function Toaster() {
  const message = useSyncExternalStore(
    (listener) => {
      toastListeners.add(listener);
      return () => toastListeners.delete(listener);
    },
    () => toastMessage,
  );
  return (
    <div role="status" aria-live="polite">
      {message ? (
        <div className="toast" key={message.id}>
          {message.text}
        </div>
      ) : null}
    </div>
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

export function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name, "ru");
}
