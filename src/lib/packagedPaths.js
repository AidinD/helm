import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

// Every Helm data-store lib (config.js, mates.js, helmRoutines.js, etc.)
// resolves its file as `process.env.HELM_*_PATH || path.join(__dirname, "..",
// "..", "<file>")` — a plain JSON file next to the app, which works great in
// dev (repo root) but in a packaged electron-builder build resolves INSIDE
// the read-only app.asar, so every write throws ENOENT (caught + non-fatal
// per store, so the app still runs, but config/mates/routines/usage/etc. can
// never actually persist).
//
// Fix: in a packaged build, redirect every store's env-var seam to a SHARED
// data directory. Originally this pointed at Electron's per-install `userData`
// — deliberately independent — but that made the INSTALLED app start blank
// (Aidin: "installerade helm är helt tom när jag startar"): none of his groups,
// mates, or setup. The installed app is meant to be his real daily driver, so
// it now reads/writes a shared dir instead:
//
//   HELM_DATA_DIR  (if set)  — point this at a Dropbox-synced folder to share
//                              state across machines, or at the dev repo root
//                              (D:\Repo\Tools\helm) to share the EXACT files the
//                              dev app already uses.
//   ~/.helm        (default) — a stable per-user dir. On first run config.js
//                              still seeds groups from the Claude desktop app's
//                              own clusters (seedFromDesktopConfig), so it's not
//                              blank even before HELM_DATA_DIR is pointed
//                              somewhere with existing state.
//
// Dev (app.isPackaged === false) leaves everything unset, so every lib keeps
// using its existing repo-root default, completely unchanged.
//
// This must run BEFORE any store lib's module body evaluates (that's where
// each `const xPath = process.env.HELM_X_PATH || ...` constant is computed —
// once, at import time, not per-call). As an ES module this file's top-level
// code runs during ITS OWN module evaluation, so as long as main.js imports
// this file FIRST (before any lib that reads one of these env vars,
// including transitively — e.g. sessions.js imports config.js), the env vars
// are already set by the time those modules load.
//
// Deliberately NOT a top-level `import { app } from "electron"` in any store
// lib itself — those files are also loaded by pure-node unit tests (via
// their HELM_*_PATH seams) outside any Electron context, and an `electron`
// import there would break them. Only this dedicated bootstrap file (loaded
// solely from main.js, which already runs inside Electron's main process)
// touches `electron`.
if (app.isPackaged) {
  const dataDir = process.env.HELM_DATA_DIR || path.join(app.getPath("home"), ".helm");
  // Make sure the shared dir exists so the first write doesn't ENOENT.
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {
    // best-effort — a store write failing is already handled non-fatally
  }

  const setIfUnset = (envVar, fileName) => {
    if (!process.env[envVar]) {
      process.env[envVar] = path.join(dataDir, fileName);
    }
  };

  setIfUnset("HELM_CONFIG_PATH", "config.json");
  setIfUnset("HELM_DOMAINS_PATH", "domains.json");
  setIfUnset("HELM_GOAL_RUN_HISTORY_PATH", "goal-run-history.json");
  setIfUnset("HELM_MATES_PATH", "mates.json");
  setIfUnset("HELM_SECOND_MATES_PATH", "second-mates.json");
  setIfUnset("HELM_ROUTINES_PATH", "routines.json");
  // Missing here until 2026-08-02, which is why queueing a prompt in the
  // INSTALLED app failed with "Could not write the scheduled-prompt queue"
  // while it worked perfectly in dev (Aidin, task 7d9d2188): without the
  // redirect the store resolved inside the read-only app bundle. Adding a new
  // store means adding it here too - test-packaged-store-paths.mjs enforces it.
  setIfUnset("HELM_SCHEDULED_PROMPTS_PATH", "scheduled-prompts.json");
  setIfUnset("HELM_USAGE_PATH", "helm-usage.jsonl");
  setIfUnset("HELM_USAGE_LOG_PATH", "usage-log.jsonl");
  setIfUnset("HELM_IMAGES_DIR", "pasted-images");
}
