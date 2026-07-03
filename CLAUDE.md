# Maestro — project rules

Personal Electron wrapper around the real `claude` CLI. See `PLAN.md` for
the current build plan and active phase, and `DECISIONS.md` for past
decisions and why - both live in this repo, not in global memory.

## Restarting during dev

Never `taskkill /IM electron.exe` directly - it matches by image name only,
machine-wide, and has silently killed unrelated Electron apps (Halyard)
running at the same time. Always restart via `scripts/restart-dev.sh`
(shells out to `scripts/kill-maestro.ps1`), which only kills processes whose
command line actually points at this repo.

## Core principles (full detail in PLAN.md)

- Wrap the real CLI - never re-implement Claude, never strip features.
- Reuse Session Radar's read layer (`lib/sessions.js`, `lib/jot.js`) rather
  than duplicating file-parsing.
- Thin wrapper by default - "smart" layers cost extra tokens; add them
  deliberately, not as a default.
- Private project; personal git remote only when asked.
