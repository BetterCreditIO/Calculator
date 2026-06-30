/**
 * Auto-update integration (desktop only).
 *
 * On startup the app silently checks the configured update endpoint; if a newer
 * signed release is available it asks the user to install. A manual check is
 * also exposed for the app menu. All failures are swallowed in silent mode so a
 * missing/unreachable endpoint never disrupts the user.
 */
import { useCallback, useEffect } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@/lib/tauri";
import { toast, useToastStore } from "@/hooks/use-toast";

async function runUpdateCheck(silent: boolean): Promise<void> {
  if (!isTauri()) {
    if (!silent) toast.show("Updates", "Available only in the desktop app.");
    return;
  }
  try {
    // The updater plugin is loaded on demand so it never runs in the browser.
    const { check } = await import("@tauri-apps/plugin-updater");

    const update = await check();
    if (!update) {
      if (!silent) toast.success("You're up to date");
      return;
    }

    const proceed = await ask(
      `Version ${update.version} is available. Install it now? The app will restart to finish.`,
      { title: "Update available", kind: "info" },
    );
    if (!proceed) return;

    const installing = toast.show("Downloading update…", "This may take a moment.");
    await update.downloadAndInstall();
    // On Windows the installer relaunches the app; this toast is a fallback.
    useToastStore.getState().dismiss(installing);
    toast.success("Update installed", "Restart to apply if not automatic.");
  } catch (err) {
    if (!silent) {
      toast.error(
        "Update check failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/** Imperative manual check for the app menu. */
export function checkForUpdates(): void {
  void runUpdateCheck(false);
}

/** Silent check shortly after launch. */
export function useAutoUpdate(): void {
  useEffect(() => {
    const t = setTimeout(() => void runUpdateCheck(true), 4000);
    return () => clearTimeout(t);
  }, []);
}

export { runUpdateCheck };

/** Hook wrapper so components can trigger a manual check via callback. */
export function useManualUpdateCheck() {
  return useCallback(() => void runUpdateCheck(false), []);
}
