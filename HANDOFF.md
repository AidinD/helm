# Handoff - latest session state

_Overwritten on each handoff (latest-only); prior handoffs are in git history._
_Saved 2026-08-11 15:55. For durable rationale see DECISIONS.md; for the roadmap, PLAN.md._

## Handoff: Review page decluttering (2026-08-11)

**Context:** Aidin said the Review page had become "plottrig" (cluttered) and most cards lacked detail — a regression from the version he liked (full cards: info, teststeg with checkboxes, buttons). He asked for three things, confirmed the plan for all three, and I implemented and verified them this session:

1. A "Present diff" button that opens the diff as a standalone HTML page (browser, not the in-app viewer) — like the `summary-page` skill's aesthetic.
2. Cards bound to commits — no commit, no card (declutter the "no review record" noise).
3. Jot-task binding on cards — already existed (parentTitle chip, Send back writes to the Jot card); no change made.

### What shipped

- **`src/lib/diffHtml.js`** (new) — `buildDiffHtml()`, pure string builder, splits a unified diff into per-file `<details>` blocks, dark theme matching the summary-page skill style.
- **`src/main.js`** — new `reviews:presentDiff` IPC handler: resolves the task's commits (record or log search), builds the diff, writes it to `%TEMP%/helm-diff-<taskId8>.html`, opens via `shell.openPath`. Also: `buildReviewsPayload` now stamps `row.hasCommits` per row (from `rec.commits` or a `resolveTaskCommits` log search) — annotated, not filtered server-side, matching this codebase's existing "never silently drop, always count what's held back" convention (see comments in that function).
- **`src/preload.cjs`** — bridges `presentReviewDiff(taskId, title)`.
- **`src/renderer/renderer.js`**:
  - New "Present diff" button next to "See the diff" in `reviewActionsEl`.
  - New module state `reviewHideNoCommits` (default `true`) + `rowNeedsNoCommitsCard(r)` predicate, applied inside `visibleReviewRows`.
  - New filter-bar chip "Bound to commits · N hidden" (same reversible pattern as the existing "Code only" chip) in `reviewFilterBarEl`, wired via a new `noCommitsCount` computed in `renderReviewPage`.

### Key decision — the filter had to be narrower than first planned

First pass hid any row with `hasCommits === false` and no declared checks and no critical/core criticality. This broke `test-acceptance-gate.mjs`: a real, fully-documented "stamp" record (cosmetic, evidence, acceptance criteria, test steps) with no git commit tied to it got hidden — but that's exactly the case the review-pipe's hardened tests protect (a record IS the evidence; hiding a real record is the failure class this whole surface exists to prevent, per `docs/review-pipe-status.md`).

**Final rule**, in `rowNeedsNoCommitsCard`:
```js
const rowNeedsNoCommitsCard = (r) => r.verdict !== "unrecorded" || r.hasCommits !== false;
```
Only hides rows that are BOTH `verdict === "unrecorded"` (no record was ever written) AND confirmed to have zero commits. Any row with an actual record — however it fares (stamp/judgment/incomplete) — is never hidden by this rule, commit or not. Also: `hasCommits === false` is a *positive* claim ("git was asked, found nothing"); `undefined` (older payloads, hand-built test fixtures) is treated as "has commits" so old test fixtures without the new field aren't silently affected.

### Verification

All 15+ review-related e2e suites pass, including `test-review-row-readable.mjs` (confirms "Present diff" renders alongside "See the diff", "Independent reviewer", "Mark done", "Send back") and `test-acceptance-gate.mjs` (confirms the acceptance-criteria/drift/test-step cards are NOT hidden despite having no commits). One test sandbox (`scripts/e2e/test-review-badge-and-widget.mjs`) needed its hand-built `new Function(...)` fixture updated to declare `reviewHideNoCommits` and `rowNeedsNoCommitsCard` — done.

### State / next steps

- Nothing is committed yet — all changes are uncommitted working-tree edits (new file `src/lib/diffHtml.js` untracked; modified: `src/main.js`, `src/preload.cjs`, `src/renderer/renderer.js`, `scripts/e2e/test-review-badge-and-widget.mjs`). There was also a pre-existing uncommitted `diffHtml.js`-adjacent state and other unrelated modified files noted in git status at session start (`scripts/e2e/test-review-badge-and-widget.mjs`, `src/main.js`, `src/preload.cjs`, `src/renderer/renderer.js` were already modified before this session per the initial gitStatus — verify with `git diff` before committing to avoid bundling unrelated prior work).
- Not yet done: no entry was added to `DECISIONS.md` or `PLAN.md` for this change, and `docs/review-pipe-status.md` was not updated — worth a short addition there since it touches the review queue's filtering behavior (the "annotate, don't drop" invariant was preserved but a new user-facing default-on filter was added).
- Not yet asked/decided: whether Aidin wants this committed as-is, split into two commits (diff-HTML feature vs. the commit-binding filter), or reviewed further first.
- Worth double-checking live: open the real Review page and confirm the "Bound to commits · N hidden" chip count matches expectations on his actual board, and that "Present diff" opens cleanly in his default browser.
