import { app, dialog } from "electron";

// Auto-update, PACKAGED-ONLY. In dev (`npm start` / restart-dev.sh) app.isPackaged is
// false, so electron-updater is never even imported - the dependency can be absent and dev
// still boots cleanly. When packaged, it checks GitHub Releases, downloads a newer version
// in the background, and prompts to restart when it is ready.
//
// NO TOKEN IS NEEDED, and this file spent months believing otherwise.
//
// It used to return early unless GH_TOKEN was set, on the stated grounds that "AidinD/helm
// is PRIVATE, so electron-updater can't read releases without one". The repo is public, and
// the belief was never re-checked after that changed - so the app shipped with self-update
// switched off and every launch logged "auto-update parked" instead. Measured 2026-08-23,
// with no credentials of any kind:
//
//   GET https://github.com/AidinD/helm/releases/latest/download/latest.yml  -> 200
//   HEAD .../Helm-Setup-0.2.82.exe                                          -> 200, 107 MB
//
// Which is the same arrangement Jot and Nib use, and why theirs have always worked.
//
// If Helm is ever made private again, this stops working and the right fix is NOT to embed
// a token in a shipped installer - anyone holding the installer can read it, and a token
// with repo scope reaches every other private repo too. Publish the installers to a
// separate public repo, or accept manual updates.
//
// See docs/installer-and-auto-update.md.

let started = false;

export async function initAutoUpdate() {
  // The whole point: dev never reaches the dynamic import below.
  if (started || !app.isPackaged) {
    return;
  }
  started = true;
  try {
    // electron-updater is CommonJS; under Node's ESM interop a named import
    // (`{ autoUpdater }`) resolves to undefined in a packaged build, so reach it
    // via the default export (this path only runs packaged, so dev never hit the
    // bug - the "Cannot set properties of undefined (autoDownload)" error).
    const updaterMod = await import("electron-updater");
    const autoUpdater = updaterMod.autoUpdater ?? updaterMod.default?.autoUpdater ?? updaterMod.default;
    if (!autoUpdater || typeof autoUpdater.checkForUpdates !== "function") {
      console.warn("[helm] auto-update unavailable (electron-updater export shape); skipping.");
      return;
    }
    autoUpdater.autoDownload = true;

    // EVERY outcome is logged, which is the half copied from Jot and Nib and the half that
    // was actually missing. Logging only errors makes "there is nothing newer" and "the
    // check never ran" produce the same silence - and that silence is exactly how this sat
    // switched off without anyone noticing. Each line below answers "what happened", so a
    // launch log can be read instead of guessed at.
    autoUpdater.on("checking-for-update", () => {
      console.info("[helm] auto-update: checking GitHub for a newer release");
    });
    autoUpdater.on("update-available", (info) => {
      console.info(`[helm] auto-update: ${info?.version || "a newer version"} available, downloading`);
    });
    autoUpdater.on("update-not-available", (info) => {
      console.info(`[helm] auto-update: already current (${info?.version || app.getVersion()})`);
    });
    autoUpdater.on("download-progress", (p) => {
      // Coarse on purpose: this fires continuously over a 100 MB download, and a log line
      // per chunk buries everything else in the same file.
      if (p && Math.round(p.percent) % 25 === 0) {
        console.info(`[helm] auto-update: downloading ${Math.round(p.percent)}%`);
      }
    });
    // Being offline is the common case and is not worth a dialog - same call as Nib makes.
    autoUpdater.on("error", (err) => console.error("[helm] auto-update error:", err?.message || err));

    // Helm's own dialog rather than checkForUpdatesAndNotify(), deliberately, and this is
    // where it should differ from Jot and Nib: Helm holds live sessions and dispatched
    // runs. The library's default installs on quit, which is right - but the app is left
    // open all day, so without a prompt a downloaded update could sit unapplied for a week.
    // Asking lets the restart happen at a moment when nothing is mid-run.
    autoUpdater.on("update-downloaded", async (info) => {
      console.info(`[helm] auto-update: ${info?.version || ""} downloaded, asking about restart`);
      const res = await dialog.showMessageBox({
        type: "info",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        message: `Helm ${info?.version || ""} is ready`,
        detail: "A new version has been downloaded. Restart to apply it, or keep working - it installs on quit either way.",
      });
      if (res.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });

    await autoUpdater.checkForUpdates();
    // Keep checking while the app stays open (every 6h).
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 6 * 60 * 60 * 1000);
  } catch (err) {
    console.error("[helm] auto-update init failed:", err?.message || err);
  }
}
