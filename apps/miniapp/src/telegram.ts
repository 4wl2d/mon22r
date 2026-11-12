import {
  backButton,
  hapticFeedback,
  init,
  miniApp,
  openLink,
  retrieveRawInitData,
  themeParams,
  viewport,
} from "@tma.js/sdk";

import { setInitData } from "./api";

const STORED_INIT_DATA = "mon22r.initData";

type Scheme = "light" | "dark";

/** Page colours per scheme, for the client chrome around the page. They mirror `--bg` and `--surface` in styles.css. */
const CHROME: Record<Scheme, { readonly page: `#${string}`; readonly bar: `#${string}` }> = {
  light: { page: "#f3f1ea", bar: "#fdfcf9" },
  dark: { page: "#141512", bar: "#1d1e1a" },
};

let inTelegram = false;

/**
 * Connects to the Telegram client: launch data for the API, the light or dark scheme the client uses,
 * viewport insets as CSS variables, and the client chrome painted in the page colour.
 * Outside Telegram the scheme follows the system, everything else here is a no-op,
 * and the API answers "no access", which the interface shows as such.
 */
export function bootTelegram(): void {
  setInitData(readInitData());
  trackKeyboard();
  try {
    init({ acceptCustomStyles: false });
    inTelegram = true;
  } catch {
    inTelegram = false;
  }
  followScheme();
  if (!inTelegram) return;
  void mountViewport();
  try {
    if (miniApp.mount.isAvailable()) miniApp.mount();
    paintChrome(currentScheme());
    if (miniApp.ready.isAvailable()) miniApp.ready();
  } catch {
    // The page palette does not depend on the client chrome.
  }
}

/** A light tap for a completed action, where the device supports it. */
export function hapticSuccess(): void {
  try {
    if (hapticFeedback.notificationOccurred.isAvailable()) hapticFeedback.notificationOccurred("success");
  } catch {
    // Haptics are decoration; a client without them changes nothing.
  }
}

export function hapticError(): void {
  try {
    if (hapticFeedback.notificationOccurred.isAvailable()) hapticFeedback.notificationOccurred("error");
  } catch {
    // See hapticSuccess.
  }
}

/** The tick of a choice changing: a tab, a chip, a month. */
export function hapticSelect(): void {
  try {
    if (hapticFeedback.selectionChanged.isAvailable()) hapticFeedback.selectionChanged();
  } catch {
    // See hapticSuccess.
  }
}

/** Opens a page outside the Mini App, through the client when it offers that. */
export function openExternal(url: string): void {
  try {
    if (openLink.isAvailable()) {
      openLink(url);
      return;
    }
  } catch {
    // Fall through to the browser.
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** True when the Mini App can hand the screen back to the chat. */
export function canReturnToChat(): boolean {
  try {
    return inTelegram && miniApp.close.isAvailable();
  } catch {
    return false;
  }
}

/** Closes the Mini App, which leaves the owner in the chat with the keyboard one tap away. */
export function returnToChat(): void {
  try {
    if (miniApp.close.isAvailable()) miniApp.close();
  } catch {
    // Nothing to close outside Telegram.
  }
}

const backHandlers: (() => void)[] = [];
let backBound = false;

/**
 * Routes the client's back button (and the hardware one on Android) to `handler` while something is open
 * on top of the screen. Without it, "back" closes the whole Mini App. Returns the function that releases it.
 */
export function holdBackButton(handler: () => void): () => void {
  backHandlers.push(handler);
  syncBackButton();
  return () => {
    const index = backHandlers.lastIndexOf(handler);
    if (index !== -1) backHandlers.splice(index, 1);
    syncBackButton();
  };
}

function syncBackButton(): void {
  if (!inTelegram) return;
  try {
    if (!backButton.isMounted() && backButton.mount.isAvailable()) backButton.mount();
    if (!backBound && backButton.onClick.isAvailable()) {
      backButton.onClick(() => backHandlers[backHandlers.length - 1]?.());
      backBound = true;
    }
    if (backHandlers.length > 0) {
      if (backButton.show.isAvailable()) backButton.show();
    } else if (backButton.hide.isAvailable()) {
      backButton.hide();
    }
  } catch {
    // A client without the button still has the close control inside every sheet.
  }
}

/**
 * Launch data arrives in the URL fragment. A reload inside the client can drop the fragment,
 * so the last value is kept for the session.
 */
function readInitData(): string {
  let raw = "";
  try {
    raw = retrieveRawInitData() ?? "";
  } catch {
    raw = "";
  }
  if (raw.length === 0) return recallInitData();
  try {
    window.sessionStorage.setItem(STORED_INIT_DATA, raw);
  } catch {
    // Storage can be unavailable in a locked-down web view.
  }
  return raw;
}

function recallInitData(): string {
  try {
    return window.sessionStorage.getItem(STORED_INIT_DATA) ?? "";
  } catch {
    return "";
  }
}

/** The client's scheme when it states a background colour, otherwise the system's. */
function currentScheme(): Scheme {
  try {
    if (inTelegram && themeParams.bgColor() !== undefined) return themeParams.isDark() ? "dark" : "light";
  } catch {
    // Fall through to the system preference.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyScheme(): void {
  const scheme = currentScheme();
  document.documentElement.dataset.theme = scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", CHROME[scheme].page);
  paintChrome(scheme);
}

function followScheme(): void {
  try {
    if (inTelegram && themeParams.mount.isAvailable()) {
      themeParams.mount();
      themeParams.state.sub(applyScheme);
    }
  } catch {
    // The system preference below still applies.
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyScheme);
  applyScheme();
}

function paintChrome(scheme: Scheme): void {
  if (!inTelegram) return;
  const colors = CHROME[scheme];
  try {
    if (miniApp.setHeaderColor.isAvailable()) miniApp.setHeaderColor(colors.page);
    if (miniApp.setBgColor.isAvailable()) miniApp.setBgColor(colors.page);
    if (miniApp.setBottomBarColor.isAvailable()) miniApp.setBottomBarColor(colors.bar);
  } catch {
    // The page palette does not depend on the client chrome.
  }
}

async function mountViewport(): Promise<void> {
  try {
    if (viewport.mount.isAvailable()) {
      await viewport.mount();
      // Publishes --tg-viewport-safe-area-inset-* and keeps them current.
      if (viewport.bindCssVars.isAvailable() && !viewport.isCssVarsBound()) viewport.bindCssVars();
    }
    if (viewport.expand.isAvailable()) viewport.expand();
  } catch {
    // env(safe-area-inset-*) still applies when the client does not answer.
  }
}

/**
 * Publishes the height the on-screen keyboard covers as `--keyboard`, so a sheet can sit above it.
 * Where the keyboard resizes the page instead of covering it, the value stays zero.
 */
function trackKeyboard(): void {
  const visual = window.visualViewport;
  if (!visual) return;
  const update = () => {
    const covered = Math.max(0, Math.round(window.innerHeight - visual.height - visual.offsetTop));
    document.documentElement.style.setProperty("--keyboard", `${covered}px`);
  };
  visual.addEventListener("resize", update);
  visual.addEventListener("scroll", update);
  update();
}
