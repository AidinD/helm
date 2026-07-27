# Review pipe - current status

Last updated 2026-07-27. **Read this first**; the chronological reasoning is in
`DECISIONS.md` (search "review pipe" - six entries from 2026-07-27 alone).
This file answers one question: how far can the pipe be trusted right now?

## What it is for

The captain wants to stop reading code diffs and instead trust Helm's Review page: judgment
items get his decision, "ready to stamp" items he reads the evidence for and moves on,
and a criticality gradient means nothing security- or data-critical can slip through
even if a front-end bug does.

So the failure that matters is exactly one: **the pipe reporting something as verified
when it is not.** A false green means unverified work ships. A false red is safe.
Every design call below is resolved in that direction.

## Confidence: MEDIUM-HIGH, not high

Three independent adversarial passes have run against it, each in a fresh context, and
each found real defects: 11, then 6 attack narratives, then 12. The last used mutation
testing (disable a guard, see whether the suite notices) and most mutations WERE caught
- the first real evidence the suite has teeth.

**Why not high:**

1. **Every fix round has produced new defects.** Round two's worst two findings were
   things round one had just "fixed": a detection with no consequence, and a patch that
   landed in the wrong function. The rate is falling, but it has not reached zero, and
   one clean pass would not change that.
2. **Tier gaming is an honour system.** Nothing correlates the declared `criticality`
   with the diff, the touched paths, or the commits. A security change labelled
   `cosmetic` needs no check and no independent pass. Since the gradient is what the
   whole "I stop reading diffs" claim rests on, this is the largest open hole - and
   there is no honest fix that does not involve reading the diff, which is the thing we
   are trying to stop doing. **Recommended mitigation: let the independent reviewer set
   the tier, not the author.**
3. **The signing oracle is narrowed, not closed.** `recordCheckRun` is exported and
   accepts a caller-supplied exit code, so an agent that imports the module can stamp a
   result it never observed. What changed is that the lie must now be about a SPECIFIC
   declared command at a SPECIFIC commit. A real guarantee needs the runner outside the
   author's reach (CI) - a project, not a task.

## What IS hardened (each verified through the running app, not just unit tests)

- **Forged run outcomes.** Runs are HMAC-signed by the process that spawned the
  command. Unsigned, edited, or transplanted runs count as `unverified` - never a pass.
  A hand-written `{ok: true}` reads as NOT VERIFIED in the dot, the wording, the
  summary line, the section heading and the badge.
- **Commands that cannot fail.** `node test.mjs || exit 0` is `unusable`, not a pass,
  even when genuinely run and correctly signed. The command is rendered in full (it was
  truncated at 44ch, which hid exactly that tail).
- **A pass is bound to what it tested.** The signature covers the command as DECLARED
  in `rec.checks`, and the commit it ran against. Swapping either invalidates it. A
  pass earned on a dirty tree is stale.
- **Presentation cannot contradict itself.** One function (`gauntletStatus`) decides
  each check's state; the page displays it. One function (`reviewBand`) decides the
  band; the queue sorts and the page groups by the same value.
- **Validation is enforced on READ.** Records are authored as JSON by agents, so
  `buildReviewQueue` re-validates every one: an inadmissible record renders as
  `incomplete` with its reasons, distinct from `unrecorded`.
- **Absences are visible.** A record resting on no executed check, or on no agreed
  acceptance criteria, says so. `cosmetic` requires a written `whyNotCritical`.
- **What cannot be gated is detected.** Tasks that reached `done` with no record are
  listed in their own band. Subtasks in review are in the queue.
- **Sign-off is not one keypress.** Every unproven state confirms, naming its own
  reason, with Cancel focused.
- **Its own evidence survives a sync lock.** `reviewRecords` writes through the shared
  atomic write with a Dropbox-lock retry (2026-07-27). Before that a stamp could be
  lost and the check would read "never run" - the pipe losing its own proof.

## The checks that guard it

    node scripts/e2e/test-review-records.mjs          # 119 assertions, incl. forgery vectors
    node scripts/e2e/test-acceptance.mjs              # criteria parsing + link-based coverage
    node scripts/e2e/test-acceptance-gate.mjs         # the gate through the running app
    node scripts/e2e/test-forged-run-presentation.mjs # a fabricated green, at every level
    node scripts/e2e/test-atomic-write.mjs            # no store keeps a private rename
    node scripts/e2e/test-jot-writers.mjs             # sign-off writes + the done-without-record audit

## Known annoyance, filed not softened

Commit pinning is coarse: ANY commit stales every check, including a docs-only one.
Safe (false red) but during an active session the whole board reads stale, and a
warning you always see stops being a warning. Jot task `2bffffed`, priority 1, with a
recommendation (exempt docs-only commits + a "re-run everything stale" button).
Deliberately NOT widened here - the hole the pin closed was a fix after a send-back
keeping its old green.

## If you change this pipe

Two rules earned the hard way today:

1. **Verify by USING it, not by reading it.** Every real defect today was found by
   running the thing - rendering a fabricated record, watching a real launch, clicking
   the button. The unit tests were green throughout.
2. **The author must not be the only one who looked.** That is not a slogan here: the
   critical tier enforces it, and it was enforcing it against me when it refused this
   pipe's own record.
