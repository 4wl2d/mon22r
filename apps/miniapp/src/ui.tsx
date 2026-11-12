import { useCallback, useEffect, useRef, useState } from "react";
import type { Account, Category } from "@mon22r/domain";
import { errorText } from "./api";
import { addMonths, formatMonthTitle, type MonthPoint } from "./format";

export type Resource<T> =
  | { readonly status: "loading"; readonly data: null; readonly message: "" }
  | { readonly status: "error"; readonly data: null; readonly message: string }
  | { readonly status: "ready"; readonly data: T; readonly message: "" };

export function useResource<T>(
  key: string,
  load: () => Promise<T>,
  fallback: string,
): {
  resource: Resource<T>;
  reload: () => void;
  setData: (data: T) => void;
} {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [token, setToken] = useState(0);
  const [resource, setResource] = useState<Resource<T>>({ status: "loading", data: null, message: "" });

  useEffect(() => {
    let cancelled = false;
    setResource({ status: "loading", data: null, message: "" });
    loadRef.current().then(
      (data) => {
        if (!cancelled) setResource({ status: "ready", data, message: "" });
      },
      (error: unknown) => {
        if (!cancelled) setResource({ status: "error", data: null, message: errorText(error, fallback) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, token, fallback]);

  const reload = useCallback(() => setToken((value) => value + 1), []);
  const setData = useCallback((data: T) => setResource({ status: "ready", data, message: "" }), []);
  return { resource, reload, setData };
}

export function Status({
  text,
  action,
}: {
  text: string;
  action?: { readonly label: string; readonly onClick: () => void };
}) {
  return (
    <div className="status">
      <p>{text}</p>
      {action ? (
        <button type="button" className="button" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export function MonthSwitcher({
  point,
  onChange,
}: {
  point: MonthPoint;
  onChange: (point: MonthPoint) => void;
}) {
  const atStart = point.year <= 1 && point.month <= 1;
  const atEnd = point.year >= 9999 && point.month >= 12;
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
      <p className="month-label">{formatMonthTitle(point)}</p>
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

export function categoryLabel(categories: readonly Category[], id: string | null): string {
  if (id === null) return "без категории";
  return categories.find((category) => category.id === id)?.name ?? "неизвестная категория";
}

export function accountLabel(accounts: readonly Account[], id: string | null): string {
  if (id === null) return "счёт не выбран";
  return accounts.find((account) => account.id === id)?.name ?? "неизвестный счёт";
}
