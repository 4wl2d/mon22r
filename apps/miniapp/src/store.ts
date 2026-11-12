import { useCallback, useEffect, useSyncExternalStore } from "react";

import { errorText } from "./api";

/**
 * A small cache for server reads, shared by every screen.
 * A screen shows what is cached at once and refreshes it in the background, so switching tabs or months
 * does not blank the page; an error keeps the last good data on screen.
 */
type Entry = {
  readonly data: unknown;
  readonly error: string | null;
  readonly loading: boolean;
  readonly loadedAt: number;
};

const FRESH_MS = 20_000;
const EMPTY: Entry = { data: undefined, error: null, loading: false, loadedAt: 0 };

const entries = new Map<string, Entry>();
const loaders = new Map<string, { readonly load: () => Promise<unknown>; readonly fallback: string }>();
const listeners = new Map<string, Set<() => void>>();
const requests = new Map<string, number>();

function publish(key: string, entry: Entry): void {
  entries.set(key, entry);
  for (const listener of listeners.get(key) ?? []) listener();
}

function subscribe(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

async function refresh(key: string): Promise<void> {
  const source = loaders.get(key);
  if (source === undefined) return;
  // Only the newest request for a key may write its answer.
  const ticket = (requests.get(key) ?? 0) + 1;
  requests.set(key, ticket);
  const current = entries.get(key) ?? EMPTY;
  publish(key, { ...current, loading: true });
  try {
    const data = await source.load();
    if (requests.get(key) !== ticket) return;
    publish(key, { data, error: null, loading: false, loadedAt: Date.now() });
  } catch (error) {
    if (requests.get(key) !== ticket) return;
    const previous = entries.get(key) ?? EMPTY;
    publish(key, { ...previous, error: errorText(error, source.fallback), loading: false });
  }
}

export type Query<T> = {
  readonly data: T | undefined;
  readonly error: string | null;
  /** True while a request is in flight, including a background refresh of data already shown. */
  readonly loading: boolean;
  readonly reload: () => void;
  /** Replaces the cached value after a successful write, without a round trip. */
  readonly update: (next: (current: T) => T) => void;
};

export function useQuery<T>(key: string, load: () => Promise<T>, fallback: string): Query<T> {
  loaders.set(key, { load, fallback });
  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(key, listener), [key]),
    () => entries.get(key) ?? EMPTY,
  );

  useEffect(() => {
    const cached = entries.get(key);
    if (cached === undefined || Date.now() - cached.loadedAt > FRESH_MS) void refresh(key);
  }, [key]);

  const reload = useCallback(() => void refresh(key), [key]);
  const update = useCallback(
    (next: (current: T) => T) => {
      const current = entries.get(key);
      if (current === undefined || current.data === undefined) return;
      publish(key, { ...current, data: next(current.data as T) });
    },
    [key],
  );
  return { data: entry.data as T | undefined, error: entry.error, loading: entry.loading, reload, update };
}

/** Marks cached reads as outdated. Those on screen reload now; the rest reload when they are shown next. */
export function invalidate(prefix: string): void {
  for (const [key, entry] of entries) {
    if (!key.startsWith(prefix)) continue;
    entries.set(key, { ...entry, loadedAt: 0 });
    if (listeners.has(key)) void refresh(key);
  }
}

/** Refreshes what is on screen. Called when the user comes back from the chat. */
export function refreshVisible(): void {
  for (const key of listeners.keys()) void refresh(key);
}

/** Drops everything. Tests use it between cases. */
export function resetStore(): void {
  entries.clear();
  loaders.clear();
  requests.clear();
}
