# Handoff - latest session state

_Overwritten on each handoff (latest-only); prior handoffs are in git history._
_Saved 2026-08-11 12:46. For durable rationale see DECISIONS.md; for the roadmap, PLAN.md._

## Handoff: Fleet sub-agent tree + queued-prompt fixes

**State:** Two bugs diagnosed and fixed, both committed and pushed to `origin/master` (personal remote, `AidinD/helm`), and both included in a freshly built local dist (v0.2.11, commit `1511f80`) at `dist/Helm Setup 0.2.11.exe` / `dist/Helm 0.2.11.exe`. Aidin has **not yet installed** this new build — he was still running an older installed version as of the last message. Don't assume the fixes are live in his running app until he confirms he installed/relaunched from the new dist.

### Bug 1 — Fleet tree never showed live sub-agents/reviewers
Root cause: `src/lib/subAgents.js` scanned session transcripts for `tool_use` blocks named `"Task"` to detect in-flight sub-agents for the Fleet crew-tree display. The CLI renamed that tool to `"Agent"` at some point, so the scan silently matched nothing, ever — for any session, not just the one Aidin flagged. Verified by reading a real transcript (`tgs-crewline` project, session `3f1c390b-...`) where a dispatched reviewer logged as `name: "Agent"`.

Same stale name was also silently defeating a security-relevant guard: `src/main.js` `FIRST_MATE_DISALLOWED_TOOLS` denied `"Task"` to stop a first-mate session from fanning out its own sub-agents (tier-discipline rule, see `docs/orchestration-model.md`) — that denial was a no-op for the same reason.

Fix: both places now accept/deny `"Agent"` (keeping `"Task"` too, for old transcripts / backward compat). Added a regression test case in `scripts/e2e/test-sub-agents.mjs` pinning the `"Agent"` name specifically, so a future rename can't silently regress this again. Commit: `b568bcf`.

### Bug 2 — Queued follow-up prompts vanished when leaving a session
Aidin's report: typing a follow-up while a session is busy, hitting Enter to queue it (shows as "⏭ Queued: ..." above the composer), then navigating away — the queue disappears. Confirmed by code reading, not just reproduced.

Root cause: `pane.queuedPrompt` lived only on the renderer's in-memory `pane` object. `openSessionInPane` (`src/renderer/renderer.js`) fully discards and rebuilds that object (`{...freshPane(), ...}`) on *any* navigation away from a session and back — which is precisely "leaving the session." The queue was never actually broken as a queue; it just didn't survive the exact use case its own code comment describes ("for when you're stepping away").

Fix: added a session-keyed module-level map `queuedPromptBySession` (mirrors the existing `runningSessions` pattern), synced on queue/cancel/fire. `openSessionInPane` now restores `queuedPrompt` from that map when rebuilding a pane, and if the run already finished while the pane was closed (queued but no longer busy), fires it immediately on reopen instead of leaving it stranded. Commit: `1511f80`.

### Verification done
- `node --check src/renderer/renderer.js` (syntax)
- `npm run test:fast` — 71/71 passed, no regressions
- `node scripts/e2e/test-sub-agents.mjs` — including new "Agent"-name case
- Root-caused both bugs by reading actual on-disk state (`~/.helm/*.json`, real session transcripts under `~/.claude/projects/`), not just by reading the display code in isolation — worth repeating that pattern for future "X doesn't work in the app" reports from Aidin, since both bugs here were invisible from the renderer code alone without cross-checking real transcript/state shape.

### Next steps
1. Confirm with Aidin whether he's installed the new dist (0.2.11) yet — the fixes aren't live in his app until then.
2. If he still sees either issue after installing, re-check: for the sub-agent tree, verify the CLI's current tool name hasn't drifted again (`grep -io '"name":"Agent"' <transcript.jsonl>`); for the queue, confirm which navigation path he's using (switching sessions in the same pane vs. closing the app entirely — the fix covers the former; full app-restart persistence was explicitly not built, since `queuedPromptBySession` is memory-only).
3. No corresponding DECISIONS.md entries were written for either fix — consider adding short entries there if these turn out to be recurring bug classes worth the durable record (per `CLAUDE.md`'s "proper fixes over patches" principle, both were root-caused rather than patched, but the *why* isn't yet captured outside this conversation and the commit messages).
