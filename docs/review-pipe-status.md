# Review pipe - current status

Last updated 2026-09-02. **Read this first**; the chronological reasoning is in
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
   are trying to stop doing. **Mitigation in place since 2026-07-27: the `ship-review`
   skill now asks the independent reviewer to set the level and to propose the checks,
   without being told what the author had in mind, and a higher level from the reviewer
   wins. That is a process guard, not a code guard - nothing stops a record written
   without running ship-review from under-declaring.**
3. **The signing oracle is narrowed, not closed.** `recordCheckRun` is exported and
   accepts a caller-supplied exit code, so an agent that imports the module can stamp a
   result it never observed. What changed is that the lie must now be about a SPECIFIC
   declared command at a SPECIFIC commit. **Partly addressed 2026-09-02: the pure lane
   now runs on GitHub's machines and a record can cite that run. Read the next section
   before counting it - it moves one lane out of two, and a citation is a pointer, not
   a second signature.**

## What is outside the assistant's reach, and what is still inside it

Added 2026-09-02 (task 3d01cf26). Be precise about this line, because everything on
the wrong side of it is still the author vouching for the author.

**Outside.** `.github/workflows/pure-tests.yml` runs the pure lane
(`scripts/ci-fast-lane.mjs` -> `run-tests.mjs --fast`) on a GitHub-hosted Windows
runner on every push to `main` and on every pull request. Nothing in this repository
decides that result, and nothing here can edit it afterwards. The job's token is
read-only and it writes nothing.

**Still inside, all of it:**

- **The checks that launch the app are NOT run there.** Roughly half the checks in
  `scripts/e2e` start the real Electron app with a window; a hosted runner has none,
  and no headless harness or virtual display exists for them yet. No workflow in this
  repository runs them. They remain something only the author has ever executed. The
  job prints the live count of them on every run, green or red, so the gap cannot be
  read as smaller than it is.
- **Two pure checks are excluded by name** because CI does not install what they
  import (`@jot/core`, which is a build artefact of a sibling repo, and
  `@huggingface/transformers`). They are reported as EXCLUDED and never as passed. The
  list, with reasons, is `EXCLUDED` in `scripts/ci-fast-lane.mjs`.
- **The checks that drive a real model self-skip.** CI never passes `--live`, so they
  are reported as skipped and counted as neither pass nor fail.
- **`checkRuns` are still signed by this process with a key on local disk.** CI does
  not stamp check runs, and nothing about the gauntlet's provenance changed.
- **A cited CI run scores nothing.** `externalRuns` on a record is a CITATION - a url
  and a run id a reader can open. The JSON is still written by an agent, so the field
  could be invented; what makes it worth anything is that a fabricated run does not
  survive being clicked. `gauntletStatus` never reads the field: a record with a cited
  CI success and no signed run is still `unrun`. Making a citation able to turn a check
  green would let a pass be minted out of a string, which is worse than the honour
  system it replaces. `covers` is required on every citation for the same reason - a
  citation with no stated scope reads as "CI passed", and CI covers one lane.
- **Nobody is watching the workflow.** It is not a required check, it opens no issue
  and sends no message. A red run is visible in the Actions tab and in a pull request's
  checks, and nowhere else. That is deliberate (a failed run must not block work) and
  it is also a gap: a run can go red and stay red unnoticed.

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
    node scripts/e2e/test-ci-evidence-honest.mjs      # the CI coverage statement matches the suite's real split

The last one is the guard on this section rather than on the pipe. It fails if the
workflow's coverage statement stops matching the suite - a lane count hardcoded instead
of computed, the app lane wired into the CI job, an exclusion whose stated reason is not
true, or a citation that could score a check.

## Coarse commit pinning - RESOLVED 2026-07-27

Pinning a pass to a commit used to mean ANY commit staled every check, including one
that only edited a markdown file. Now the comparison asks whether anything other than
documentation changed between the commit a check ran at and the current one, and the
Review page has a "Re-run N unconfirmed" button so a board that did go stale can be
cleared without opening every card.

Unknown still counts as changed (missing commit, rewritten history, no git, no recorded
commit), and the default resolver stays strict, so a caller that forgets to pass one
gets the safe behaviour. The hole the pin closed - a fix after a send-back keeping its
old green - is untouched.

## If you change this pipe

Two rules earned the hard way today:

1. **Verify by USING it, not by reading it.** Every real defect today was found by
   running the thing - rendering a fabricated record, watching a real launch, clicking
   the button. The unit tests were green throughout.
2. **The author must not be the only one who looked.** That is not a slogan here: the
   critical tier enforces it, and it was enforcing it against me when it refused this
   pipe's own record.
