import { app, dialog } from "electron";

// Auto-update, PACKAGED-ONLY. In dev (`npm start` / restart-dev.sh) app.isPackaged
// is false, so electron-updater is never even imported - the dependency can be
// absent and dev still boots cleanly. When packaged, it checks GitHub Releases,
// downloads a newer version in the background, and prompts to restart when it's
// ready. AidinD/helm is PRIVATE, so electron-updater needs a GitHub token to read
// releases (GH_TOKEN env at build/run, or an embedded read-only token like
// Halyard uses) - see docs/installer-and-auto-update.md.

let started = false;

export async function initAutoUpdate() {
  // The whole point: dev never reaches the dynamic import below.
  if (started || !app.isPackaged) {
    return;
  }
  started = true;
  try {
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.on("update-downloaded", async (info) => {
      const res = await dialog.showMessageBox({
        type: "info",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        message: `Helm ${info?.version || ""} is ready`,
        detail: "A new version has been downloaded. Restart to apply it.",
      });
      if (res.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
    autoUpdater.on("error", (err) => console.error("[helm] auto-update error:", err?.message || err));
    await autoUpdater.checkForUpdates();
    // Keep checking while the app stays open (every 6h).
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 6 * 60 * 60 * 1000);
  } catch (err) {
    console.error("[helm] auto-update init failed:", err?.message || err);
  }
}
