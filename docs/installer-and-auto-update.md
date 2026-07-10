# Installer + auto-update

Goal: launch Helm as an installed desktop app (double-click, no `npm start`),
and have it auto-update from GitHub Releases - so the fast build→release→update
loop replaces the dev flow for day-to-day use.

## Status (2026-07-10)

**Scaffolded + dev-safe, NOT yet built/verified as a binary.** Done in this pass:
- `package.json`: electron-builder `build` config (Windows `nsis` installer +
  `portable` exe, GitHub publish target `AidinD/helm`) + `dist` / `release`
  scripts; `electron-builder` (dev) + `electron-updater` (runtime) added to deps.
- `src/lib/autoUpdate.js`: packaged-only auto-update (checks GitHub Releases,
  background-downloads, prompts to restart). **Dev-guarded**: in dev
  (`app.isPackaged` false) electron-updater is never imported, so `npm start` /
  restart-dev.sh boot cleanly even before `npm install` pulls the new deps
  (verified: clean boot after these changes).

**NOT done here** (needs a real build machine + decisions; can't be verified
from the dev harness):
1. `npm install` (pull electron-builder + electron-updater), then `npm run dist`
   to actually produce the installer, and launch-test the produced `.exe`.
2. The heavy-dependency question: `@huggingface/transformers` (voice) is large;
   confirm the packaged size is acceptable or mark voice deps optional / exclude
   from the default build.
3. A Windows `.ico` (electron-builder prefers it over the `.png` currently
   pointed at) for a crisp installer/taskbar icon.

## Decisions you need to make

- **Auto-update from a PRIVATE repo needs a token.** `AidinD/helm` is private, so
  electron-updater must authenticate to read releases. Either set `GH_TOKEN` in
  the environment, or embed a read-only token in the build (the pattern Halyard
  uses). Without it, auto-update can't see releases (the app still runs; it just
  won't self-update). Decide: embed a read-only token, or keep updates manual.
- **Code signing.** Unsigned is fine for personal use but Windows SmartScreen
  warns on first run. A signing cert removes that. Default: ship unsigned.

## Release flow (once the above is settled)

1. Bump `version` in `package.json`.
2. `npm run release` (electron-builder builds + publishes to GitHub Releases;
   needs `GH_TOKEN`).
3. Running installed apps pick it up within ~6h (or next launch) and prompt to
   restart.

## Dev flow is unchanged

`npm start` / `scripts/restart-dev.sh` still run the app from source with no
updater (packaged-guarded). The installed app and the dev app are independent;
installing does not change how you develop.
