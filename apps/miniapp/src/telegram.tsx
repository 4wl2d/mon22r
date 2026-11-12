import { init, miniApp, retrieveLaunchParams, retrieveRawInitData, viewport } from "@tma.js/sdk";
import { useLaunchParams, useRawInitData, useSignal } from "@tma.js/sdk-react";
import { useEffect } from "react";
import type { CSSProperties } from "react";
import { setInitData } from "./api";

export type TelegramBoot = {
  readonly insideTelegram: boolean;
};

export type Insets = {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
};

const CHROME = "#161814";

let boot: TelegramBoot | null = null;

export function bootTelegram(): TelegramBoot {
  if (boot) return boot;
  try {
    init({ acceptCustomStyles: false });
  } catch {
    boot = { insideTelegram: false };
    return boot;
  }
  rememberInitData(retrieveRawInitData(), rawFromLaunch());
  void mountViewport();
  paintChrome();
  boot = { insideTelegram: true };
  return boot;
}

export function useTelegramInsets(): Insets {
  const safe = useSignal(viewport.safeAreaInsets);
  const content = useSignal(viewport.contentSafeAreaInsets);
  return {
    top: safe.top + content.top,
    right: safe.right + content.right,
    bottom: safe.bottom + content.bottom,
    left: safe.left + content.left,
  };
}

export function insetStyle(insets: Insets): CSSProperties {
  return {
    "--safe-top": `${insets.top}px`,
    "--safe-right": `${insets.right}px`,
    "--safe-bottom": `${insets.bottom}px`,
    "--safe-left": `${insets.left}px`,
  } as CSSProperties;
}

export function LaunchParamsAuth(): null {
  const launchParams = useLaunchParams();
  const rawInitData = useRawInitData();
  useEffect(() => {
    const data: unknown = launchParams.tgWebAppData;
    rememberInitData(rawInitData, typeof data === "string" ? data : "");
  }, [launchParams, rawInitData]);
  return null;
}

function rawFromLaunch(): string {
  try {
    const launchParams = retrieveLaunchParams();
    const data: unknown = launchParams.tgWebAppData;
    return typeof data === "string" ? data : "";
  } catch {
    return "";
  }
}

function rememberInitData(raw: string | undefined, fallback: string): void {
  if (typeof raw === "string" && raw.length > 0) {
    setInitData(raw);
    return;
  }
  if (fallback.length > 0) setInitData(fallback);
}

async function mountViewport(): Promise<void> {
  try {
    if (viewport.mount.isAvailable()) {
      await viewport.mount();
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
