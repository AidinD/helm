# Helm — project rules

Personal Electron wrapper around the real `claude` CLI. If `HANDOFF.md` exists,
read it FIRST - it's the latest session's current state + what's next
(overwritten each handoff, so always small). See `PLAN.md` for the current build
plan and active phase, and `DECISIONS.md` for past decisions and why - all live
in this repo, not in global memory.
`docs/USING-HELM.md` is the day-to-day usage guide (the daily loop, when
to reach for Chat vs Autopilot vs an orchestrator session, the keyboard
layer) - point Aidin at it if he asks how to use the app.
`docs/review-pipe-status.md` is the CURRENT standing of the review pipe - how far
it can be trusted, what is hardened, what is knowingly open, and the two rules for
changing it. Read that before touching anything under review records, the gauntlet,
acceptance criteria or the criticality gradient; DECISIONS.md holds the
chronological reasoning but does not say where things stand.
`docs/orchestration-model.md` is the conceptual model the app is built around
(captain / first mate / second mate / crew tiers; ephemeral by tier; the
first-mate capability gap) - read it before any orchestration/dispatch work.

## Moving a Jot task to review (do not skip the record)

Flipping a Jot task's `status` to `"review"` is NOT enough - Aidin's Review page
reads its card body (summary, evidence, test steps, checks) from a SEPARATE file,
`<metaHome>/.helm/reviews/<taskId>.json`, written via `src/lib/reviewRecords.js`.
Moving status alone with no record produces a technically-in-review card whose
body just says "No review record: ... treat it as unreviewed" - which reads as
the review pipe having gotten worse, when really nothing was ever written
(hit live 2026-08-11: two Helm tasks moved to review via Jot's own status field,
with no record, before this rule existed).

For every Helm task you move to review:

1. Do the work, run real checks, and capture their actual output/exit codes.
2. Import `writeReviewRecord` from `src/lib/reviewRecords.js` and write a record:
   `taskId`, `criticality` (`critical`/`core`/`cosmetic` - see the tier table in
   that file), `verdict` (`stamp` or `judgment`), `summary`, `testSteps`
   (`{step, expect}`), `checks` (`{label, cmd}`), `evidence`, `notVerified`.
   `reviewRecordProblems` refuses an incomplete record rather than silently
   storing a hollow one - read the error if it's rejected.
3. For each declared check, call `recordCheckRun(metaHome, taskId, {label,
   exitCode, tail}, {pinnedHead})` with the check's REAL exit code from a run you
   actually did - never a hand-written `{ok: true}` (unsigned/forged runs render
   as `unverified`, never a pass, by design). `pinnedHead = currentHead(projectPath)`;
   if the working tree has unrelated uncommitted changes at the time (someone
   else's WIP sitting in the repo), `git stash push -u`, capture the run + head
   there, write the record, then `git stash pop` - a record pinned to a `dirty`
   head reads as permanently stale for no reason tied to the work being reviewed.
4. Only THEN set the Jot task's `status` to `"review"` (jot-task-tracking skill's
   `jot-edit.mjs`). Jot still owns WHETHER something is under review; the record
   only supplies the evidence - the two are written in this order so a status
   flip never briefly outruns its evidence.

`metaHome` is the directory containing the CLAUDE.md that
`C:\Users\aidin\.claude\CLAUDE.md` `@`-imports (see `resolveMetaHome()` in
`src/main.js`) - currently `D:\Dropbox\Mina Dokument\Claude`. Read
`docs/review-pipe-status.md` for the full schema/design reasoning before writing
a record for anything above `cosmetic` criticality.

## Restarting during dev

Never `taskkill /IM electron.exe` directly - it matches by image name only,
machine-wide, and has silently killed unrelated Electron apps (Reinmaker)
running at the same time. Always restart via `scripts/restart-dev.sh`
(shells out to `scripts/kill-helm.ps1`), which only kills processes whose
command line actually points at this repo.

That repo-path match also means `kill-helm.ps1` does NOT touch the *installed*
Helm (`%LOCALAPPDATA%\Programs\Helm\Helm.exe`) - its command line points at the
install dir, not here. A silent NSIS install (`"dist\Helm Setup <v>.exe" /S`)
fails with exit code 2, doing nothing, while that installed app is running, and
the only sign is the exit code. Stop it by exact path first
(`Get-Process Helm | ? Path -eq "$env:LOCALAPPDATA\Programs\Helm\Helm.exe" |
Stop-Process`) - precise enough to be safe, unlike matching on the image name.

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
