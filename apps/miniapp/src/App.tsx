import type { User } from "@mon22r/domain";
import { useEffect, useState } from "react";
import { AccountsScreen } from "./AccountsScreen";
import { errorText, getMe } from "./api";
import { FeedScreen } from "./FeedScreen";
import { currentMonth, type MonthPoint } from "./format";
import { MonthScreen } from "./MonthScreen";
import { PlansScreen } from "./PlansScreen";
import { SetupScreen } from "./SetupScreen";
import { insetStyle, LaunchParamsAuth, type TelegramBoot, useTelegramInsets } from "./telegram";
import { Status } from "./ui";

type Screen = "month" | "plans" | "feed" | "accounts";

const TABS: readonly { id: Screen; label: string }[] = [
  { id: "month", label: "Месяц" },
  { id: "plans", label: "Следующий месяц" },
  { id: "feed", label: "Лента" },
  { id: "accounts", label: "Счета" },
];

type Gate =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "setup"; readonly user: User | null }
  | { readonly status: "ready"; readonly user: User };

export function App({ telegram }: { telegram: TelegramBoot }) {
  const insets = useTelegramInsets();
  const [attempt, setAttempt] = useState(0);
  const [gate, setGate] = useState<Gate>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    getMe().then(
      (me) => {
        if (cancelled) return;
        if (me.ready && me.user) setGate({ status: "ready", user: me.user });
        else setGate({ status: "setup", user: me.user });
      },
      (error: unknown) => {
        if (!cancelled) setGate({ status: "error", message: errorText(error, "Не удалось открыть учёт.") });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const ready = gate.status === "ready";

  return (
    <div className="app" style={insetStyle(insets)}>
      {telegram.insideTelegram ? <LaunchParamsAuth /> : null}
      <div className={ready ? "scroll with-nav" : "scroll"}>
        <p className="wordmark">mon22r</p>
        {gate.status === "loading" ? <Status text="Загрузка." /> : null}
        {gate.status === "error" ? (
          <Status
            text={gate.message}
            action={{ label: "Повторить", onClick: () => setAttempt((value) => value + 1) }}
          />
        ) : null}
        {gate.status === "setup" ? (
          <SetupScreen user={gate.user} onReady={(user) => setGate({ status: "ready", user })} />
        ) : null}
        {gate.status === "ready" ? <ReadyApp user={gate.user} /> : null}
      </div>
    </div>
  );
}

function ReadyApp({ user }: { user: User }) {
  const [screen, setScreen] = useState<Screen>("month");
  const [month, setMonth] = useState<MonthPoint>(() => currentMonth(user.timeZone));

  return (
    <>
      {screen === "month" ? <MonthScreen point={month} onChange={setMonth} /> : null}
      {screen === "plans" ? <PlansScreen timeZone={user.timeZone} /> : null}
      {screen === "feed" ? <FeedScreen timeZone={user.timeZone} point={month} onChange={setMonth} /> : null}
      {screen === "accounts" ? <AccountsScreen /> : null}
      <nav className="nav" aria-label="Разделы">
        <div className="nav-row">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={screen === tab.id ? "page" : undefined}
              onClick={() => setScreen(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
