import { app } from "electron";
import path from "node:path";

// Every Helm data-store lib (config.js, mates.js, helmRoutines.js, etc.)
// resolves its file as `process.env.HELM_*_PATH || path.join(__dirname, "..",
// "..", "<file>")` — a plain JSON file next to the app, which works great in
// dev (repo root) but in a packaged electron-builder build resolves INSIDE
// the read-only app.asar, so every write throws ENOENT (caught + non-fatal
// per store, so the app still runs, but config/mates/routines/usage/etc. can
// never actually persist).
//
// Fix: in a packaged build, redirect every store's env-var seam to a file
// under Electron's own per-install writable directory (`userData`) instead —
// its OWN data dir, deliberately NOT shared with dev's repo-root files
// (Aidin's call). Dev (app.isPackaged === false) leaves everything unset, so
// every lib keeps using its existing repo-root default, completely unchanged.
//
// This must run BEFORE any store lib's module body evaluates (that's where
// each `const xPath = process.env.HELM_X_PATH || ...` constant is computed —
// once, at import time, not per-call). As an ES module this file's top-level
// code runs during ITS OWN module evaluation, so as long as main.js imports
// this file FIRST (before any lib that reads one of these env vars,
// including transitively — e.g. sessions.js imports config.js), the env vars
// are already set by the time those modules load. Setting them later, e.g.
// inside app.whenReady(), would be too late: by then every store lib up the
// import graph has already been evaluated and its path constant already
// captured the (unset) default.
//
// Deliberately NOT a top-level `import { app } from "electron"` in any store
// lib itself — those files are also loaded by pure-node unit tests (via
// their HELM_*_PATH seams) outside any Electron context, and an `electron`
// import there would break them. Only this dedicated bootstrap file (loaded
// solely from main.js, which already runs inside Electron's main process)
// touches `electron`.
if (app.isPackaged) {
  const userDataDir = app.getPath("userData");

  const setIfUnset = (envVar, fileName) => {
    if (!process.env[envVar]) {
      process.env[envVar] = path.join(userDataDir, fileName);
    }
  };

  setIfUnset("HELM_CONFIG_PATH", "config.json");
  setIfUnset("HELM_DOMAINS_PATH", "domains.json");
  setIfUnset("HELM_GOAL_RUN_HISTORY_PATH", "goal-run-history.json");
  setIfUnset("HELM_MATES_PATH", "mates.json");
  setIfUnset("HELM_SECOND_MATES_PATH", "second-mates.json");
  setIfUnset("HELM_ROUTINES_PATH", "routines.json");
  setIfUnset("HELM_USAGE_PATH", "helm-usage.jsonl");
  setIfUnset("HELM_USAGE_LOG_PATH", "usage-log.jsonl");
  setIfUnset("HELM_IMAGES_DIR", "pasted-images");
}
