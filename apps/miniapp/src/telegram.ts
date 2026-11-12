import { hapticFeedback, init, miniApp, openLink, retrieveRawInitData, viewport } from "@tma.js/sdk";

import { setInitData } from "./api";

const CHROME = "#161814";
const STORED_INIT_DATA = "mon22r.initData";

/**
 * Connects to the Telegram client: launch data for the API, viewport insets as CSS variables,
 * and the client chrome painted in the page colour. Outside Telegram everything here is a no-op
 * and the API answers "no access", which the interface shows as such.
 */
export function bootTelegram(): void {
  setInitData(readInitData());
  try {
    init({ acceptCustomStyles: false });
  } catch {
    return;
  }
  void mountViewport();
  paintChrome();
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

function paintChrome(): void {
  try {
    if (miniApp.mount.isAvailable()) miniApp.mount();
    if (miniApp.setHeaderColor.isAvailable()) miniApp.setHeaderColor(CHROME);
    if (miniApp.setBgColor.isAvailable()) miniApp.setBgColor(CHROME);
    if (miniApp.setBottomBarColor.isAvailable()) miniApp.setBottomBarColor(CHROME);
    if (miniApp.ready.isAvailable()) miniApp.ready();
  } catch {
    // The page palette does not depend on the client chrome.
  }
}
