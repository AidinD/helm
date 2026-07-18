# Helm — project rules

Personal Electron wrapper around the real `claude` CLI. If `HANDOFF.md` exists,
read it FIRST - it's the latest session's current state + what's next
(overwritten each handoff, so always small). See `PLAN.md` for the current build
plan and active phase, and `DECISIONS.md` for past decisions and why - all live
in this repo, not in global memory.
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

## Session metadata + verifying changes (hard-won gotchas)

These are the traps a fresh session most needs and would otherwise miss (they
cost real time before being learned). Load-bearing - read before any
session-storage, discovery, or verification work.

- **Never write into Anthropic's own session dir/schema.** `launcher.js` starts
  every Helm session via headless `claude -p`, which writes the transcript to
  `~/.claude/projects/...` but NEVER a Desktop `local_*.json` in
  `%APPDATA%\Claude\claude-code-sessions`. So Helm-created sessions have no
  Desktop metadata. The fix is Helm's OWN index (`config.helmSessions` in
  `config.json`), merged in `readAllSessions` - NOT writing `local_*.json` into
  Anthropic's private, undocumented dir (that risks destabilizing the real
  daily-driver Desktop app). See DECISIONS.md "Helm owns its own session index".
- **The `%APPDATA%\Claude` MSIX sandbox-overlay trap.** A process spawned BY a
  Claude session (e.g. a Helm launched from a Claude Bash tool) can have its
  `%APPDATA%` writes land in an invisible sandbox overlay the real Desktop app
  never sees - so a Claude-spawned-Helm round-trip gives false read-back
  results. Authoritative verification = a process you did NOT spawn (a real
  user-launched Helm). `config.json` lives on `D:\` (this repo), a REAL location
  outside that overlay, so Helm's own state IS reliably testable - one reason
  the `config.helmSessions` approach beats writing to `%APPDATA%`.
- **"clean boot" means a real process is up.** `restart-dev.sh` now confirms a
  live Helm `electron.exe` via `scripts/check-helm.ps1`, not a log grep - an
  earlier grep-for-"error" check reported "clean boot" while the app was dead
  (`'electron' is not recognized` contains no "error"). Trust the process check;
  after a repo folder rename, run `npm install` first (it can drop `.bin`).

## Icons over emoji

For interactive controls (buttons, icon-buttons), prefer a small inline SVG
glyph (`currentColor` stroke/fill, no icon-library dependency) over a raw
emoji - emoji render inconsistently across platforms/fonts and read as less
polished. See the mic button (`MIC_ICON_IDLE`/`MIC_ICON_RECORDING` in
`src/renderer/renderer.js`) for the reference pattern. Emoji are still fine
for lightweight informal status text/badges (e.g. "⚠"/"❓ Needs your input")
where a custom glyph isn't worth building.

## Core principles (full detail in PLAN.md)

- **Proper fixes over patches-on-patches.** In this project, prefer the deeper,
  long-term-correct solution over layering another override/special-case on top
  of an already-shaky mechanism. When a fix would be the 2nd or 3rd thing mutating
  the same state (or otherwise papers over a wrong underlying model), stop and
  flag it: name the root-cause fix, and if it's a larger refactor, sketch the
  design first (DECISIONS/PLAN) and align before building rather than shipping
  another patch. Accumulating overrides on one field is the smell. (Example: the
  session-status heuristic grew three layers before we recognized it wants a real
  FSM - see the "Session-status som FSM" Epic + DECISIONS 2026-07-18.)
- Wrap the real CLI - never re-implement Claude, never strip features.
- Reuse Session Radar's read layer (`lib/sessions.js`, `lib/jot.js`) rather
  than duplicating file-parsing.
- Thin wrapper by default - "smart" layers cost extra tokens; add them
  deliberately, not as a default.
- Private project; personal git remote only when asked.
