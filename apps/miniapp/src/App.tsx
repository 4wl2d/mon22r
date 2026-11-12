import type { Account, Category, User } from "@mon22r/domain";
import { useCallback, useEffect, useMemo, useState } from "react";

import { errorText, getMe, type Me } from "./api";
import { FeedScreen } from "./FeedScreen";
import { currentMonth, type MonthPoint } from "./format";
import { MonthScreen } from "./MonthScreen";
import { SettingsScreen } from "./SettingsScreen";
import { SetupScreen } from "./SetupScreen";
import { refreshVisible } from "./store";
import { Notice, Skeleton } from "./ui";

type Screen = "month" | "feed" | "settings";

const TABS: readonly { id: Screen; label: string }[] = [
  { id: "month", label: "Месяц" },
  { id: "feed", label: "Лента" },
  { id: "settings", label: "Настройки" },
];

/** What the screens share about the owner: profile, accounts, categories, and the default account. */
export type Ledger = {
  readonly user: User;
  readonly accounts: readonly Account[];
  readonly categories: readonly Category[];
  readonly defaultAccountId: string | null;
  readonly version: string;
};

export type LedgerChange = (next: (current: Ledger) => Ledger) => void;

type Gate =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "setup"; readonly user: User | null }
  | { readonly status: "ready"; readonly ledger: Ledger };

function gateFrom(me: Me): Gate {
  if (!me.ready || me.user === null) return { status: "setup", user: me.user };
  return {
    status: "ready",
    ledger: {
      user: me.user,
      accounts: me.accounts,
      categories: me.categories,
      defaultAccountId: me.defaultAccountId,
      version: me.version,
    },
  };
}

export function App() {
  const [gate, setGate] = useState<Gate>({ status: "loading" });

  const load = useCallback((quiet: boolean) => {
    if (!quiet) setGate({ status: "loading" });
    getMe().then(
      (me) => setGate(gateFrom(me)),
      (error: unknown) => {
        // A background refresh that fails leaves the working screen alone.
        if (!quiet) setGate({ status: "error", message: errorText(error, "Не удалось открыть учёт.") });
      },
    );
  }, []);

  useEffect(() => load(false), [load]);

  // Coming back from the chat: entries and categories may have changed there.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      load(true);
      refreshVisible();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const change: LedgerChange = useCallback((next) => {
    setGate((current) => (current.status === "ready" ? { status: "ready", ledger: next(current.ledger) } : current));
  }, []);

  if (gate.status === "ready") return <ReadyApp ledger={gate.ledger} onChange={change} />;
  return (
    <div className="app">
      <main className="scroll">
        <p className="wordmark">mon22r</p>
        {gate.status === "loading" ? <Skeleton lines={5} /> : null}
        {gate.status === "error" ? (
          <Notice tone="problem" text={gate.message} action={{ label: "Повторить", onClick: () => load(false) }} />
        ) : null}
        {gate.status === "setup" ? <SetupScreen user={gate.user} onReady={() => load(false)} /> : null}
      </main>
    </div>
  );
}

function ReadyApp({ ledger, onChange }: { ledger: Ledger; onChange: LedgerChange }) {
  const [screen, setScreen] = useState<Screen>("month");
  const today = useMemo(() => currentMonth(ledger.user.timeZone), [ledger.user.timeZone]);
  const [month, setMonth] = useState<MonthPoint>(today);
  // "all", "none" for uncategorized, or a category id. The month screen sets it when a category is tapped.
  const [feedFilter, setFeedFilter] = useState("all");

  return (
    <div className="app">
      <main className="scroll with-nav">
        {screen === "month" ? (
          <MonthScreen
            ledger={ledger}
            point={month}
            today={today}
            onMonth={setMonth}
            onOpenCategory={(categoryId) => {
              setFeedFilter(categoryId ?? "none");
              setScreen("feed");
            }}
          />
        ) : null}
        {screen === "feed" ? (
          <FeedScreen
            ledger={ledger}
            onLedger={onChange}
            point={month}
            today={today}
            onMonth={setMonth}
            filter={feedFilter}
            onFilter={setFeedFilter}
          />
        ) : null}
        {screen === "settings" ? <SettingsScreen ledger={ledger} onLedger={onChange} /> : null}
      </main>
      <nav className="nav" aria-label="Разделы">
        <div className="nav-row">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={screen === tab.id ? "page" : undefined}
              onClick={() => {
                if (tab.id === "feed" && screen !== "feed") setFeedFilter("all");
                setScreen(tab.id);
                window.scrollTo(0, 0);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
