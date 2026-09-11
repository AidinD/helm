import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT_STORES } from "./storeSeams.js";

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
// (the captain: "installerade helm är helt tom när jag startar"): none of his groups,
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

  // The list moved to storeSeams.js on 2026-09-11 and is looped over rather than written out
  // here, because it has a second reader that could not import this file: the E2E harness
  // imports `electron` nowhere, and it needs the same inventory to keep an app-check from
  // writing into the captain's real stores. See storeSeams.js for what that cost.
  for (const [envVar, fileName] of REPO_ROOT_STORES) {
    setIfUnset(envVar, fileName);
  }
}
