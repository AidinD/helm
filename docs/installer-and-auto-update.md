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

- ~~**Auto-update from a PRIVATE repo needs a token.**~~ **SETTLED 2026-08-23: no
  token is needed, and this entry was wrong for months.** `AidinD/helm` is PUBLIC
  (so are `jot` and `nib`), so electron-updater reads the release feed
  anonymously. Verified with no credentials of any kind:
  `GET /releases/latest/download/latest.yml` returns 200 with version 0.2.82, and
  the installer it names returns 200 at 107 MB.

  The cost of leaving this unchecked: `initAutoUpdate` returned early unless
  `GH_TOKEN` was set, so every packaged build shipped with self-update switched
  off and logged "auto-update parked" instead of doing anything. The gate is gone.

  **If Helm is ever made private again**, do NOT embed a token in the installer.
  Anyone holding the installer can read it, and a token with `repo` scope reaches
  every other private repo on the account. Publish the installers to a separate
  public repo, or accept manual updates.
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
