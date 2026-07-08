# Helm — project rules

Personal Electron wrapper around the real `claude` CLI. See `PLAN.md` for
the current build plan and active phase, and `DECISIONS.md` for past
decisions and why - both live in this repo, not in global memory.
`docs/USING-HELM.md` is the day-to-day usage guide (the daily loop, when
to reach for Chat vs Autopilot vs an orchestrator session, the keyboard
layer) - point the captain at it if he asks how to use the app.
`docs/orchestration-model.md` is the conceptual model the app is built around
(captain / first mate / second mate / crew tiers; ephemeral by tier; the
first-mate capability gap) - read it before any orchestration/dispatch work.

## Restarting during dev

Never `taskkill /IM electron.exe` directly - it matches by image name only,
machine-wide, and has silently killed unrelated Electron apps (Halyard)
running at the same time. Always restart via `scripts/restart-dev.sh`
(shells out to `scripts/kill-helm.ps1`), which only kills processes whose
command line actually points at this repo.

## Icons over emoji

For interactive controls (buttons, icon-buttons), prefer a small inline SVG
glyph (`currentColor` stroke/fill, no icon-library dependency) over a raw
emoji - emoji render inconsistently across platforms/fonts and read as less
polished. See the mic button (`MIC_ICON_IDLE`/`MIC_ICON_RECORDING` in
`src/renderer/renderer.js`) for the reference pattern. Emoji are still fine
for lightweight informal status text/badges (e.g. "⚠"/"❓ Needs your input")
where a custom glyph isn't worth building.

## Core principles (full detail in PLAN.md)

- Wrap the real CLI - never re-implement Claude, never strip features.
- Reuse Session Radar's read layer (`lib/sessions.js`, `lib/jot.js`) rather
  than duplicating file-parsing.
- Thin wrapper by default - "smart" layers cost extra tokens; add them
  deliberately, not as a default.
- Private project; personal git remote only when asked.
