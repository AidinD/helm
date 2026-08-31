# Implementation plan: reversible archive for people, projects, workstreams

Read `.helm-goal/notes.md` first (the RESEARCH iteration) - it has the full
rationale for every choice below. This file is the ordered, concrete
step list. Each step is meant to be small enough for one `implement`
iteration. Do not batch multiple steps into one iteration unless a step
turns out to be trivial (e.g. a one-line addition already covered by a
bigger neighbouring step).

Current baseline confirmed by direct file reads (not just notes.md):
- `package.json` version is `0.1.70` today. Bump the patch on every commit
  that lands part of this work (e.g. `0.1.71`, `0.1.72`, ...), never minor/major.
- `store.rows(collection)` (`src/storage/reduce.js`) filters only `_deleted`.
  It does NOT know about `archivedAt` and must not be taught about it -
  archived rows must stay in `store.rows(...)`, otherwise `resolvePerson`/
  `resolveProject`/`resolveWorkstream` (`src/service/resolve.js`), which all
  read `store.rows(...)` directly, would stop finding an archived row and
  the person/project page plus history would break.
- `store.update(collection, id, fields)` and `store.create(collection, fields)`
  (`src/storage/store.js`) are the only primitives needed to write `archivedAt`.
- `src/domain/people.js` already has the exact precedent to extend:
  `inScope(person, now) = !isAway(person, now) && !hasLeft(person, now)`.
  Add a third clause here for archived people; every caller of `inScope`
  (attention.js, myattention.js) then excludes archived people for free.
- `src/domain/halves.js` `VIEWS`: People (`halves: ["work", "private"]`) is
  shared; Work (`halves: ["work"]`, where projects/workstreams render) is
  work-only. So people archiving must work in both halves; project/workstream
  archiving is naturally work-only because nothing in the private half reads
  those collections.
- `src/main/index.js` `OPERATIONS` is a **hand-written whitelist map**, not
  generated from `api.js` exports. Every new service function the renderer
  needs to call (`archivePerson`, `unarchivePerson`, ..., `archiveEverythingActive`)
  needs its own line added here, following the existing style
  (`opName: (a) => api.opName(store, a.xxx, { now: a.now ?? Date.now() })`).
  The comment above it already documents the precedent this design leans on:
  `decideDuty` is deliberately in `OPERATIONS` and deliberately absent from
  MCP - the same treatment archive/unarchive should get.
- UI dialog helpers confirmed in `src/renderer/ui.js`: `ask({title, body,
  confirm, tone})` -> `Promise<boolean>`, `form({title, intro, fields,
  confirm})` -> `Promise<Record<string,any>|null>`, `act(op, args, successText)`
  -> calls `tend.invoke(op, args)`, toasts on `{error}`, returns the result or
  `null`. No native `confirm()`/`prompt()` exists anywhere in `src/renderer`;
  none should be added.
- Existing "Remove" buttons to copy the shape of:
  `src/renderer/views/people.js` `actions.remove` (person page, `.danger-zone`
  block, calls `removeRow` with collection `"people"`), `src/renderer/views/work.js`
  `actions.removeProject` / `actions.removeStream` (project rows / workstream
  cards, same `removeRow` pattern). Archive buttons sit beside these.
- `src/renderer/views/settings.js` section style confirmed: each section is a
  function returning a `<div class="group">...</div>` with a `.group-head`,
  one or more `<article class="card">`, and entries added to `actions`. The
  bulk "I left this job" action gets its own new section function plus one
  new `actions.*` entry, following exactly the shape of e.g. `switchMode`.
- MCP absence precedent confirmed in `test/service.test.mjs` (~line 302):
  `assert.equal(TOOLS.find((t) => /decide|accept|activate/i.test(t.name)),
  undefined, ...)` and a similar one in `test/ledger.test.mjs` for decision
  tool names. Mirror this shape for archive tools.
- `src/domain/growth.js`'s `GrowthRow` typedef (one `@property` line per
  field, `[name]` for optional) is the house style to match for any new
  JSDoc describing the `archivedAt` field - but there are no existing
  `PersonRow`/`ProjectRow`/`WorkstreamRow` typedefs anywhere, so do not
  invent new typedef files. A short JSDoc comment at each read/write site is
  enough, matching how `leftAt`/`awayUntil` are documented today (inline
  `@param` comments in `api.js`, not a typedef).

---

## Step 1 - `src/domain/archive.js` (new file): the shared archived-ness concept

Create a small domain file, matching the narrative-header style of
`people.js`/`halves.js` (a short "why" essay, then tiny pure functions, then
"Nothing here touches the store.").

Contents:
- `isArchived(row)` -> `typeof row.archivedAt === "number"`.
- A short comment explaining why `archivedAt` is a plain timestamp (not a
  boolean flag) - symmetric with `leftAt`/`awayUntil`'s existing rationale
  ("a flag somebody has to remember to unset is a flag that stays set" - but
  here the point is more "when", for a future "archived N days ago" label),
  and why archiving is intentionally NOT unified with `_deleted` (an
  archived row must stay resolvable by id and keep showing history; a
  `_deleted` row does not).
- Optionally a tiny `archivedLabel(row, now)` helper (e.g. "archived 12 days
  ago", reusing `agoWords`/`humanDays` from `src/domain/time.js`) if the UI
  step below wants it - only add it if step 5 actually needs it, don't
  speculate.

Do not add a state machine, a "reason" field, or anything beyond the
timestamp - the goal is explicit that this is a boolean-in-effect status.

## Step 2 - extend `inScope` in `src/domain/people.js`

Add one clause: a person is in scope only if `!isArchived(person)` in
addition to the existing away/left checks. Import `isArchived` from the new
`archive.js`. Update the function's JSDoc comment to mention archived people
are out of scope too. This is the one change that makes `attention.js`'s
person-cadence crossing, `myattention.js`'s `here = people.filter(inScope)`,
and any other `inScope` caller correctly exclude archived people with no
further edits to those files.

Do NOT touch `hasLeft`/`isAway`/`isLeaving`/`availability` - archived is a
separate, independent concept from leaving/away, even though both end up
excluding someone from scope. `availability(person, now)` should probably
also learn to report `"archived"` (new branch, checked first since an
archived-and-left person should read as archived) - decide this in this
step since it is a one-line addition to an existing function in the same
file, and the roster (`api.people`) already surfaces `availability` on each
row.

## Step 3 - service layer: read paths that must exclude archived rows

Work through each call site identified in the research notes (section 5)
and add filtering. Do this as ONE step touching `src/domain/attention.js`,
`src/domain/myattention.js` (verify it needs no change beyond step 2),
`src/service/prep.js`, and `src/service/api.js`'s existing list endpoints -
but do NOT yet add the new archive/unarchive/list-with-archived functions,
that is step 4. This step is purely "stop showing archived rows in views
that already exist," so it can be tested against the *existing* test suite
before any new API surface is added.

Concretely:
- `src/domain/attention.js` `expandCadences`: filter `live("projects")` and
  `live("workstreams")` through `!isArchived(...)` at the `cross(...)` call
  sites (people are covered for free via step 2's `inScope`).
- `src/domain/attention.js` `buildAttention`: add an `isArchived` skip
  alongside the existing `hasLeft(person, now)` skip in the promise loop,
  and filter `live("workstreams")` in the "unspecified workstream" loop.
- Decide and implement the stakes question from the research notes (open
  question 2): filter `namedStakes(...)` inputs so a stake tied to an
  archived person or archived project stops generating cadence noise.
  Recommended: filter at the `namedStakes(...)` call sites themselves (in
  `attention.js` and in `api.stakeholders`), not by adding `archivedAt` to
  the `stakes` collection. Write a short comment explaining why (stakes
  are not one of the three archivable collections; they inherit archived-ness
  from what they point at).
- `src/service/prep.js`: add an early `continue` for archived people at the
  top of the per-person loop (do not rely on drift happening to read as
  zero - the goal requires an explicit exclusion). Filter
  `owned = workstreams.filter(...)` to also exclude archived workstreams.
- `src/service/api.js`:
  - `people(store, now, relation)`: filter `store.rows("people")` to
    exclude archived rows by default (`.filter((p) => !isArchived(p))` in
    addition to the existing relation filter).
  - `projects(store, now)`: same, exclude archived by default.
  - `workstreams(store, now)`: same.
  - Add `archivedAt` (or a derived `archived: boolean`) to the object each
    of these three functions returns per-row, so the renderer can decide
    Archive vs Unarchive and show "archived N days ago" without a second
    round trip. This is needed regardless of which "show archived" UI shape
    step 6 picks.
  - `person(store, query, now)`: no filtering change (must keep resolving
    archived people), but add `archivedAt: p.archivedAt ?? null` to its
    return object so the person page can render an "Archived" banner.

Run `npm test` at the end of this step - existing tests must still pass
unchanged (nothing here is a new field on test fixtures yet, since no row
has `archivedAt` set until step 4's functions exist).

## Step 4 - service layer: archive/unarchive/list-with-archived/bulk functions

Add to `src/service/api.js`, near the existing `people`/`projects`/
`workstreams` functions and their `add*`/`update*` siblings:

- `archivePerson(store, id, { now })`, `archiveProject(store, id, { now })`,
  `archiveWorkstream(store, id, { now })`. Each: resolve the row (reuse
  `resolvePerson`/`resolveProject`/`resolveWorkstream`), return `{ error }`
  on a bad id (same style as `resolvePromise`/`updateThread`). **Idempotency
  requirement (goal point 4):** if the row is already archived, return
  successfully without calling `store.update` and WITHOUT overwriting the
  existing `archivedAt` - e.g. `{ id, name, archivedAt: row.archivedAt,
  already: true }`. Otherwise `store.update(collection, id, { archivedAt: now })`
  and return `{ id, name, archivedAt: now }`.
- `unarchivePerson(store, id)`, `unarchiveProject(store, id)`,
  `unarchiveWorkstream(store, id)`. Same resolve-or-error shape. If already
  active (`archivedAt` is not a number), no-op success, do not error. If
  archived, `store.update(collection, id, { archivedAt: null })` (matches
  the existing `updatePerson` convention of `null` meaning "clear", not
  `undefined` - events must carry an explicit clear).
- `archiveEverythingActive(store, { now })`: thin wrapper. Loop
  `store.rows("people")`, `store.rows("projects")`, `store.rows("workstreams")`
  and call the matching `archive*` function for every row (the per-item
  idempotency guard makes a second run over an already-archived row free).
  Return a summary count: `{ people: n, projects: n, workstreams: n }`
  counting only the rows that were actually active-and-got-archived (not
  rows skipped because they were already archived) - this is what the
  Settings confirmation dialog reports back to the user after the fact.
  Comment explaining why this is a thin wrapper and not its own code path
  (goal point 4's explicit requirement), referencing the "I left this job"
  moment by name once, in general terms (no real employer/person details -
  this is source code, same constraint as DECISIONS.md).
- A small "list including archived" capability for the three collections.
  Recommended shape (decide and use consistently across all three, per
  research notes open question 1): keep `people()`/`projects()`/
  `workstreams()` returning only active rows (already done in step 3), and
  add three sibling functions `archivedPeople(store, now)`,
  `archivedProjects(store, now)`, `archivedWorkstreams(store, now)` that
  return the same per-row shape but filtered to `isArchived(row)` instead.
  This avoids threading a boolean option through every existing call site
  and keeps each function's contract simple ("this list is always one
  thing"), which fits this codebase's preference for dedicated functions
  over parameterised modes (see `resolveStake` being id-only by design, or
  `roleMap`'s three pre-split groups) better than a `{active, archived}`
  wrapper would, since `people`/`projects`/`workstreams` are called from
  several existing places expecting today's flat array shape.

Add these six archive/unarchive functions plus `archiveEverythingActive`
plus the three `archived*` list functions to `src/main/index.js`'s
`OPERATIONS` map, following the existing line style exactly (see
`archivePerson: (a) => api.archivePerson(store, a.id, { now: a.now ?? Date.now() })`).

## Step 5 - unit tests (domain + service)

Add tests following `test/service.test.mjs` / `test/people.test.mjs`
conventions (`node:test`, `openStore` over a `mkdtempSync` scratch dir,
`ok`/`failed` helpers from `test/helpers.mjs`). Cover, per the goal's TESTS
section:
- Archiving a person/project/workstream removes them from `api.people()`/
  `api.projects()`/`api.workstreams()` and from `api.attention()`'s output
  (cadence crossing no longer includes them), while `api.person(store, id, now)`
  and history reads (`store.rows("touches")` etc. for that id) are unaffected.
- A promise/growth-thread/decision tied to an archived person is untouched
  in the store and still readable, but does not surface as a "needs you"
  attention item (mirrors the existing `hasLeft` test pattern if one exists
  - check `test/attention.test.mjs` or similar for the closest analogue).
- Archiving twice is a no-op: second call does not change `archivedAt`,
  does not error, `already: true` (or equivalent) on the second response.
- Unarchiving restores visibility in `people()`/`projects()`/`workstreams()`
  and in attention/prep output.
- `archiveEverythingActive` archives every currently-active row across all
  three collections in one call, is safe to call twice in a row (second
  call archives nothing new, since everything is already archived), and
  does not touch rows that were already archived before the first call
  (their original `archivedAt` timestamp survives unchanged - assert this
  explicitly, it is the "re-running a week later" requirement from the goal).
- `archivedPeople()`/`archivedProjects()`/`archivedWorkstreams()` (or
  whatever shape step 4 lands on) return exactly the archived rows and none
  of the active ones.
- MCP absence test: mirror `test/service.test.mjs`'s existing
  `/decide|accept|activate/i` assertion with a new one asserting no tool
  name matches `/archive/i` in `TOOLS` (`src/mcp/tools.js`). Place it near
  the existing decideDuty test for discoverability.

Run `npm test` and `npm run typecheck` at the end of this step; both must
be green before moving on.

## Step 6 - renderer: per-item Archive buttons + confirmation

- `src/renderer/views/people.js`: add an "Archive" button beside the
  existing "Remove" button in the person page's `.danger-zone` block (or
  its own less-alarming block above the danger zone - "Archive" is
  reversible and should probably not sit inside a block literally called
  `danger-zone`; use judgement, but keep it visually distinct from Remove
  so the two are not confused). Wire an `actions.archive` handler:
  `ask({title: "Archive <name>?", body: "<plain language: stops appearing
  in Now/prep/attention/roster; every 1-1, promise, decision and growth
  thread about them stays exactly as it is and can be looked at again;
  fully reversible from the archived list.>", confirm: "Archive", tone:
  "danger"})` then `act("archivePerson", {id}, "Archived.")` then
  `go("people")` or `refresh()` (match whatever `actions.remove` does today).
  If the person is already archived (banner state, see below), show an
  "Unarchive" button instead calling `act("unarchivePerson", {id}, ...)`.
- `src/renderer/views/work.js`: add "Archive"/"Unarchive" buttons beside
  `removeProject` (project rows) and `removeStream` (workstream cards),
  same `ask` + `act` shape, targeting `archiveProject`/`unarchiveProject`
  and `archiveWorkstream`/`unarchiveWorkstream`.
- Person page: render an "Archived" banner/line when `p.archivedAt` is set
  (from step 3's addition to `api.person()`'s return shape).
- Project/workstream rows: use the `archivedAt`/`archived` flag added in
  step 3 to `api.projects()`/`api.workstreams()` to decide which button
  (Archive vs Unarchive) to show - but only for the archived-items view
  from step 7, since the default `projects()`/`workstreams()` calls now
  exclude archived rows entirely (step 3). This means the archived view
  needs its own render path reusing the same row-rendering function with
  data from `archivedProjects()`/`archivedWorkstreams()`.

## Step 7 - renderer: "show archived" / browse-and-unarchive view

Decide the concrete placement (research notes open question 3): add an
"Archived (n)" collapsible group at the bottom of the existing People view
and the existing Work view, rendered from `archivedPeople()`/
`archivedProjects()`/`archivedWorkstreams()`, each row showing name and an
"Unarchive" button. This avoids adding a new entry to `halves.js`'s `VIEWS`
(which the file's own header comment warns against duplicating) and reuses
the existing row-rendering helpers with the archived-flavoured data.
People's archived group must render in both halves (reachable wherever the
People view already renders in `private` mode); Work's archived group is
naturally work-only since the Work view itself is.

Add `actions.unarchive` (people.js) and `actions.unarchiveProject`/
`actions.unarchiveStream` (work.js) calling the matching service function,
then `refresh()`.

## Step 8 - renderer: Settings bulk "I left this job" action

In `src/renderer/views/settings.js`, add a new section function (e.g.
`archiveSection`, following `dataSection`'s shape: a `.group` with one
`.card`) placed logically among the existing sections (after `dataSection`
reads naturally, since both are about the shape of the data). The card's
body states in plain words, per the goal: archives everyone and everything
currently active; does not delete any history; fully reversible one at a
time from the archived lists. A single button opens `ask({title: "...",
body: "<the plain-language statement above>", confirm: "Archive
everything", tone: "danger"})`, and on confirm calls
`act("archiveEverythingActive", {}, "<n> archived.")` (build the toast text
from the returned `{people, projects, workstreams}` counts) then `refresh()`.

Wire the new section into `render()`'s template alongside the existing
`${modeSection(...)}` etc. calls, and add the new action to the exported
`actions` object.

## Step 9 - E2E coverage (`scripts/e2e-app.mjs`)

Follow the existing `check(label, fn)` harness and CDP-driven pattern (the
away/leave round-trip check, found by searching for `awayUntil` in that
file, is the closest existing analogue - same shape: open person, mutate
via a dialog, assert a computed list changed, undo, assert it changed back).
Add:
- Archive one person: open their page, click Archive, confirm the dialog
  (assert its wording is not empty / mentions reversibility - do not
  over-assert exact copy), assert they drop out of the roster (`people`
  view) and out of Now/attention output. Open the archived list, assert
  they appear there with an Unarchive action. Click Unarchive, assert they
  are back in the normal roster/Now.
- Archive one project and one workstream (Work view): same round trip,
  asserting they drop out of the default Work view lists and reappear in
  an archived section, then come back after Unarchive.
- Settings bulk action: open Settings, trigger the "I left this job"
  button, assert the confirmation dialog's body text is present before
  confirming (this is the one place the goal explicitly requires the
  wording to be checked, since it is the destructive-sounding one),
  confirm it, assert the roster/Now/Work default views are now empty of
  active items, assert a person page for someone who was just archived
  still resolves and still shows their history (promises/contact log),
  assert the archived list is non-empty.

Use a scratch `TEND_DATA_DIR` (`mkdtempSync`), never the real data
directory, per `scripts/e2e-app.mjs`'s existing convention. Run
`npm run test:app` to verify locally before considering this step done.

## Step 10 - DECISIONS.md entry

Add a new dated entry (`## 2026-08-30 - <sentence-case title>`, e.g.
"Archive is a date on a row, not a delete") in the file's existing voice,
modeled on the shape of the `2026-08-25` "Away and gone are dates on a
person, not a delete" entry (bolded `**Decided.**`, `**Why.**`, and a
`**Rejected: ...**` subsection). Content, in general mechanism-only terms
(no person's name, no description of the owner's real situation/employer -
write only about the mechanism, matching the constraint already respected
in the codebase's other entries about this exact person's history):
- **Decided**: `archivedAt`, a plain timestamp on `people`/`projects`/
  `workstreams` rows, read going forward by every view that currently
  assumes every row is live; nothing about the append-only log changes
  shape, and no historical row is ever mutated or deleted.
- **Why**: the store's whole design principle is that nothing is destroyed;
  a "clear everything" idea would have broken that the first time someone's
  situation changed, for exactly the case (a job change, a project ending,
  someone leaving) where the historical record - touches, promises,
  decisions, growth threads, evidence - is the part worth keeping.
- **Rejected**: unifying this with the existing `leftAt`/`_deleted`
  mechanisms - `leftAt` is a period with a return path baked into cadence
  math (`notBefore`), `_deleted` has no restore path and makes a row
  unresolvable by id; archiving needed to be simpler than the first and
  more reversible than the second, so it stayed a separate, independent flag.
- Mention the bulk "I left this job" action only as "a bulk trigger that
  archives everything active in one call, reusing the same per-item
  function" - do not describe why someone might press it.

## Step 11 - final verification pass

Run, in order, and fix anything red before calling the goal done:
`npm test`, `npm run typecheck`, `npm run test:app` (and ideally
`npm run test:app -- --packaged` if time allows, though this is not
explicitly required by the goal's VERIFY section - the goal only asks for
"unit test suite, typecheck, and E2E harness", which map to the first
three commands). Confirm `package.json`'s version has been bumped at least
once across the commits that implemented this (patch only). Confirm
DECISIONS.md has the new entry and mentions no real names.

---

## Notes for whoever implements this

- Steps 1-4 (domain + service) can each be one iteration. Step 3 is the
  biggest of these and may need to split further (e.g. one iteration for
  attention.js + prep.js, one for api.js's list endpoints) if it runs long
  - use judgement, smaller safe commits beat one large risky one.
- Steps 6-8 (renderer) touch three different view files; each can be its
  own iteration.
- Do not skip step 5 (unit tests) before moving to renderer work - the
  service layer is what the E2E test and the UI both depend on, and it is
  far cheaper to catch a mistake in `archiveEverythingActive`'s idempotency
  via a unit test than via the E2E harness.
- If any step surfaces a design question not answered here or in
  notes.md's open questions (section 10), make the smallest reasonable
  decision consistent with the codebase's existing conventions, note the
  decision and reasoning in notes.md for the next iteration, and proceed -
  do not block a whole iteration on a question that has a clear
  house-style answer.
