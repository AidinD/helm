# Decisions

## 2026-08-02 - The auto-captain's first real start, and the three things it exposed

The first genuine auto-start worked: the card was triaged, a session started in the right repo, the work got done.
Aidin's report was "den flyttades till in progress men sen verkar inget hända? inte som jag kan följa iaf. Auto widgeten är fortfarande tillsynes tom."
Every defect behind that sentence was about the parts nobody had exercised, because every test to date decided its outcome without a model call or a started session.

**1. A finished run finished nowhere.** `autoRuns` was only ever added to.
No entry was ever removed, so the card stayed in in-progress wearing `auto-running` forever - and the concurrency cap could only count up.
After three auto starts it would have been permanently full, and no further card could ever start until Helm restarted.
A cap that only counts up is not a cap, it is a countdown to a silent stop, and nothing would have reported it.
`runRelayTurn` now takes an `onFinished` callback and the auto-captain uses it to move the card to REVIEW (never done - that stays joint), drop the running tag, and free the slot.

**2. Two repaints reading stale data.** The widget dashboard fetched mates, second mates, goals and budget fresh but read SESSIONS out of renderer memory - and the fleet widgets are derived from sessions, so the repaint fired by the pass that had just created one could not see it.
Then `fillDashboardSections` returned immediately for the widget dashboard, so it never repainted on a poll either: once rendered, frozen.
Both fixed; the poll repaint is fingerprint-gated and still refuses mid-drag, which was the original guard's real purpose.

**3. A dispatch that never registered its second mate.** The auto-captain called `runRelayTurn` with an id nobody had proposed, and `bindSecondMateSession` writes only `{ sessionId, status }` - so the binding had no projectPath, and `deriveSecondMates` skips those.
The run survived only as a synthetic node named after the first line of its prompt instead of a named fleet member on its project.
It now proposes the second mate first.

**The card itself was reverted, and that is the more useful lesson.**
The test task was "add a `--version` flag that prints the version from package.json".
The session did exactly that, and the result is wrong: `package.json` says `0.1.0` and always has - the real version is computed from git at build time (`major.minor.commitcount`).
To make `node src/main.js --version` runnable at all it also rewrote the Electron import in three files, including the packaged-paths bootstrap, which is app-boot code.
Careful work, correct reasoning in its comments, and the wrong thing to keep: a boot-path change serving a throwaway test card.
**The prompt was mine and the flaw was in the prompt.** An agent that faithfully implements an underspecified card produces something defensible and useless, and that is the failure mode the triage gate cannot catch - it checks whether a card is specific, not whether it is right.

## 2026-08-02 - The docs-drift nudge gets a Reconcile button

Aidin, on the same nudge for the second time: "jag vet fortfarande inte vad jag ska göra med denna? Borde det finnas en 'fix' knapp eller liknande?"

The original design (2026-07-15) chose jump-in only, on the grounds that dispatching a reconcile turn was the riskier of the two options.
Two rounds of feedback say that was the wrong trade.
A row reading "loom, 15 behind" with a way into an unrelated conversation leaves him holding the whole job: remember what reconciling means, work out the range of commits, type it out.
**A signal nobody can act on is not a safe signal. It is noise with a number on it**, and the previous round of work - filtering out unversioned folders, ageing out dormant projects, naming what could not be read - made the number trustworthy without making it useful.

**Decided.** Every readable drifting row gets a Reconcile button that opens a session in that project with the job already written out: where the docs diverged, how to find the range, what belongs in DECISIONS.md versus PLAN.md, and the trap that DECISIONS.md is not a changelog of commits.

Two deliberate limits.
It lands in the COMPOSER instead of sending: this spends real money inside a repo, and a dashboard nudge must never be one stray click from that.
A project that could not be READ gets no Reconcile button - there is nothing to reconcile against, and offering the action would spend money to discover that.

The prompt is written out in full rather than left as "reconcile the docs" for the same reason the button exists at all: a vague prompt just moves the not-knowing one step to the right.

## 2026-08-02 - The auto-captain's trigger tag is seeded; still a tag, not a lane

Aidin, reviewing the finished auto-captain: "det finns ingen auto tag, borde den inte läggas till som default? Ska det inte finnas en auto lane i jot?"

**The first half was a real bug, and an embarrassing one.**
`auto` is the tag the USER applies - it is the entire entry point - and nothing in Helm or Jot ever created it.
Every gate, cap and kill switch was tested through the real app; the door was locked.
`setTaskTags` creates a missing tag on the fly, but only for the two Helm writes back, and it creates them bare: no colour, no description, next to six hand-made tags that have both.

**Decided.** `ensureTagsExist` seeds all three at startup, with colours and with descriptions that say what the tag DOES - those descriptions are the only place in Jot that documents the feature.
Idempotent, name-matched case-insensitively, and it does not rewrite the file when all three exist.
That last part is not tidiness: this runs at every launch against a file the Jot app may have open, and a pointless rewrite is a chance to lose someone else's edit for nothing.
A colour he changes himself survives.

**The second half stays as designed: a tag, not a lane.**
Not because a lane is hard - the parked task ed4291d2 covers that Jot's four statuses are hardcoded - but because it would be wrong even if it were free.
A lane is a position in the workflow (open -> in-progress -> review -> done).
"This may be started automatically" is a PROPERTY of a card, not a place in its lifecycle, and the two behave differently in the case that matters: the moment the auto-captain starts a card it must move to in-progress, which would erase the marking that caused it.
A tag survives the transition, which is how `auto-running` can mean anything at all, and how a card can be marked auto-eligible while it sits in review.
His instinct was about discoverability, and that was the right instinct pointed at the wrong mechanism - the fix for discoverability is the seeded, described tag.

## 2026-08-02 - A handoff asks which topic rather than inventing one

Aidin archived "Träning och kost (Hevy)" and got a second handoff file, `traning-och-kost-hevy.md`, next to the `training-coaching.md` it belonged in.
Two files, one subject, and the toast cheerfully announced a new topic - so the failure looked like success.

The chain had three links, and only the third was the interesting one.
The topic classifier is a real `claude` call on a 30s budget; a cold start alone measures 15.5s here, so it can simply not answer.
When it did not answer, the caller fell back to naming the topic after the session title.
And the fallback path was the ONE path in `resolveHandoffCategory` that returned immediately, skipping the match-an-existing-topic-first rule entirely.
So the moment matching mattered most - the model was unavailable, nothing else was going to catch a near-duplicate - was the exact moment no matching ran.
That is the same shape as the archive menus and the file writers: a rule implemented on the path we were thinking about, and not on the path that runs when things go wrong.

**Decided.** Three changes, in order of how much they matter.

1. **Never invent a topic.** `planHandoffFiling` refuses when no topic can be picked and topics already exist, and the renderer asks with a menu of the existing topics plus a clearly-labelled "New topic: <from the session name>". The text is re-sent with an explicit category, so refusing costs nothing.
Considered and rejected: a smarter deterministic matcher. "traning" and "training" are the same subject in two languages, and no word-overlap rule gets there without a synonym table that would be wrong in a new way.
The person archiving the session knows the answer instantly; asking is both cheaper and correct.
2. **The fallback is matched like any proposal.** If the title clearly folds into an existing topic, file it there and do not interrupt. Only a title that would create a NEW topic is worth a question.
3. **The classifier reports why it failed.** It used to resolve a bare `null` for a timeout, a spawn failure and unreadable output alike. Now every failure carries a sentence, it is logged, and it is shown in the picker. Its budget also went from 30s to 120s: the other classifiers run on a timer against a background session where giving up cheaply is right, but this one runs on an explicit click and giving up means misfiling the note.

**Loading, which was the other half of the question.** Topic handoffs were listed in the context view and nothing more.
Worse, the carry-over directive listed them by bare filename alongside DECISIONS.md, telling a fresh session to look for them in the session's own folder rather than in Helm's store - so the answer to "how does loading work?" was "it doesn't".
The directive now names the real folder and tells the session to read the one matching its subject.
Choosing the matching one is left to the session rather than resolved up front: there are only a handful, and spawning a classifier while someone composes a draft is not worth it.

## 2026-08-02 - A status message is not a summary

Found while merging the duplicate handoffs above: the third topic file on disk contained, in full, "You've hit your session limit · resets 9:40pm (Europe/Stockholm)".
The summarize turn had exited cleanly with the CLI's own notice as the assistant's reply, so there was no error for anything downstream to see, and a whole session's knowledge was replaced by a status line - silently, with a toast saying the handoff was filed.

**Decided.** `validateSummary` guards on LENGTH first (under 200 characters is not a handoff of a real conversation) and matches the limit phrasing only to *report* what happened, never to decide.
Wording changes; length does not.
A refused summary archives without a handoff and says why, which is the same path an outright summarize failure already took.

Considered and rejected: matching the notice text as the primary test. It is a message we do not own and it will be reworded, and the guard would then be green while doing nothing - the exact failure the atomicWrite guard already had once.

## 2026-08-02 - Rescued from the mock gallery before deleting it: what NOT to add

Fourteen published mockups and reports had piled up and Aidin could no longer tell what was what.
Almost all of them were mocks whose feature has since shipped, so they are safe to delete - but two carried judgement that was written down nowhere else.
Recorded here so the gallery can go.

**Anti-patterns (from the 2026-07-06 UX report, back when Helm was called Maestro).**
These are standing "do not build this" rules, and the reasoning behind them is still the reasoning.

- **Chat as default gravity.** The fastest way to collapse a delegation harness back into a chatbot. Chat is a deliberate detour, not the home screen. (This is why the dashboard is the landing page and Chat was demoted.)
- **Live-animated execution graphs or moving-path canvases.** Static topology plus a status badge plus click-to-inspect covers oversight at a fraction of the cost. The Fleet tree is the right weight - do not upgrade it to a flow canvas.
- **A bespoke run-history table.** `git log` already IS the history, and Autopilot commits to a worktree. Duplicating git in-app fights files-as-memory - and Aidin wrote a git client (Loom) for exactly this.
- **Removable-in-name-only chrome.** Every element must collapse to near-zero when unused and never tax the fast path.
- **Onboarding theater.** No wizards, no tooltips-everywhere, no empty-state illustrations, no "getting started" banners in the main view. The dashboard stays a dense instrument.
- **Escalate-everything OR silently-fix-everything.** Both destroy trust. The calibrated asymmetric split IS the value of the gate.

The one recommendation from that report that has NOT shipped: a genuine agent-agnostic seam.
It was raised three times and costed at zero work, which it is not. Either make it real or stop raising it - the Gemini/Antigravity track is where that question actually lives now.

**Three journey seams still untested** (from the 2026-07-12 flow review, whose every other item shipped): a dual-mode relay plus jump-in resolving to ONE canonical session; first-mate to second-mate relay delivery; and retire-with-carry-over actually running its final summarize turn.
Filed as a Jot task rather than left in a report nobody opens.

**The habit that caused this.** A mock is a tool for agreeing on a shape, and it stops being useful the day the feature ships - but nothing ever retired one, so the gallery became a list of names with no way to tell live from dead.
Two changes: mocks get deleted when the feature they aligned on ships, and anything in a mock or report that is a DECISION rather than a picture gets written here at the time, not rescued a month later.

## 2026-08-02 - Auto-captain built end to end, still off

Task ea0546d1. The design was already settled (docs/auto-captain-design.md); this is what building it actually decided.

The dispatch reuses `runRelayTurn`, the path a first mate's relay already uses, with a new `allowDirect` flag for the deliberate captain -> second-mate route.
Writing a second dispatcher would have meant a second, less careful copy of the session locking and binding - the same mistake as the three archive menus, made on the one code path that spends money.

**A card judged unclear is not re-judged until the card CHANGES.**
Not in the design doc, and without it the feature is a slow leak: the triage would re-run every minute against the same words, forever, on every unclear card.
The subtlety that only showed up when tested: the fingerprint has to STRIP the auto-captain's own notes first. Holding a card back appends a note, the note changes the description, the changed description makes the card look edited, and the next pass judges it again and appends another note. The gate test caught that loop on its first run.

**An unbound list is a first-class refusal, not a triage verdict.**
A Jot list can be bound to a folder, and that binding is the only trustworthy answer to "where does this task's work happen".
Guessing from the list name would mean occasionally starting real work in the wrong repo, which is far worse than not starting it, so an unbound list is refused before the model is even asked - with a reason that says how to fix it.

**The on/off switch lives in the Auto widget, not in Settings.**
This is the one feature in Helm that spends money and changes a repo without being asked each time.
Putting the switch next to the list of what it has started means you cannot turn it on without seeing its output, and cannot look at its output without seeing that it is on. Turning it ON is confirmed; turning it off is not.

**No catch-up pass at startup**, unlike scheduled prompts. A queued prompt is something the user asked for at a moment that may have passed; an Auto card is a standing instruction, and firing a burst of them the instant Helm opens is exactly the surprise this must not produce.

Also fixed on the way: `startedBy` was READ by the Auto column and written by nothing, so that column could never have shown anything at all.
It is now stamped on the session record and carried through to the Fleet node.

Deliberately NOT verified: the live triage call and an actual dispatch have never been run. Every test reaches its decision without a model call or a spawned session, because a suite that fires real work would cost money on every run.
That last step is the "Run one pass" button with Aidin watching - which is what the design doc asked for, and the reason the toggle ships off.

## 2026-08-02 - Widget dashboard: three complaints, three unrelated defects

Aidin's review listed three things.
None of them were in the widget code, which is why the widget tests stayed green throughout.

WIDTH DID NOTHING.
The width menu offered 3,4,5,6,7,8,12 and style.css implemented `.wd-span-3` through `.wd-span-7` only, so choosing 8 or Full width silently fell back to 4.
Replaced the class table with one inline custom property (`--wd-span`) that the grid reads, so the widths the menu offers and the widths the stylesheet supports are the same set by construction.
The test measures the COMPUTED grid span for every width in the menu - the only evidence that a choice reached the layout.

NO WAY TO LEAVE A ROW SHORT.
Added two layout-only entries, Blank space and Row break.
Deliberately ordinary widgets with a different skin rather than a second rendering path, so they inherit drag, resize and remove for free.
A row break gets no width picker: offering one would be another control that visibly does nothing.

THE FLEET WAS CAPPED AT TWO.
Not a widget limit. mates.js declared that exactly two first-mate slots always exist, so the Add-widget menu could only ever offer the two that existed.
MATE_SLOT_COUNT is now a DEFAULT, with the count in config and a ceiling of 8 - each mate is a real coordinator with its own session and cost, so a large number is a mistake rather than a preference.
Adding is offered from the Add-widget menu because that is where he went looking for it, even though it is a fleet action.
Removal exists too, because a cap you can only raise is worse than a cap, and it lowers the configured count in the SAME step - retiring without lowering it would just have ensureMates recreate the mate on the next render.
Dismissing tears down that mate's second mates and re-packs the remaining slots; the floor is one mate.

CAPTAIN WAS EMPTY.
The widget dashboard passed RAW second-mate bindings to the widgets.
The captain's own sessions are not bindings at all - they are nodes derived from state.sessions by augmentSecondMatesWithSessions, which the widget path never called.
Measured on his real board: 10 derived direct nodes from 0 raw bindings.
It also meant the first-mate widgets had no live crew and no context gauges, and that a second mate archived on the classic board would have reappeared in the widget one.
Fixed by extracting buildFleetModel and having BOTH dashboards call it, with a test asserting neither re-derives the fleet on its own.
This is the same failure as the three archive menus and the file writers: two places deriving the same thing separately.
The pattern is now frequent enough to state as a rule - if two surfaces show the same thing they share a builder, and a test asserts there is only one.

## 2026-08-02 - Four stale tests were hiding behind each other

Chasing the above turned up four tests that had been failing, or passing for the wrong reason.
Worth recording because the pattern matters more than any one of them: a test that asserts an implementation detail rots the moment the detail changes, and a rotted test is worse than no test - it costs attention and teaches you to ignore the suite.

test-second-mate-archive read the dev repo's REAL config.json; the harness now sandboxes config to a temp dir, so the app's write went somewhere the test never looked.
It should never have been writing to his live config either.
test-settings-groups called a renderer function before renderer.js had evaluated, and asserted EXACT counts of settings groups, select rows and toggles - numbers that grow whenever a setting is added.
Counts became floors, which is the property actually worth protecting.
test-first-mate-surfacing built a synthetic session carrying only `status`, but the card has read `lifecycleState` since Epic f3d096fa.
The product was correct; the fixture tested a reader that no longer exists.
test-fleet-view expected a yes/no confirm modal for retire, which was replaced by the two-branch choice menu on purpose.
It now asserts both branches are offered.

## 2026-08-02 - Docs-drift nudge: only rows he can act on

Aidin's review killed the first version with one sentence: "jag vet inte hur jag ska anvanda den".
Of four rows on his board exactly ONE was actionable.
My own evidence had said the nudge found real drift immediately, which was true - and beside the point, because I never asked whether the rows could be acted on.
That is the reporting failure to remember: a signal can be correct and still be noise.

Four changes, all narrowing what is shown rather than changing how drift is measured.
1. A folder with NO version control is no longer counted as "couldn't be checked". Drift is counted in commits, and a folder with no commits cannot be behind any. His notes folder had been sitting in the unchecked counter looking like an unresolved problem. docsStalenessAsync now separates "not a git repository" (a complete answer) from git-missing or unreadable (a genuine failed look).
2. A project can be PARKED, reversibly. Without it a work repo he cannot touch stays on the list forever and teaches him to stop reading the section. Parked projects are counted in a footnote and un-parkable from the same place, so parking can never quietly hide drift.
3. When something genuinely cannot be read the project is NAMED with the reason. "2 of 14 projects couldn't be checked" was unusable.
4. Projects with no session activity for 60 days age out. His question - what happens as new projects accumulate and old ones never leave - was right, and my answer at the time ("at most 14 rows") was true that day and wrong over time. The candidate list is every project he has ever had a session in.

Alternatives rejected: auto-reconciling drift (writes without asking, and the point of the nudge is to route his attention, not replace it); dropping the section (the drift is real - loom is 15 commits behind); a global snooze (hides the actionable row along with the noise).
Deliberate: an UNKNOWN last-activity timestamp counts as active. A gap in the session record is not evidence of abandonment, and silently dropping a real drifting project is the worse mistake.
Real result on his board: four rows became two, both actionable, nothing in the unchecked counter.
The candidate filter lives in the lib (docsNudgeCandidates), not inline in main.js, because an invisible filter is the easiest place for a real project to disappear unnoticed - it needed to be testable on its own.

## 2026-08-02 - Correction: the atomic-write conversion had missed five stores

The commit for task efcaf486 said "one atomic write for all EIGHT durable stores".
That was wrong, and I only found out while chasing an unrelated test failure.
config.js, domains.js, goalRunHistory.js, mates.js and secondMates.js were still plain whole-file overwrites - including config.json, the most frequently written store in the app (quota readings, archive overlays, widget layout), so it was the worst one to miss.
Why the class guard did not catch it: the guard searched for a store that had rolled its OWN tmp+rename. A store with NO rename at all, just fs.writeFileSync, was invisible to it.
The guard tested the shape of the mistake I had already found, not the property I actually wanted.
New rule and new assertion: if a lib declares a HELM_*_PATH store seam it owns a durable file, and it must import the shared helper.
Append-only logs (helmUsage.js, usage.js) are exempt by name, and the test verifies each exemption is earned - appendFileSync present, writeFileSync absent - so the list cannot rot.
Third time this pattern has appeared: fix one instance, believe the class is closed. The counter-measure that keeps working is a guard written against the PROPERTY, not against the instance.

## 2026-08-02 - Startup no longer overrides a page you already opened

init() ends with navigateToPage("dashboard"), and it did so unconditionally after awaiting the first session refresh - seconds on a real board.
Anything opened during that window, the settings gear especially, was silently undone: the click appeared to do nothing.
Found because test-settings-groups failed two runs in three, which is the same event happening to a person who clicks quickly.
Startup now passes a flag and yields to a page the user already chose.

## 2026-08-02 - Every archive menu offers a handoff, folder or not

The topic-keyed handoff (task 663ab4b6) was added to one of THREE archive menus.
The sidebar context menu and the Fleet archive button both kept gating the option on session.cwd - so a session with no project folder, the exact case the feature exists for, was offered only "Archive without a handoff" and its knowledge was dropped in silence.
Aidin hit this archiving "Traning och kost (Hevy)".
One shared builder now, plus a test that fails if any archive menu is built outside it.
Mutation-checked: re-introducing the cwd gate in the Fleet button trips four independent assertions.
The cwd decides WHERE a handoff lands (repo HANDOFF.md versus a topic-keyed file in Helm's own store), never WHETHER it is offered.
That is stated in the builder so the next reader does not re-derive the wrong rule.

## 2026-08-02 - Scheduled prompts failed only in the installed app

Every store lib resolves its file as "env var, or a file next to the app".
In a packaged build the second branch points inside the read-only application bundle, which is why packagedPaths.js sets the env var for each store.
scheduledPrompts.js was added with the seam but never added to that registry, so queueing a prompt failed in the installed app and worked perfectly in dev.
Nine of ten stores were redirected; the tenth was the newest.
Guarded by a sweep that fails, and names the offending store, when a lib declares a seam packagedPaths.js does not redirect.
Same lesson as the atomic-write correction: a registry is a class, and a class needs a sweep, not a spot check.

## 2026-08-02 - The script runner had to say what it was doing

Aidin: "terminalen ar inte tydlig, vet inte ens om den funkar".
The mechanism was fine and test-repo-scripts.mjs passed throughout - it exercises the IPC, which was never the broken layer.
Everything missing was on screen: the menu listed script NAMES with no commands, the panel opened black and empty with a static "running...", and the outcome was an exit code.
Now the menu shows each command, the panel echoes the command and folder before anything starts, the header ticks a live elapsed count (proof of life for a script that prints nothing), and the outcome reads "done in 4s" or "failed after 4s [exit code 1]" at the end of the transcript as well as in the header.
Verified by driving the OVERLAY in the real app with real child processes rather than the IPC beneath it.
That test also caught a dead branch: npm always echoes a banner, so a "printed nothing" fallback could never fire. Removed rather than left in as unverifiable code.

## 2026-07-18 - Embedded Jot tab: Jot's renderer in a webview, backed by @jot/core

The visible half of "one Jot, two mounts" (docs/auto-captain-design.md). A "Jot" tab in Helm's nav mounts Jot's BUILT renderer in a `<webview>` (webviewTag enabled), with a preload (src/jot-webview-preload.cjs) that exposes the exact `window.jot` Jot's renderer expects - backed by the @jot/core host store via the IPC bridge (jotIpcBridge). So the identical Jot UI runs in Helm and standalone, over the same board, with no fork.
Flow: navigateToPage("jot") -> jot:mount (create the host store once + registerJotIpc, targeting the webview's webContents for state:changed) -> jot:paths (file:// URLs for Jot's out/renderer + the preload) -> create the webview. The host store points at the SAME board the user's standalone Jot uses (config.jot.path's dir, else the portable resolver).
Bridge collision handled: Helm already owns `dialog:pickFolder` (returns path|null, what Jot expects), so registerJotIpc skips it (skipChannels) - the webview's invoke falls through to Helm's handler.
Verified LIVE end-to-end: test-jot-tab.mjs seeds a temp board, opens the tab, and confirms the webview renders Jot's board AND shows the seeded todo via the @jot/core bridge.
Dev note: the webview loads jot's out/renderer via a sibling-repo file:// path; production packaging (bundle jot's renderer + publish @jot/core) is deferred. Remaining: iterate on placement/sizing per Aidin's review of the tab.

## 2026-07-18 - Jot data path is portable everywhere (removed the last hardcoded default)

config.js DEFAULT_CONFIG.jot.path was hardcoded to "D:\\Dropbox\\jot\\todos.json" - a machine-specific default that anyone else downloading Helm would inherit (wrongly), and which made the embedded Jot ignore JOT_DATA_DIR. Changed the default to null; both readers (lib/jot.js and jot:mount) fall through to jotDataDir.js's portable resolver (JOT_DATA_DIR, else the OS Jot dir) when no explicit path is set.
No behaviour change for Aidin: his config.json has jot.path persisted, which still wins. The default now only affects a config without a persisted path - where portable resolution is correct, not a stranger's Dropbox path. Completes the portability pass started in lib/jot.js.

## 2026-07-18 - Helm consumes @jot/core as its Jot data layer (foundation)

First Helm-side step of the Jot integration (docs/auto-captain-design.md): Helm now depends on `@jot/core` (Jot's framework-agnostic data core) via a `file:../jot/dist-core` dependency, and `src/lib/jotHostStore.js` creates a HOST-mode store bound to the SAME todos.json a standalone Jot uses.
Portable resolution (no hardcoded path): JOT_DATA_DIR override, else `join(app.getPath("appData"), "jot")` - identical to what Jot's own data-dir.ts resolves to. Helm can't reuse Jot's `app.getPath("userData")` (that returns HELM's userData), so it derives Jot's default from the roaming appData base.
Verified: Helm imports @jot/core and reads the real shared board (83 todos / 13 categories / 6 tags); the full Helm app still boots with the new dependency (test-render-coalesce E2E green).
NOT wired into Helm's startup yet - this is the tested data layer the embedded Jot tab (webview + core-backed preload) will build on. The auto-captain will write tags/lane-moves through this store.
Known caveat (deferred): the `file:../jot/dist-core` dep assumes jot is a sibling repo with `dist-core/` built (it's git-ignored). Fine for the local side-by-side setup; a clean distribution (npm-publish @jot/core, or bundle it at package time) is decided when Helm ships with the tab.
Separate follow-up: the pre-existing hardcoded `DEFAULT_JOT_PATH = "D:\\Dropbox\\jot\\todos.json"` in src/lib/jot.js should move to the same portable resolver (flagged).

## 2026-07-18 - Jot and Helm: one Jot, two mounts (separate products, shared core)

Driven by the auto-start feature (docs/auto-captain-design.md), which needs Helm to write to the board and react live - a shared todos.json with two writers races on the Dropbox-synced data dir.
Decision: keep Jot and Helm as SEPARATE products (Jot stays public/MIT/standalone; fast capture never needs Helm running; a Helm bug can't break the daily todo app), but with a stronger seam AND an embedded Jot tab in Helm.
The framing that makes it clean is "one Jot, two mounts", not two Jots:
Split Jot into a Jot-core (data + logic + events) and a Jot-UI component; both the standalone shell and Helm's Jot tab mount the SAME core + UI.
There is only one implementation, so functionality can't drift between the standalone and embedded views - the trap (reimplementing Jot's UI inside Helm) is explicitly avoided.
Data sync uses a host/client model: Jot-core runs as host (owns todos.json, emits events) or client (connects to a running host over a local socket) so there is always exactly one runtime writer - killing the Dropbox multi-writer race, and letting Helm ship independently (its bundled core runs host when the standalone app isn't present).
Bonus: when Helm hosts, the auto-captain talks to the same in-process core, so board writes are direct core calls, not file writes.
Accepted costs: refactoring Jot into core + UI (the real job, worth it for a single implementation) and the host/client coordination plumbing (the proper fix for the multi-writer problem, not a patch).
Alternatives rejected: absorbing Jot into Helm (kills its standalone identity, makes capture depend on a heavy app) and keeping the naive shared-file seam (two writers race on Dropbox - already seen as EPERM).
Start point: the Jot core/UI split is the foundation, tracked as a task in the Jot category.

## 2026-07-18 - Coalesce per-pane renders so streaming doesn't starve typing

Aidin (task f41a7f4e): "input lags when Helm is working on something else."
Root (found, not guessed): renderPane does a FULL transcript rebuild - `scroll.innerHTML=""` + re-append every turn + re-wire every button + a `scrollTop` reflow - and it fired SYNCHRONOUSLY on every streaming "assistant" event (one per content block). A busy turn drove several full O(turns) rebuilds back-to-back on the main thread, starving the textarea the user types in.
Fix (the safe, mechanism-verifiable part): `scheduleRenderPane` coalesces a synchronous burst to ONE rebuild and defers it, so queued keystrokes are dispatched before the rebuild. Terminal/user-initiated renders still call renderPane directly; renderPane cancels any pending scheduled render so the two never double-run.
Chose setTimeout(0) over requestAnimationFrame deliberately: rAF is throttled/paused when the window is hidden or unfocused, which would stall live streaming updates for a background session until the window regains focus - a worse regression for a live-monitoring app. (Caught this while testing: the rAF version hung the E2E in an occluded window.) setTimeout fires regardless of visibility and still yields to input.
HONEST SCOPE: this reduces render contention (coalesce + defer) but the per-event rebuild is still O(turns) - the deeper proper fix is incremental rendering (append only the new turn instead of rebuilding all), flagged as a separate task for when Aidin can verify the felt latency. Felt-latency can't be measured headlessly, so this ships the verifiable mechanism, not a claim that the lag is fully gone.
Verified: test-render-coalesce.mjs (burst -> 1 rebuild, deferred not synchronous, later burst still renders, direct-cancels-pending, per-pane isolation).

## 2026-07-18 - Quota readout shows the real limit status, not a fabricated 0%

Aidin (task 1975093d): "Token usage often shows 0% in the quota tab."
Verified against the REAL data (config.lastQuota, the persisted rate_limit_info): the payload is `{ status, resetsAt, rateLimitType, overageStatus, ... }` - there is NO `utilization` field. Both quota surfaces (the context popover + the Dashboard chip) computed `Math.round((q.utilization || 0) * 100)`, so with utilization undefined they ALWAYS showed 0% - a fabricated reading, not real usage. Almost certainly an API schema change: utilization was dropped in favour of status + resetsAt.
Fix: a pure `quotaReadout(q, nowMs)` reports the signal the API actually gives - the limit type ("5h limit"/"7d limit"), its status (allowed -> "OK" / allowed_warning -> "near limit" / rejected -> "limited"), and a reset countdown from resetsAt. A real % is shown ONLY when utilization is genuinely a finite number (future-proof if it returns). The popover no longer draws a misleading 0%-filled bar - it shows a plain status row when there's no %.
Chose "surface the real fields" over hiding the widget or leaving the 0%, per proper-fix-over-patches: the 0% wasn't a rounding bug, the whole input was wrong.
Verified: test-quota-readout.mjs (13 cases, driven off Aidin's actual payload + a utilization variant + status/reset/label edges).

## 2026-07-18 - Second mates carry the delegation directive on EVERY turn, not just fresh

Aidin (task 9c358433): "the 2nd mate no longer spins up autopilots, it does the work itself."
Verified before theorizing - built test-second-mate-dispatch-tools.mjs (a second mate DOES get helm_dispatch, so not a capability regression), then read his ACTUAL second-mate transcripts (last 7 days): EVERY one ground its whole assignment inline (beatdrop/crewline, up to 42 edits) with ZERO helm_dispatch calls - and the prompts were exactly the batch case ("work the Jot list", "take care of these N p0 tasks") the manual warns against.
Root: the full manual was appended only on a FRESH launch (`if (!resumeSessionId)`), but real second mates are almost always driven via jump-in/direct, so every turn passes resumeSessionId and the delegation directive was never re-stated - it relied on the manual still being in a context that compaction eventually drops.
(Important gotcha learned: --append-system-prompt is NEVER written to the transcript, so the manual's presence/absence can't be checked there - the behaviour is the only signal. This also means my first read of "manual missing" via transcript grep was a false negative; the behavioural evidence, 0 dispatches, is what stands.)
Fix: a FRESH launch still gets the full manual; a RESUMED turn now gets a condensed delegate-vs-do reminder (src/lib/secondMatePrompt.js), so the guardrail is on EVERY turn - like the first mate's is structural - without re-sending the whole manual each turn. Applied to both the jump-in (session:start) and relay paths.
Chose the reminder (a persistent, proper guardrail) over another instructions tweak, per the project's proper-fix-over-patches principle. Extracted the decision as a pure `secondMateAppendPrompt(resumeSessionId, fullManual)` so it's unit-testable (the CLI won't let us assert it via transcript).
Verified: test-second-mate-append-prompt.mjs (fresh->manual, resume->reminder, never dropped, reminder covers the batch case) + the capability E2E still green.

## 2026-07-18 - Sessions show "working" while a turn is live (authoritative live-turn override)

Aidin (task 5939df): sessions often showed "idle" when they were actually working - "statuses are generally out of sync with what's really going on".
Root: `deriveStatus` (sessions.js) is a pure transcript heuristic - it reads the last message's role + age. It has no way to see a LIVE turn: a long agentic turn outruns its ACTIVE_WINDOW (3 min) while the last transcript line is still the user prompt, so it decays to "idle" mid-run; and a mid-turn tool/assistant line makes it read "waiting". Exactly the long autopilot/second-mate turns Helm runs hit this.
Fix: Helm LAUNCHED the turn, so it knows the truth. A new `createLiveSessionRegistry()` (src/lib/liveSessions.js) tracks "a turn is running right now", refcounted by cliSessionId. Every launch path (interactive, second-mate relay, scheduled routine) marks its session id live for the turn's duration and clears it on done/error. sessions:get then forces those sessions to "active", overriding whatever the heuristic decayed to.
Refcounted (not a Set) so a rare fresh+relay overlap on one id stays live until both turns end. Internal launches (the hidden retire-summarize turn) are skipped - they're invisible to the captain, matching the other `!internal` bookkeeping.
Extracted the registry as a pure module so the logic is unit-testable without Electron (the isolating case - "live over a transcript that decayed to idle" - can't be reproduced live without a >3min turn).
Verified: test-live-session-status.mjs (force-active over decayed idle, match by either id form, refcount overlaps, done -> falls back, null guards). Live wiring mirrors liveChildren's proven mark/clear pattern across the same launch paths.

## 2026-07-18 - One canonical session display name everywhere (sessionDisplayName)

Aidin (task 953bbafb, with a screenshot): the SAME session showed two different names in two places - the archive-suggestion row in the needs-you queue read "vad gör den här appen, kan du förklara?" (the raw prompt title) while the Fleet card for the same second mate read "startup-simulator" (its fleet name). Confusing.
Root: the fleet-name resolution (`fm ? fm.name : sm ? sm.name : session.title`) was copy-pasted into some surfaces (sidebar row, chat pane header) but NOT others - the archive-suggestion row (dashProposeRowEl), the needs-you detail row, the OS "needs input" toast, and the archive page all used the raw `session.title`.
Fix: extracted one canonical `sessionDisplayName(session)` - fleet name for a first/second mate, else the prompt title - and routed every user-facing surface through it. The duplicated inline blocks were replaced with the helper too, so there's a single source of truth and a new surface can't drift.
Verified: test-fleet-ui-fixes.mjs (+4 assertions incl. the exact archive-suggestion row from the screenshot rendering "startup-simulator", not the prompt title).

## 2026-07-18 - "Fleet spend" is labeled as an estimate, not a subscription charge

Aidin (task 18d4c9f4): "what is fleet spend? I don't know where the $25 comes from - I'm on a subscription, not pay-by-usage."
The figure is real but mislabeled: it's Helm's OWN running estimate of what the fleet's model usage WOULD cost at API rates (addSpend sums each run's reported costUsd, which the CLI reports even on a subscription), used only as the guardrail behind the Stop button and the $ ceiling. Nothing is billed per use on a subscription - so a bare "Fleet spend $25" reads as money charged when it isn't.
Fix (labeling only, no behaviour change): the chip's display model is now a pure function `orchestrationChipContent(budget)` returning an "(est.)"-qualified label ("Fleet spend (est.) ~$25.40 / $100") plus a tooltip that says in words it's an internal estimate, not a subscription charge. Extracting the pure function also made it unit-testable without a live budget.
Kept `spentUsd`/ceiling semantics exactly as-is (the kill-switch still works on the same number); this only changes how it reads.
Verified: test-fleet-spend-label.mjs (7 cases: spend/no-ceiling/stopped/over/idle/none + tooltip wording).

## 2026-07-18 - Smart first-mate needs-you: suppress ONLY on a confident "done" signal

Follow-up to the 2026-07-15 revert (which restored the false-positive bias): Aidin asked whether we can actually tell if a first mate expects input - "look for a ?, or even let Haiku do a quick analysis when uncertain" - and to check both Swedish AND English phrases.
The safe way to trim the noise WITHOUT introducing a miss (the constraint from the revert entry) is to keep flagging by default and only stop when a classifier is CONFIDENT the turn finished (done, not awaiting input).
Two signals, both landing in `session.orchestratorTag` (keyed by session id): (1) a new cheap bilingual heuristic `expectsUserInputHeuristic(text)` seeded at turn-end from the first mate's last message (trailing "?", SV/EN ask-phrases -> waiting_for_input; SV/EN completion-phrases -> done_not_archived; anything ambiguous -> null), and (2) the existing Fas-3 Haiku sweep (`classifySessionStatus`) that already distinguishes the two.
Renderer gate (`classifierSaysSessionDone`): a waiting first mate flags needs-you on all three surfaces (queue row, fleet-card badge/accent, OS toast) UNLESS orchestratorTag is `done_not_archived`. A `waiting_for_input`/`stuck`/null tag (or no tag yet) keeps flagging - so a genuine question still surfaces, and the default stays over-flagging.
Only `done_not_archived` suppresses; the heuristic commits it only on a clear completion, otherwise defers to Haiku, otherwise flags. This honours "false positives over false negatives": the sole thing that silences the alarm is positive evidence the mate is done.
Verified: test-expects-input-heuristic.mjs (12/12, SV+EN) + 6 deterministic assertions in test-fleet-ui-fixes.mjs (no-tag -> flags; done -> calm "done", no accent; waiting_for_input -> still flags).

## 2026-07-15 - A meta-home session is a first mate only when bound to a mate (personal chats keep full MCP)

Aidin: "Helm doesn't see my Hevy connection." A personal session ("Träning och kost (Hevy)") rooted in the meta-home (/claude) lost its user MCP servers (Hevy, home-assistant, etc.).
Root: session:start applied the first-mate LEAN treatment - only helm_* tools, --strict-mcp-config (which strips the user's servers), and the first-mate manual injected - based on `isMetaHomeRoot(cwd)` ALONE.
So every personal chat the captain keeps in the meta-home was stripped of its MCP and mis-framed as a first mate (it worked in a session OUTSIDE Helm, which has full MCP).
Fix: a meta-home session is a first mate only when it is actually bound to a mate - `firstMateId = mateId || activeMates().find((m) => m.sessionId === resumeSessionId)?.mateId`, and the branch is gated on `isMetaHomeRoot(cwd) && firstMateId`.
A meta-home session with no mate falls to the normal-chat path: full user MCP, no first-mate framing, no helm_* tools. First mates (mateId set, or resumed-and-bound) are unchanged.
Verified: test-first-mate-gating.mjs - a no-mate meta-home session has NO helm-dispatch MCP in its transcript (so it keeps the user's full set), a mate-bound one does.

## 2026-07-15 - First-mate needs-you: keep it false-positive-biased (reverted the suppression)

4d82208a first read as "a first mate shows needs-you when it doesn't need me", so the first pass (commit f4de6da) suppressed it: a first mate's own "waiting" no longer flagged needs-you on any surface.
Aidin then clarified the priority: he would rather have FALSE POSITIVES than false negatives - better it says "needs you" when it doesn't than miss a mate that genuinely does.
The suppression traded false positives for false negatives (a first mate that actually asked a question would no longer be flagged, because status can't tell "asked" from "finished"), which is the wrong direction for him.
So f4de6da was reverted - the original behaviour stands: a waiting first mate with no crew shows "needs you" (queue row + card badge + accent + OS toast), a crew-waiting mate shows the calmer crew state.
This is a deliberate bias, not a bug: over-flagging is acceptable, under-flagging is not. If the noise ever needs trimming, do it only in a way that never introduces a miss (e.g. flag but rank lower), never by suppressing the signal.

## 2026-07-15 - Docs-drift: reconcile at wrap-up (the systemic, instruction-level fix)

Aidin flagged that docs always fall behind (beatdrop sat 10 commits ahead of its DECISIONS.md).
The passive mechanisms - the CLAUDE.md rule, the "document on the go" second-mate instruction, and the docsStaleness pill - didn't close it, because a busy work session skips the update and the pill only detects, never prompts.
Fix (systemic, instruction-level): added a wrap-up reconcile BACKSTOP to second-mate-instructions.md - before finishing a piece of work, handing off, or being retired, git-log the commits since DECISIONS.md was last touched and capture what slipped, treating "are my project docs current?" as an explicit part of finishing (like not leaving code uncommitted).
On-the-go stays the rule (an abrupt handoff never reaches wrap-up); this catches what on-the-go missed.
beatdrop's DECISIONS was already caught up by its own session (commit bb58452); added the one missing versioning entry so it is 0 behind.
The UI half Aidin also floated - making the docsStaleness pill an ACTIVE nudge - is captured as a follow-up task rather than shipped unattended (a UI/workflow feature deserves his review of the placement/behavior).

## 2026-07-15 - Retire shows a spinner while it archives its mates

88b7afe3: retire had no progress indicator while it tore down/archived its second mates - and retireMateClean had NO busy toast at all, so a clean retire (which now also summarizes a handoff per engaged child - real Sonnet turns) ran silently.
Fix: both retire paths show a persistent showBusyToast for the whole sequence, its text advancing through the phases ("saving handoff" -> "handing off <mate> (n/N)" -> "archiving"). showBusyToast gained an update() method for the per-mate progress.
Verified: toast update()/done() + test-retire-clean regression.

## 2026-07-15 - Second-mate attribution verified correct (2a5e6196 bounced "still in .406")

Aidin bounced 2a5e6196 ("still a problem in .406"). Rather than a third speculative fix (I'd mis-reasoned twice), I reproduced the exact scenario: test-second-mate-attribution.mjs starts a session with the SLOT-1 mate's mateId, has it call helm_create_second_mate, and checks the resulting proposal's firstMateId.
Result: PASS - the proposal is attributed to the slot-1 mate that created it, not slot-0. So the full chain (pane.mateId -> session:start -> HELM_MATE_ID -> request.dispatchedBy -> proposeSecondMate) is correct in the current source, backed also by test-fleet-ui-fixes' "resumed first-mate pane carries its own mateId".
So the code is correct. The ".406 still" is almost certainly PERSISTED proposals from BEFORE the fix (9c32e65): a mis-attributed binding in second-mates.json keeps its old firstMateId; installing a fixed build does not retroactively re-attribute existing bindings. New proposals attribute correctly.
Resolution for the user: install the fresh build; old mis-attributed proposals clear when their (wrong) parent mate is retired or they're archived - the code no longer creates new ones wrong. No source change; kept the reproduction as a regression test.

## 2026-07-15 - Token readout shows output, not the cache_read-dominated total

Aidin: "Helm drar jättemycket tokens jämfört med Claude Desktop" - Helm showed 1257.1k tokens for a turn while Desktop showed 1.1k.
Traced it (beatdrop transcript): Helm summed input+output+cache_creation+cache_read per assistant message, and the renderer summed those across a turn's steps; cache_read - the cached conversation context re-fed to the model on every step - was ~99% of the number, so a ~127k-context turn with ~10 tool-steps showed ~1.27M.
Desktop's number is output tokens. So Helm was not using more - it was DISPLAYING cache reads (billed at a fraction, and inherent to any multi-turn conversation; the actual generation per turn was 89-2116 tokens).
Fix: the launcher emits outputTokens alongside totalTokens; the UI (live ticker + the post-turn readout) shows outputTokens. totalTokens (full, incl. cache_read) is retained for the usage log / accounting.
Verified: parse + a real turn through the new plumbing (test-retire-clean).

## 2026-07-15 - Reopened pane shows a live turn as working (the REAL a39286b7 fix)

Corrected diagnosis: tracing the beatdrop transcript (fe77442b) showed the "hung" session never hung - it completed normally (end_turn at 21:53:51). It LOOKED hung because the pane showed idle (send icon, no spinner) while the turn was still running.
Root: openSessionInPane rebuilt the pane with no busy state tied to a live turn, and live events route via launchPaneHistory's pane-identity check, which bails after a navigate-away/reopen (the pane object changed). So the turn kept running headlessly while its reopened pane sat idle, then "suddenly" showed done on the next refresh.
(The earlier 5617272 - surface a turn that ends WITHOUT a result - was a valid but DIFFERENT scenario; it stays.)
Fix (3 parts): (1) a renderer `runningSessions` set, tracked on the "session"/"closed" events independent of the pane gate; (2) openSessionInPane reopens a session as busy when it's in runningSessions, so it shows working, not idle; (3) the event handler, on a pane-identity mismatch, redirects the event to whichever pane currently shows the same cliSessionId - so a reopened pane keeps ticking and gets the completion.
Verified: test-fleet-ui-fixes.mjs (reopening a running session shows busy; an idle one shows idle) + test-retire-clean (a real turn still runs session->working->done->idle through the rewritten handler gate).

## 2026-07-15 - Surface a turn that ends without a result (no more "looks hung")

a39286b7: a session that ended cleanly (exit 0) but WITHOUT a genuine CLI result event - e.g. it stopped after a tool call (ToolSearch/WebSearch) without concluding - fell through the "done" handler's branches (not a stop; not a code!==0 failure) into the normal-completion branch and went SILENTLY idle: composer showed the send icon (not stop), no loading spinner, no completion text, no error. It looked hung ("har den hängt sig?").
Fix: a dedicated `!sawResult` branch (code is 0 here - code!==0 is already handled above) keeps whatever streamed and pushes a visible "the run ended without finishing (no result) - press continue to resume" notice, and does NOT auto-fire a queued prompt (the turn didn't complete).
Normal completion (sawResult true) is unchanged - regression-checked via test-retire-clean (a real turn ends with sawResult true and still hits the normal branch).

## 2026-07-14 - Second mate shows its own session status under the first mate (not crew-only)

9ad82c28: a registered (crew-derived) second mate under its first mate read "idle" / "crew idle" while the SAME second mate showed as working (active) in the "needs you / in motion" list.
fleetSecondMateEl's badge + "now" line for a non-session-node reflected only crew state (anyLive/anyNeeds), ignoring the second mate's own session.
Fix: reflect the second mate's OWN session status first (active -> working, waiting -> needs you), falling back to crew state when there is no live session - so the fleet matches the in-motion list.
Verified in test-fleet-ui-fixes.mjs (a registered 2nd mate with an active session shows "working"; with an idle session shows "idle").

## 2026-07-14 - First-mate session binds to its mate SERVER-SIDE (root of the mis-attribution bugs)

3c52cc0d + 2a5e6196 (the latter reopened as "samma fel igen" - my earlier openSessionInPane pane.mateId fix was necessary but not sufficient).
A first mate's session was bound to its mate only in the RENDERER, on the "session" event, behind a pane-identity guard (`panes[entry.index] !== entry.pane` bails).
Typing a prompt in a first mate then navigating to the dashboard before it replied reassigned the pane, so the guard bailed and bindMateSession never ran.
The session was then never recognized as the mate's: it surfaced as a "direct" second mate under Captain (3c52cc0d), and because mate.sessionId was never set, a second first mate's dispatches mis-attributed to the slot-0 mate (2a5e6196).
Second mates already bind server-side (main.js session:start) for exactly this reason - the comment there even calls out the dropped-renderer-bind race. Fix: do the same for first mates - bind server-side on the session event when the launch is a first mate (meta-home root) with an explicit mateId, independent of any renderer/UI state.
The earlier pane.mateId fix stands (it fixes the resumed-pane dispatch config), but it sat downstream of a binding that, in the navigate-away case, never happened.
Verified: test-first-mate-bind.mjs (a first-mate session started with a mateId but NO pane still binds to its mate - which can only be the server-side path, since the renderer bind cannot run without a pane).

## 2026-07-14 - Archiving a second mate now sticks (archivedSecondMates overlay)

05166d55: archiving a second mate from its card archived the session + removed the DOM node, but a CREW-derived node re-derived from goal-run history and reappeared next refresh - "I archived it but it's still here".
Fix: a config overlay `archivedSecondMates`.
`archiveSecondMate` (new IPC) adds the id to the overlay AND drops its binding; the Fleet render excludes any second mate whose id is in the overlay, so it stays gone even when it would re-derive.
Crew autopilot runs are untouched (they stay on the Autopilot page) - the overlay only hides the second-mate NODE.
The archive button saves a handoff first (the existing "Save handoff to HANDOFF.md + archive" path; the label was corrected from the stale "DECISIONS.md"), per Aidin's "they should leave their handoffs too".
Also revised 58e9a433's retire teardown to use the same overlay (archiveSecondMateIds) so crew-derived children vanish on retire too, not just binding-only ones.
Retire teardown also leaves a handoff per ENGAGED child: saveSecondMateHandoffsFor summarizes each second mate that has a live session and writes its HANDOFF.md before retire archives it (proposed / crew-only children have nothing to summarize). Best-effort per child - a failed summary never blocks the retire.
Archiving a second mate is currently one-way (no restore path), matching how sessions worked; a restore could be added later.
Verified: test-second-mate-archive.mjs (binding dropped + overlay set + Fleet excludes it) + test-retire-teardown still green.

## 2026-07-14 - Removed the redundant Fleet proposals banner + the confusing Fleet count

b7f662fd + adcef9e9: the top "N topics proposed - engage one to start" banner duplicated the proposed second mates already listed under each first-mate card, and it let old never-engaged proposals accumulate as stale "engage me" chips.
The "FLEET N" header count showed the live-crew count, which read as "0" next to a populated fleet - confusing more than informing.
Aidin questioned both; both removed.
Proposals are engaged and managed under their mate card, in context; the Fleet header now shows no count (the per-mate cards convey liveness).
This supersedes the earlier idea of adding a dismiss-x to the banner - the right fix for a redundant panel is to remove it, not decorate it.
Dead CSS (.fleet-proposals*) removed too.
Related: 58e9a433's retire teardown + the dispatch smoke-test hygiene fix already cut stale-proposal accumulation at the source.
Verified in test-fleet-ui-fixes.mjs (no .fleet-proposals banner; no count in the Fleet head).

## 2026-07-14 - Resumed mate session lost its mateId, so dispatches stamped the wrong mate

2a5e6196: Aidin asked his SECOND first mate (Davy Jones) to create second mates; they appeared under the FIRST mate (LeChuck, slot 0).
Root cause: session:start attaches the dispatch MCP config via buildFirstMateMcpConfig(metaHome, mateId), which falls back to active[0] when mateId is absent, and the chat send passes mateId: pane.mateId.
The fresh-draft jump-in path set pane.mateId (paneOverrides), but openSessionInPane (the RESUME path) never set it - so jumping into an existing second first-mate session and acting stamped its dispatches onto the slot-0 mate.
Fix: openSessionInPane now sets pane.mateId + pane.secondMateId from the resolved mate (firstMateForSession/secondMateForSession, already computed for the title) - fixing both the first-mate attribution and the latent second-mate parallel (a resumed second-mate pane now attaches the right secondMateId too).
Verified in test-fleet-ui-fixes.mjs (a resumed first-mate pane carries its own mateId; a resumed second-mate pane its own secondMateId).

## 2026-07-14 - Retire tears down the second-mate subtree (Aidin's intent: option 3)

58e9a433: retiring a first mate orphaned its second mates - they vanished from the Fleet (their firstMateId pointed at the now-dead mateId) but their sessions/crew kept running invisibly.
Presented three options (re-parent to successor / surface as orphans / tear down); Aidin's intention was option 3 - retire = "I'm done with this whole track".
Fix (server-side, atomic in the mates:retire handler): tearDownSecondMatesFor(mateId) runs BEFORE retireAndRespawn (while the mateId is still the parent the second mates reference).
It archives each second mate's interactive session (applySessionArchive, refactored out of the session:archive handler) and drops its binding (new removeSecondMates in secondMates.js), for both proposed and engaged second mates.
Crew autopilot runs in goal-run history are deliberately NOT killed - they stay on the Autopilot page; force-stopping in-flight work would lose it.
The handler returns tornDownSessionIds so the renderer marks those sessions archived locally (reflectTornDownSessions), dropping them from the sidebar/fleet on the immediate re-render instead of after the next poll (same staleness gap the retire-flash fix closed for the first mate's own session).
Verified: test-retire-teardown.mjs (both second mates derive before retire; the engaged one's session lands in tornDownSessionIds; both bindings removed; neither lingers after) + test-retire-clean still green.

## 2026-07-14 - Mate naming consistent across all surfaces (sidebar + second-mate single-source)

Follow-up to the chat-header naming fix, which Aidin bounced as incomplete.
- 5fda2a96: the chat header showed the fleet name ("Captain Hook") but the SIDEBAR still showed the prompt-derived title for the same session.
rowEl hardcoded session.title; it now applies the firstMateForSession/secondMateForSession override, mirroring the chat header + needs-you queue.
- c48a4a22: a second mate's name in chat differed from the fleet.
The chat header resolves a second mate via secondMateForSession (matches cliSessionId OR sessionId - two id forms), but augmentSecondMatesWithSessions only skipped a session whose single id form was already in boundIds.
On an id-form mismatch a registered second mate slipped through and was re-emitted as a synthetic prompt-title "sess_<id>" node, so the fleet showed the prompt title while the chat showed the real name.
Fix: the augment skip now also consults secondMateForSession(sess), so a registered second mate is never re-synthesized - both surfaces single-source its fleet name.
Verified in the extended test-fleet-ui-fixes.mjs (sidebar shows the fleet name; a registered second mate on an id-form mismatch is not re-synthesized).

## 2026-07-14 - Second mate: load the delegate heuristic + a batch playbook (dispatch, don't grind)

Aidin jumped into a second mate and asked it to do 3 beatdrop Jot tasks; it did all 3 itself instead of dispatching Autopilot crew.
Same class as the first-mate gap, one tier down.
Verified in code: main.js:1645 appends second-mate-instructions.md, which says "Dispatch crew to do the actual work" but defers the actual delegate-vs-do-it-yourself JUDGMENT to orchestrator-instructions.md - a file that is NOT loaded into a second-mate session (only second-mate-instructions.md is appended).
So the deciding calibration was referenced but absent from context, and the model defaulted to doing the work.
Partly defensible - the second mate IS the hands-on tier, so trivial tasks (show version number) and underspecified ones (the Kid task, which it actually asked to clarify) are legitimately inline - but doing ALL three with zero dispatch is the miscalibration.
Fix (instructions-only; mirrors the first-mate playbook fix; deliberately NO tool-guard here, because unlike a first mate the second mate needs Edit/Write for its real validate/bugfix job): inlined the delegate-vs-do-it-yourself heuristic into second-mate-instructions.md instead of pointing at the unloaded doc, and added a "handed several tasks at once" playbook (one crew run per well-scoped task, partition files for concurrency, scout underspecified ones, trivial inline, then review + merge).
Not yet behaviorally smoke-tested: a faithful test dispatches real Autopilot crew runs (heavier + side-effectful) rather than the first mate's single create_second_mate call; offered to Aidin.

## 2026-07-14 - Tier-discipline guards: a first mate can no longer do hands-on work

Follow-up to the "first mate absorbs single-project work" fix (which was prompt-only).
Aidin asked whether we should have hard GUARDS so a first mate can't run away doing work in its own seat (ad17e2e6); Aidin approved layers 1+2 and delegated the layer-3 form to me.
Three layers:
- Layer 3 (hard, the core): a first-mate launch now passes `--disallowedTools Edit Write NotebookEdit Task` (FIRST_MATE_DISALLOWED_TOOLS in main.js, plumbed through launcher.js).
File mutation and sub-agent fan-out are structurally impossible in the coordinator seat - the beatdrop 23-Edit runaway can't recur.
Read/Grep/Glob/Bash stay for survey; the rare legit write (a Jot status tick) goes via Bash.
A deny beats the permissive permission-mode, so it holds.
Chosen over a path-scoped PreToolUse hook (deny Edit only inside project repos): the hook is more machinery AND still leaks via Bash-writes, so a blanket deny of the mutation tools is simpler and more robust.
HANDOFF.md is written by the app (context:saveHandoff), not the Edit tool, so retire is unaffected.
- Layer 2 (accounting): a first mate's OWN turn cost is now metered into the fleet budget (addSpend in the done handler, gated to !internal meta-home launches).
The budget/kill switch previously only counted dispatched-run cost, so an in-tier runaway was invisible to the ceiling; now it isn't.
- Layer 1 (detection): a new "hot" retire nudge fires when a first mate's session has run >= FIRST_MATE_HOT_TURNS (60) turns.
The beatdrop case was ~143 turns at ~12% of a 1M context window, so the ctx% gauge alone would never have flagged it - turn count catches what context% misses.
Verified (test-first-mate-guards.mjs): the hot trigger fires by turns; a live first mate's Write attempt created no file (denied); its own cost hit budget.json (spentUsd 0.44).

## 2026-07-14 - Fleet/chat UI batch: mate name in chat, retire flash, context gauge for all mates

Three p0 UI bugs, all fixed and E2E-verified (scripts/e2e/test-fleet-ui-fixes.mjs, deterministic, no API turns):
- 5fda2a96: openSessionInPane titled a mate-bound session by session.title (the prompt-derived title) instead of the mate's fleet name.
Fix: resolve firstMateForSession/secondMateForSession (mirrors the needs-you queue), which corrects every chat entry point at once since they all route through openSessionInPane.
- 96d34b98: retiring a first mate flashed its session under Captain tagged "2nd mate" for a few seconds.
Cause: the mate removal is read fresh (listMates) each render, but the archive flag only reached state.sessions on a later getSessions() poll - so for one render the session was mate-unbound AND locally-not-archived, which is exactly what augmentSecondMatesWithSessions classifies as a "direct" node.
Fix: archiveOutgoingMateSession sets backing.isArchived locally right after the archive IPC succeeds, closing the one-render window.
- bf1ea538: the context gauge only showed for the mate whose session was open in a pane (the only place context usage was known).
Fix: a per-poll bulk IPC (session:contextTokens) reuses estimateSessionContextTokens (a transcript tail-read) to estimate context for every mate session; the gauge prefers the live pane value and falls back to the estimate, so every first-mate card shows a gauge.
Bonus: the "ctx" retire nudge now fires for a saturated mate even when its session isn't open. contextWindowForPane was refactored to contextWindowForModel so the % is computable without an open pane.
Chosen over heavier alternatives (await refresh() before re-render for the flash; storing context on the session object for the gauge) - the fingerprint already carried the open-pane token count, so extending it was the minimal change.

## 2026-07-14 - First mate absorbs single-project work instead of creating a second mate

Two p0 Jot tasks (43982d2e "used a lot of tokens?", 508c03fc "why no second mate created?") were the SAME root cause.
Aidin told a first mate "Jag vill jobba med beatdrop" (I added a task to its Jot).
Instead of creating a beatdrop second mate, the first mate ran Bash to find the task, proposed to explore the repo and implement itself, and on the continue turn did Edit/Bash directly - 3.4-4.4M tokens burned in the meta-home-rooted first-mate context doing a second mate's job.

Diagnosed from the code, not guessed: the first mate DID have both the instructions (first-mate-instructions.md injected as appendSystemPrompt on a fresh turn, main.js ~1563) AND the tools (helm_create_second_mate + helm_relay_to_second_mate in FIRST_MATE_ALLOWED_TOOLS). So the failure was guidance, not missing capability. Three gaps let it happen:
1. No playbook for the most common request. The instructions covered morning-survey, multi-project ("fix all three"), and "continue", but not the singular "I want to work on project X" - the single most common captain ask. The model was left to guess and guessed "help directly".
2. helm_create_second_mate was framed as a morning-planning tool. Its description led with "propose a second mate (the daily loop's 'lay out A, B, C' step)", so on a singular request the model didn't reach for it.
3. The "no hands-on work" guardrail keyed on cwd ("in your own cwd"). The first mate `cd`'d into D:\Repo\Misc\beatdrop over Bash - real hands-on work that didn't trip a cwd check.
Compounding: "Direct access is always allowed" + "Don't become a standing relay" read as "single-project work shouldn't go through me", with no counterweight saying "so CREATE the second mate and hand the captain to it".

Fix (text/prompt only, no mechanism change - the create->Fleet->jump-in->Opus substrate already works and is tested):
- first-mate-instructions.md: added an explicit playbook for the singular "work on project X" request (look up the Jot task for the brief -> helm_create_second_mate -> point the captain at the Fleet), naming the million-token "quick look" as the role's most expensive mistake, and drawing the relay distinction (one-time hand-off = correct; routing ongoing work through yourself = the relay to avoid).
- first-mate-instructions.md: rewrote the "no hands-on work" bullet to key on the ACTION (never edit files / run builds / cd into a repo to work), not the cwd, closing the Bash-into-repo loophole.
- helmDispatchServer.js: reframed helm_create_second_mate's description to lead with "register a second mate ... for BOTH the daily-loop step AND your response whenever the captain names a single project", explicitly "INSTEAD of exploring the repo or implementing yourself".

Verified with a sandboxed live smoke test (scripts/e2e/test-first-mate-dispatches.mjs, throwaway git repo + temp meta-home, no real-Fleet side effect): given "Jag vill jobba med projektet X", the first mate's tool sequence was ToolSearch -> helm_create_second_mate, with zero Edit/Write - it dispatched on the first move instead of absorbing the work. One stochastic run, so signal not proof, but it directly confirms the tool-choice change.

## 2026-07-14 - Retire: carry-over is a choice, not automatic

Retiring a first mate always ran through `retireMateWithCarryOver`: it gave the outgoing session a final summarize turn, stashed that as `pendingHandoff`, and the fresh mate's composer was pre-seeded with "You are ... taking over from a retired predecessor. Their handoff: ...".
Aidin hit this in practice - jumped into a fresh first mate and found the composer pre-filled with the previous thread's orchestration handoff, when his usual reason for retiring is to START SOMETHING NEW, not continue.
Auto carry-over made "continue the thread" the default and "start fresh" the friction (you had to notice and clear a prompt you might not have read, with the risk of a fresh mate running off on the old job).

Decision: retire now offers an explicit two-option menu (`offerRetireChoice`), mirroring `offerArchiveChoice` - "Retire (start fresh)" and "Retire and carry over". Start-fresh is listed first (the common case).
"Start fresh" = new `retireMateClean`: no summarize turn, `retireMate(..., null, ...)`, blank composer.
"Carry over" = the existing `retireMateWithCarryOver` (summarize + pendingHandoff seed), unchanged.
Both still archive the outgoing session (shared `archiveOutgoingMateSession` helper).

Key point that made this safe: dropping the prompt carry-over does NOT lose the handoff. Durable continuity lives in `HANDOFF.md` on disk (the earlier HANDOFF.md-convention work); "start fresh" only skips seeding the composer, so a new session can still read HANDOFF.md on demand if the thread needs picking up later.
Alternatives rejected: (a) keep auto carry-over with a "clear" affordance - still the wrong default; (b) a persistent per-mate setting - over-engineered, the choice is per-retire by nature.
The persona-switch path (`retireMateWithCarryOver(mate, next)`) deliberately keeps forced carry-over: a persona switch is a faithful transfer of the same job, not a fresh start.

## 2026-07-12 (late3) - Orchestration flow: framing corrected, authoritative daily loop + resume requirement

Aidin pushed back on a misframing I introduced: I had presented "Option A (derived 2nd mate) vs Option B (real 2nd-mate agent)" as two end-states.
That was wrong. `orchestration-model.md` always defined B as the target (first mate Sonnet -> second mate Opus, the judgment tier that dispatches crew + reports up -> crew by complexity), with a PHASED path whose Phase 1 is "second mates as ephemeral runs, first mate dispatches directly - the model without the token bleed".
So the current build is Phase 1 OF B, a deliberate stepping stone - not a competing option. Corrected the redesign doc accordingly.

Authoritative daily loop (Aidin's own spec, now in orchestration-model.md "The daily loop"):
1. Start in the first mate: "what should I work on today? A, B, C."
2. First mate CREATES one real second-mate session (Opus) per topic.
3. Dual mode, captain's choice: orchestrate via the first mate (simpler, more tokens) OR jump into a second mate and work directly (cheaper, first mate dormant). Both must work.
4. Ask the first mate for a cross-project summary when done.
5. Retire.

New first-class requirement (all phases): DURABILITY + top-down resume.
Running out of tokens mid-run or closing the app must not lose the tree; typing "fortsätt" on the first mate must cascade resumption down (first mate -> second mates -> interrupted/quota-stopped Autopilot runs, each continuing from its durable state + notes.md).
Durable substrate already exists (dispatch queue, goalRunHistory with `interrupted`, worktrees+notes.md, --resume transcripts); what must be built: resumable runs (relaunch against the existing worktree), a resume-dispatch path, and the top-down cascade.

Next: Phase-2 build plan is written (orchestration-flow-redesign.md) - create real second-mate sessions, second-mate-dispatches-crew, report-up, first-mate-driven mode, model-per-tier - with hard caps + token budget + kill switch designed in first. Not built yet; awaiting Aidin's go on the plan. All docs updated (orchestration-model.md, orchestration-flow-redesign.md, PLAN.md, USING-HELM.md).

## 2026-07-12 (late2) - The REAL "2nd mate empty" + "Done errors on uncommitted"

After the cross-instance fix made the report roll-up surface, two DOWNSTREAM bugs remained (the actual thing Aidin meant):
1. Jumping into a second mate opened a BLANK session (`openFreshDraftInPane` with an empty prompt) - no idea the crew had just landed commits on branches, so no way to actually continue/review.
   Fix: `pendingSecondMateReviewNudge(sm)` (mirrors the first mate's `pendingTriageNudge`, judgment-tier framing) seeds the fresh session with the project's dispatched/terminal/not-acked runs - branch + commit count + needsCaptain each - and the task "inspect commits, verify the fix holds, merge the solid ones, flag the rest". jumpIntoSecondMate seeds it in the fresh-draft path. Verified in harness (lists the project's branches, excludes other projects, empty when nothing waiting).
2. The report-row "Done" trapped the run: its menu led with "Done + clean up worktree", which calls removeWorktree NON-force -> fail-closes on a dirty worktree (autopilot left uncommitted files) -> errored AND refused to acknowledge, so the run stayed stuck in the glance ("Done errors because it's uncommitted").
   Fix: menu now leads with "Done (keep worktree)" (pure acknowledge, no git, never errors); the "Done + remove worktree" option acknowledges REGARDLESS of cleanup success (a dirty-worktree failure keeps the worktree + toasts why, but no longer traps the run - the commits are what matter, the worktree is scratch).

## 2026-07-12 (late) - Cross-instance dispatch orphaning (2nd mate empty / 1st mate waiting)

Symptom: a first mate dispatched 3 autopilot runs; they completed with commits, but the 2nd mate showed empty and the first mate "waited" with no report-back.
Root cause (diagnosed from on-disk state, not guessed): the dispatch queue lives under the META-HOME (`D:\Dropbox\Mina Dokument\Claude\.helm-dispatch`), which is the first mate's root and therefore SHARED by every Helm instance rooted there - but each instance keeps its OWN mate + goal-run store (installed = `~/.helm`, dev = repo root).
Two instances were running (Aidin's installed app + the dev app I kept restarting this session for the mobile feature).
`main.js` processDispatchRequests claimed ANY request in the shared queue with no ownership check, so both instances raced to run the same dispatched goals - proven by identical goal branch names (`helm/goal-bc2be26e/-7cfe968b/-089b3aa6`) appearing under DIFFERENT goalRunIds in BOTH stores.
An instance that runs a goal dispatched by a mate it doesn't own records the run under a mateId absent from its store, so `terminalRunsBy(mate.mateId)` matches nothing -> empty roll-up + no `pendingTriageNudge` -> the first mate never gets its report-back.

Fix (full, chosen by Aidin over repro-first):
1. Ownership-scoped claiming - new pure predicate `isForeignDispatch(request, ownedMateIds)` in lib/dispatchCaps.js; processDispatchRequests skips (does NOT claim) any request whose `dispatchedBy` isn't a mate in THIS instance's store, leaving it for the owning instance. This is the systemic fix - it stops the double-run and the orphaning at the source.
2. Immediate report surfacing - main sends a `dispatch:report` push on report write; the renderer force-refreshes the dashboard so the crew report + "collect & continue" triage cue appear at once instead of up to a poll tick later (the fleet fingerprint doesn't track every facet, so a forced rebuild is needed).
3. Re-wake stays the EXISTING captain-driven path (jumpIntoFirstMate seeds `pendingTriageNudge` -> the mate runs helm_collect_reports). Deliberately NOT silent auto-resume: the first-mate design is dormant-until-invoked ("a dormant session bills no tokens"), and auto-driving risks a dispatch runaway. (a)+(b) make the cue reliably surface so the one-click re-engage works; that closes the loop while keeping the captain in it.

Operational: do NOT run two Helm instances against the same meta-home expecting isolated dispatch - (1) now prevents cross-claiming, but the dev app should ideally get its own dispatch root later. I kept the dev app DOWN after diagnosis.
Recovery for the current stuck state: the work is safe on branches helm/goal-{bc2be26e[5], 7cfe968b[5], 089b3aa6[2]} in worktrees; restarting the installed app rehydrates the 3 done runs so they surface under Jack Sparrow.
SEPARATE parked issue seen in passing: ~543 orphaned `.fleet-state.json.*.tmp` files under the meta-home - the EPERM-on-atomic-rename-on-Dropbox problem (Jot efcaf486); cleaned the orphans, root cause still parked.

## 2026-07-12 - Click-eat root cause, dev/installed separation, Continue-on-mobile

Fleet click-instability (recurring "clicks between first mates don't register") root cause finally pinned with REAL mouse input (Input.dispatchMouseEvent, not synthetic el.click - synthetic can't reproduce it): a FORCED dashboard refresh mid-press eats the click, a non-forced one doesn't.
`force` (bypass section fingerprints) had been conflated with "ignore the pointer-held guard"; navigating back to the Dashboard fires an async forced fill that can swap the fleet slot while you press the next card.
Fix: the pointer guard now defers forced refreshes too, carrying the force flag through the deferred flush (so the archive spinner / rename restore, whose state the fingerprints don't track, aren't lost).
Lesson reinforced: a UI-race E2E must inject REAL input; the earlier synthetic tests were green while the bug was live.

Dev vs installed data dirs: kept DELIBERATELY SEPARATE (Aidin's call) rather than shared.
Dev (npm start) reads store files from the repo root; installed reads ~/.helm - so their Helm-own overlay (mates, helmSessions, archive/hide) differs, which read as a bug when the two windows looked identical.
Rejected sharing one JSON store because Aidin runs both apps concurrently and two writers race (last-write-wins corruption).
Instead the dev build is now marked unmistakably: app:isDev IPC -> a filled violet DEV pill + a violet header stripe (body.dev-build), shown only when !app.isPackaged.
NOTE on Claude Code sessions (verified): those ARE shared - both apps read the same claude-code-sessions store (dev via the MSIX overlay at %APPDATA%\Claude, installed via the globbed package LocalCache), plus the same ~/.claude/projects transcripts; only Helm's own overlay diverges. Helm never writes Claude sessions, so no corruption risk there.

Researcher persona added (4th, alongside Architect/Teacher/Red team): investigative temperament - evidence from sources, verified-vs-assumed, cites, surfaces gaps.

"Continue on mobile" (hand a Helm session to Remote Control): a per-card 📱 button spawns a NEW terminal running `claude --resume <cliSessionId> --remote-control --name <title>` in the session cwd (lib/remoteControl.js).
KEY finding (verified 2026-07-12): Remote Control needs a real TTY - `claude --remote-control` with non-TTY stdin falls back to --print and errors, so Helm's headless `claude -p` launcher CANNOT host RC; it must open a real terminal window (which also surfaces the session URL/QR + any RC eligibility error directly to the user).
Covered by a pure unit test (arg/script/guards) + a UI test (button renders on bound-session cards); the final real click (opens a terminal, scan QR on mobile) is left to Aidin since it needs his account + phone.
All of today's items are in Jot "review", not blessed to done.

## 2026-07-11 (late) - Report-back reworked + the day's other decisions & lessons

CORRECTION to the "Tiered report-back phases 1+2 shipped" entry below.
After Aidin reviewed it in the live app, the captain-DASHBOARD report-back section was REMOVED entirely (commit c327e5e).
Reports now live ONLY under their dispatcher (the first-mate card roll-up); anything that needs the captain surfaces in the needs-you queue, which became a grid (the archive-proposal nudge spans full width).
Consequence: a clean captain/Autopilot run (no dispatcher) has no dashboard report surface - it shows in needs-you only if it needs action, else on the Autopilot/Goal page.
So that earlier entry's "Captain Dashboard report-back carries..." no longer holds - this supersedes it.

Other decisions/changes today (all in Jot "review", not yet blessed to done):
- Installed app shares a data dir (commit 54694b0): packaged stores resolve to HELM_DATA_DIR || ~/.helm, NOT the per-install userData.
  This REVERSES the earlier "deliberately independent userData" decision (see the older packagedPaths entry) - independent userData is what made the installed app start blank.
  UNVERIFIED on a real packaged build; needs a rebuild + run to confirm (and if sessions specifically are still missing, that's a separate packaged-runtime bug).
- Archive-with-handoff skips the handoff for thin sessions (<4 transcript turns, commit 706c79b): a throwaway test session had polluted DECISIONS.md with a "no task work was done" handoff. Fail-open on an unknown turn count.
- Version single-sourced from git (commit f9c37d4): scripts/build.mjs (the new dist/release entrypoint) stamps major.minor.commitcount into BOTH the packaged app (src/lib/build-version.json, read when git is absent) and the installer (electron-builder extraMetadata), so app + installer + dev all agree.
- New brand logo (commit ff805de): terracotta ship's wheel, cream background keyed out by orange-ness (R-B), tight-cropped; assets/helm-logo.png.
- Settings: every section always tops its own column (nowrap + horizontal scroll), not wrap-stacked.
- 6 new themes (fantasy, superhero, cyberpunk, western, noir, evil) - full var-map + icons + mate name pool each.

Process decisions:
- Completed-task workflow: finished work goes to Jot "review"; Aidin blesses "done" jointly after reviewing (auto-marking done removes his oversight). Saved as a memory.
- Testing discipline: an E2E must drive the REAL trigger path, not a synthetic/forced one - synthetic tests passed while the real behavior stayed broken TWICE this session (the archive spinner and the composer focus).

State-of-play + what remains is in PLAN.md "Current status (2026-07-11)": feature-nearly-complete; remaining is de-risking (verify the packaged app; a real daily-use dry run), not building.

## 2026-07-11 - Tiered report-back phases 1+2 shipped (routing + grid + mark-done/cleanup)

Built the first two phases of the tiered report-back design (see the 2026-07-11 design entry + docs/orchestration-model.md).

Phase 1 (commit 888bda6): a terminal run now reports to whoever dispatched it.
The Captain Dashboard report-back carries only captain/Autopilot-initiated runs (dispatchedBy null) plus mate-dispatched runs that need the captain (commits-ready / escalated / failed) - the escalate-up path.
Handled mate runs collect under their first mate's card in a collapsed roll-up ("Crew reported back: N - M need you") that expands to the rows.
The Dashboard report list became a responsive grid (~2-3 columns) instead of one full-width row each (Aidin's "bygg dessa på bredden"); the needs-you queue stays a single priority-ordered column.

Phase 2 (commit 45b0f1e): a "Done" control on every report row.
Done is a soft acknowledge (config.acknowledgedGoalRuns, mirroring acknowledgedSessions) - the run leaves the report-back glance surfaces but stays in history + on the Goal page.
A run with a worktree offers "Done + clean up worktree" (removes the worktree, and deletes the branch ONLY if merged into the repo's primary branch - unmerged branches are kept) or "Done, keep the worktree".
New lib/worktree.js helpers primaryBranch/isBranchMerged/deleteBranch; IPC goal:cleanupRun.

Phase 3 (feed a mate-dispatched run's result back INTO the mate's session so the mate can triage) is deliberately NOT built yet - it touches the session/launcher layer and has an open design fork (delivery mechanism + how the mate acts on the reports).
Left for an explicit decision with Aidin rather than picking a shape unilaterally.

## 2026-07-11 - Report-back is tiered: runs roll up under their dispatcher, escalate up, and are markable-done with cleanup

The shipped flat Dashboard REPORT-BACK section (task 70390331) dumped every terminal run onto the Captain's dashboard regardless of who dispatched it.
Aidin flagged that this collapses the orchestration tiers - the captain becomes first responder for every crew run, which is exactly what the tiers exist to avoid.

Decision: a run reports back to whoever dispatched it (`dispatchedBy` is already on the run object).
Mate-dispatched runs collect as rows UNDER that mate's DIRECT card (the card is the roll-up + expandable for drill-down); captain/Autopilot-initiated runs (dispatchedBy null) stay on the Dashboard.
"Both, not either" (Aidin's words): the dispatcher compiles/summarizes AND the individual runs stay openable for micro-analysis.
Runs that need the captain (failed/escalated/commits-ready) still escalate UP to the Dashboard even when a mate dispatched them; the handled ones stay under the mate.

Alternatives rejected: (a) keep it flat on the Dashboard - rejected, it's the tier-collapse Aidin objected to; (b) escalate-only, nothing under the mate - rejected, he wants the dispatcher to be the collection point AND retain drill-down, not just a filtered captain view.

Also required: a Done action per row.
Baseline = acknowledge (non-destructive, clears from needs-you, modeled on acknowledgedSessions).
If the run used a worktree/branch, Done also cleans it up via `git worktree remove --force` (never `rm -rf` a worktree with a node_modules junction), then branch deletion GATED on a merged-to-main check + confirm (worktree removal is safe; dropping unmerged commits is not).

Honest scoping: view-routing (group rows by dispatcher) is the easy half; feeding a mate-dispatched run's result back INTO that mate's session so the mate can actually triage is the hard half and the real point - today the dispatching session learns nothing when its run finishes.
Full design in docs/orchestration-model.md "Tiered report-back". Tracked as a Jot task extending 70390331.

## 2026-07-10 - Autopilot C2 part 1: project-aware config proposal

Built the smart translate step on top of C1. The Autopilot button is now "Set up run": clicking it fires a quick project-rooted `claude -p` (sonnet/low, `autopilot:proposeConfig` in main) that reads the repo + the goal and PROPOSES the crew config - verifyCommand, maxIterations (sized to the goal), model/effort, escalate, and a one-line rationale - instead of C1's deterministic defaults. It populates the Advanced fields (a manual Advanced override still wins) and shows the plan + config in the approve-summary before the run. Output is parsed as JSON with a defaults fallback if unparseable; best-effort, never blocks.

Proven live: for "add a doc comment to package.json", it proposed verify = `node -e "JSON.parse(...package.json...)"` (reasoning that JSON has no comments so validity is the right check), 1 iteration (trivial goal), sonnet/low - i.e. a genuinely project+goal-aware config, not a template.

C2 part 2 - session-spawns-dispatch + structured report-back (a mate launching these runs itself and streaming results back; orchestration-model phases 1-3) - is the remaining big follow-on, NOT built.

## 2026-07-10 - Autopilot reframed intent-first (C1 of the rework)

Built the small pass (C1) of the Autopilot rework (proposal: docs/autopilot-rework-proposal.md), after Aidin approved the direction. The page now leads with INTENT - goal + project folder - and the crew knobs (max iterations, model/effort, verify command, escalate) moved into a collapsed "Advanced" section you only open to override. Verify is auto-detected from the project (existing suggestVerifyCommand, on folder change). Start no longer fires immediately: it shows a one-line approve-summary of the derived config ("Run autopilot in X - verify: …; up to N iterations; model: …; escalate: … Start?") via customConfirm, so the captain approves the "how" before the crew run. The raw primitive is unchanged underneath; only its framing moved.

C2 (a project-aware second-mate step that reads the repo + goal to propose the config, plus session-spawns the dispatch with report-back, per orchestration-model phases 1-3) is the follow-on, not built here.

Verified via CDP: intent-first form, knobs under a collapsed Advanced, Start shows the approve-summary without running; 0 console errors.

## 2026-07-10 - Helm owns + runs its routines (not a read-only mirror)

The Routines page was a read-only mirror of Claude Desktop's scheduled tasks (name/description only). The rich data (cron, next/last run, enabled) lives in the Desktop app's private internal store, reachable only via its built-in scheduled-tasks MCP - i.e. only from an agent context, not a file Helm can read (verified: the task folder has just SKILL.md; the state isn't in any readable file, and the direct store is opaque/overlay-trapped/locked). So "see + manage from Helm" was blocked.

Aidin's reframe (chosen over an ugly `claude -p` MCP-harvest): Helm should OWN routines in its own format, same as it owns the session index + archive overlay. And Helm is fundamentally a session-launcher, so "run this `claude -p` on a cron" is native.
- `src/lib/cron.js`: dependency-free standard 5-field cron evaluator (minute-stepping; local time; dom/dow OR-semantics). Chosen over a library since Helm had no cron dep and correctness here is unit-testable.
- `src/lib/helmRoutines.js`: routines.json on D:\ (readable/manageable), full CRUD, nextRunAt via cron, dueRoutines/markRoutineFired.
- main.js: `fireRoutine` launches the prompt via the normal launcher (bypasses the session:start HANDLER, so a routine at the meta-home is a plain session, never a first mate) and records it as a "⏰ <name>" session. Scheduler = a 1-min interval + a catch-up pass at startup (advance-then-fire, so a routine that missed slots while Helm was down fires ONCE).
- Routines page: full CRUD (see schedule/next/last/enabled, toggle, run-now, edit, delete, add). Old read-only `lib/routines.js` deleted.

Accepted trade-off (Aidin's call): a routine only fires while Helm is running; missed ones fire once on next startup - in exchange for full control + visibility + it living in Helm. Migration: the two Desktop scheduled tasks were recreated as Helm routines (enabled); the Desktop copies were left untouched (a safety net until the wall-clock timer is trusted), so they may double-fire until Aidin disables/deletes the Desktop ones. NOT auto-deleted - no destructive action on another app's store while he was away.

Verified: 20/20 cron+store unit assertions; CDP - the 2 migrated routines render with next-run, CRUD round-trips, invalid cron rejected, 0 console errors. NOT yet verified: an actual wall-clock timer fire in production (logic/wiring tested, not a real-time fire).

## 2026-07-10 - Mouse back/forward = app view history; Ctrl+1/2/3 quick nav

Two navigation asks. The mouse side buttons (back/forward) previously drove only the FOCUSED pane's chat-session history and did nothing off the chat view. Aidin wanted them to navigate across the WHOLE app. Added an app-level view-history stack (`viewNavStack`/`viewNavIndex`) that `navigateToPage` pushes to (collapsing repeats, truncating the forward branch on a new nav); the mouse buttons now walk that. The ←/→ header arrows keep the per-pane chat-session history (`paneNavHistory`) - two deliberately separate axes: mouse = whole-app views, header arrows = within-conversation.
Also added Ctrl+1/2/3 = Dashboard/Analysis/Archive quick nav (mirrors the header tabs), the "fast key to the dashboard" he asked for; skipped while the command palette is open.

Verified via CDP: mouse back walks archive→analysis→dashboard and forward returns; Ctrl+1/2 navigate; 0 console errors.

## 2026-07-10 - "First mate" = bound to a mate, not just rooted at the meta-home

A personal chat rooted in the meta-home dir (the Claude rules folder) - e.g. "Träning och kost (Hevy)" - was wrongly tagged "◆ Helm" and shown the "first mate X% full - hand off" nudge, because `isOrchestratorSession` keyed purely on `cwd === orchestratorHome`. That was the original (pre-named-mates) signal; it over-matches now that the captain also keeps personal chats in that dir.
Refined it to: a session is a first mate iff it's BOUND to an active mate (its cli/session id is in some `mate.sessionId`). refresh() now fetches active mates each poll into `mateSessionIds`. A brand-new mate session binds on its first turn; until then the pane carries `isOrchestrator` via paneOverrides, so the composer nudge still works during that window. `manualHelmSessions` in config was already dormant (unused), so nothing else depended on the old signal.

Verified: CDP - the real Hevy session (at meta-home) no longer classifies as orchestrator; a synthetic meta-home session classifies only when its id is in `mateSessionIds`; 0 console errors.

## 2026-07-10 - A theme carries identity (icons + mate names), not just colors

Review feedback on the theme system: add more themes (a "space" theme), and have the theme also swap the ICONS - and Aidin chose to swap the mate NAMES too. So a theme is now an identity, not only a palette:
- **Colors:** `:root[data-theme="space"]` - dark cosmic (deep blue-black ground, nebula-violet accent, starlight highlights).
- **Icons:** a per-theme icon set in the renderer (`THEMES[].icons`): nautical (dark/brass) keep the ship's-wheel logo asset + ⚓ anchor; space uses a 🛰️ logo glyph + 🚀 anchor. The header brand logo swaps img<->glyph in `applyTheme`; fleet cards read `themeIcons()` at render.
- **Names:** `mates.js` has per-family name pools (nautical vs space) and picks from the active theme's pool for new/respawned mates. On a theme switch that crosses families, `rethemeMateNames(from,to)` renames the active mates from the new pool, preserving id/slot/session/persona. Within a family (dark<->brass) it's a no-op, so toggling light/dark never clobbers a name (including a manual rename).

Also fixed the Settings layout per the same review: `.settings-columns` was an auto-fit grid that packed a short group (Appearance) under a taller one; switched to flex-wrap so each group heading tops its own column and wraps cleanly.

Verified: 6/6 retheme unit assertions (family swap vs no-op, id/persona preserved) + the existing mate tests still green; CDP live - space swaps --bg/--accent + logo glyph (🛰️) + fleet anchor (🚀) and reverts to nautical; 0 console errors.

## 2026-07-10 - "Removed from Helm" honored consistently across all derivations

Follow-up to the archive fix below, which flagged that the Fleet Direct derivation filtered only `isArchived` while the sidebar also honored `hiddenSessions` - so a session "removed from Helm" still showed as a Direct card (and, it turned out, leaked into more places).
Audited every consumer of `state.sessions` (grep `!s.isArchived`) and found the hide was honored in exactly one place (the sidebar's top-level list) and missed everywhere else: Fleet Direct, the sidebar's own group members, the dashboard needs-you/in-motion queue, the archive-proposal list, the command palette, the jump-in fallback (`mostRecentSessionForCwd`), the OS attention toast in `refresh()`, and the taskbar badge.
Fix: a single `isHiddenFromHelm(session)` predicate in renderer.js (keyed on `sessionId`, matching what `removeFromHelm` writes), applied at every one of those sites - the convention is now "don't re-inline the membership check."
Also excluded hidden sessions from the main-process orchestrator sweep (`main.js`): a session the user removed from Helm must not be silently auto-classified or, more importantly, auto-COMPACTED (a mutation) in the background. `main.js` inlines a `Set` there rather than importing the renderer helper (separate process).
Deliberately left alone: `knownRepos` derivations (hiding one session shouldn't make Helm forget the project) and the Archive page's own "Removed from Helm" section (that's the restore UI, it must list hidden sessions).
Kept distinct from archived (`config.archivedSessions`, applied as `isArchived` in `readAllSessions`) throughout - they're separate concepts.
Verified via a new CDP E2E (`scripts/e2e/test-hidden-sessions-filtered.mjs`): a hidden session is absent from the sidebar, Fleet Direct, and the attention queue, while a sibling visible session in the same cwd stays; 0 console errors.

## 2026-07-10 - Helm usage analytics (local, content-free)

Instrument Helm's OWN usage - which views Aidin visits and the navigation paths he takes - to inform later UX calls (e.g. "is the chat list needed", the Autopilot-as-primitive rework). Deliberately separate from usage-log.jsonl (that's per-prompt model/effort/cost, already surfaced on the Analysis page); this is app-interaction telemetry.
- `src/lib/helmUsage.js`: append-only `helm-usage.jsonl` beside the app's other stores (D:\, gitignored, NOT %APPDATA%). `trackHelmUsage(event)` + `summarizeHelmUsage()` (per-view counts, A→B transitions within a sitting, action counts, time span). HELM_USAGE_PATH test seam.
- Content-free by construction: only view names / action ids + timestamps, never session content. Single-user, local - no upload, no consent surface needed.
- Instrumented at the single nav chokepoint (`navigateToPage`), fire-and-forget so analytics can never break navigation. Transitions reset across a >30 min gap so separate sittings don't fabricate an A→B move.
- Surfaced as two Analysis-page blocks ("Your Helm views", "Top navigation paths"). v1 is nav-only; per-action events are supported by the schema (`type:"action"`) but not yet emitted at call sites.

## 2026-07-10 - Theme system (tokenized colors + selectable themes)

Turned the app's colors into a real theme system instead of a one-off palette. Two parts:
- **Groundwork:** tokenized the ~20 distinct hardcoded hex/rgba values that lived OUTSIDE :root into semantic tokens - added `--on-accent`, `--accent-hover/-active`, `--danger/-hover/-active`, `--on-danger`, `--bg-inset`; folded near-duplicates into existing tokens (`--waiting`, `--good-bright`, `--bg-sidebar`, `--bg-card-hover`); rewrote accent-tinted rgba as `color-mix(... var(--accent) ...)`. Without this a theme wouldn't bite everywhere.
- **Themes:** `:root` (+ `:root[data-theme="dark"]`) is the default dark map; `:root[data-theme="brass"]` is a warm light theme. A theme is a full var-map swap, room for more by adding a CSS block + a `THEMES` entry. Selector in Settings > Appearance, persisted as `config.theme`, applied on `<html>` via `applyTheme` on boot and every refresh. The app picks its theme explicitly (NOT prefers-color-scheme) so light/dark is a deliberate choice; `color-scheme` is set per theme so native controls follow.

Scope call: left the pure-black `rgba(0,0,0,x)` box-shadows and modal backdrops as-is - shadows and a modal's page-dimming backdrop are conventionally black-based in both light and dark themes, so tinting them warm would look wrong. `.lavish-frame`'s `#fff` also stays (it's a mockup preview canvas, deliberately white).

Verified: computed-style swap (full token map + color-scheme flips dark<->brass), the Settings selector renders, 0 console errors. (Couldn't capture a screenshot - the CDP harness's screenshot call was timing out this session; token-level computed-style checks are the more reliable proof anyway.)

## 2026-07-10 - First mate: look up Jot before asking, dispatch per project

The first mate, asked "I have a logo task for beatdrop, jot and loom, fix all three", asked the captain to re-explain what the logo task was - instead of reading the tasks that were already in Jot, and instead of dispatching one per project.
The base instructions already said "read the Jot board" and "dispatch to second mates", but not concretely enough to override the reflex to interrogate.
Added a "Look it up before you ask" section to first-mate-instructions.md: when the captain references work by name, read the matching Jot task(s) (text/description/images in D:\Dropbox\jot\todos.json, jot-task-tracking skill for the mechanics) BEFORE asking; only ask when the detail genuinely isn't there. And a multi-project request is a dispatch-per-project instruction, not one session doing all three inline (that's the hands-on work this tier must not do).
Prompt-only change; no code path affected.

## 2026-07-10 - Archive is Helm-owned (fix: "archive keeps coming back")

A Direct session kept reappearing no matter how many times it was archived. Diagnosed with the `diagnosing-bugs` skill: the archive CODE was correct (reproduced green in an isolated instance - the flag stuck), so the bug was environmental. Root cause: for a Desktop session, archive wrote `isArchived` into the desktop app's own `local_*.json` under `%APPDATA%\Claude` - a file the (MSIX-packaged) Claude app owns and rewrites, dropping Helm's flag. Writing a flag into another app's live state could never hold (exactly the fragility the "hard-won gotchas" section warns about).

Fix: archive is now **Helm-owned**, same pattern as the session index. A new `config.archivedSessions` list on D:\ is the authoritative overlay: `readAllSessions` forces `isArchived=true` for any listed id (applied to the meta BEFORE buildSession so derived status is `archived` too), and it can't be reverted by another app. `session:archive` adds/removes the id there; it still best-effort mirrors into the helmSessions index or the desktop file so other views stay consistent, but the overlay is what holds the line. Unarchive removes the id.

Honest note on the loop: the external revert itself was NOT reproducible in the harness (a fresh instance archives cleanly), so the desktop-rewrite root cause is strongly indicated, not proven red. The fix is robust regardless of the exact revert trigger - it removes the dependency on a file another app owns.

Distinct from `hiddenSessions` (a permanent "remove from Helm's view"); archived sessions stay listed on the Archive page and are restorable. Latent inconsistency spotted in passing (not fixed here): the Fleet Direct derivation filters only `isArchived`, while the sidebar also honors `hiddenSessions` - flagged separately.

## 2026-07-10 - Slash-command menu in the composer

The composer never had a `/` menu (typing `/` did nothing - a missing feature, not a regression). Added an autocomplete that opens when the composer text is a bare `/token`, listing the skills + custom commands available to the pane (global `~/.claude` + project `cwd/.claude`, project overriding global). Arrow/Enter/Tab select, Esc closes; selecting inserts `/name ` so args can follow before send.

Key decision - what to list: **skills + custom commands only, NOT built-in TUI commands.** Verified empirically (throwaway command -> `PINGPONG_OK`, throwaway skill -> `SKILL_PONG_OK`) that `claude -p "/name"` DOES execute both - which is what makes the menu real rather than cosmetic, since Helm sends the prompt through `claude -p`. Built-ins (`/clear`, `/compact`, `/model`, ...) are interactive-only and no-op through `-p`, so listing them would be a trap.

Implementation notes: `src/lib/slashCommands.js` reads name/description from each item's frontmatter; the renderer's slash keydown handler is registered BEFORE the Enter-to-send handler and calls `stopImmediatePropagation()` while the menu is open, so Enter selects instead of sending. Found + fixed using the `diagnosing-bugs` skill (build a red-capable loop before theorising): the loop here was the two `claude -p` probes that proved slash execution works headless.

## 2026-07-10 - Mate personas: a per-spawn temperament overlay

A first mate can now carry an optional persona - a temperament overlay appended to the base operating manual at launch: architect (critical, stress-tests the plan), teacher (pedagogical), red-team (adversarial).
The base manual defines HOW a mate operates in Helm (dispatch tools, handoff discipline); a persona colours the temperament it brings to coordination, so the two layers stay cleanly separate.

Key decisions:
- **Per-spawn, not per-slot.** A persona belongs to the task, not the name - the same slot can be an architect today and a teacher tomorrow. Stored on the mate record (`persona`, default null = plain coordinator), reset to null on an ordinary retire.
- **First mate only for now** (second-mate personas deferred until the form is proven).
- **Switching a RUNNING mate's persona goes through retire-with-handoff + respawn**, never an in-place edit - a system prompt can't change mid-session. This reuses the faithful-transfer machinery (2026-07-08): `retireAndRespawn(mateId, handoff, persona)` respawns into the new persona with the outgoing session's handoff seeded. A fresh mate (no session) just sets the persona directly. The UI enforces this fresh-vs-running split; the picker shows a read-only-ish "switch retires + respawns" confirm for a running mate.
- **Overlays are short and point at the matching global skill** (`grill-me` / `teach`, curated 2026-07-10) rather than restating their discipline - honouring "integrate, don't rebuild". This is also why those skills were pulled: architect ~ grill-me, teacher ~ teach.
- **Catalog is data-driven** (`src/lib/personas.js`, single source of truth) and reaches the classic-script renderer via a `personas:list` IPC (key/label/blurb only; overlay text stays server-side, injected at launch).

Alternatives rejected: persona locked to a slot (less flexible, and fights the per-task framing); editing a running session's persona in place (impossible - overlay already in context); duplicating the persona catalog into the renderer (drift risk).

## 2026-07-10 - Context .md + skill SKILL.md rendered as HTML in Analysis

Context-file and skill chips in the Analysis view now render their markdown as readable HTML in an overlay (click), keeping reveal-in-Explorer / open-file on right-click. One source-agnostic `openDocViewer({ label, read, reveal })` serves both; a small escape-first dependency-free Markdown->HTML renderer (CSP blocks a CDN lib) escapes all text and emits only our own tags, so a file can't inject markup. Paths resolved server-side via the shared `resolveContextFile` / `skillMdPath` guards (1 MB cap).

## 2026-07-08 - Retire + archive run a last-effort handoff (wire the transfer into the actions)

The renewal ACTIONS (retire a mate, archive a session) previously discarded without running any transfer - the WHY/decisions lived only in the transcript, unextracted. Now they make a last effort to save it, closing the loop the session-renewal strategy opened (we had the transfer MECHANISM + producer discipline, but the actions didn't invoke it).
- **Retire** (a first mate = planned renewal, continues under a fresh name): the outgoing mate's session gets one final self-summary; that handoff is stored on the respawned mate (`pendingHandoff`, one-shot) and seeds its first jump-in, so the cross-project thread continues instead of starting cold. A missing session or failed summary never blocks retiring.
- **Archive** (= "done here", no successor): offers "Save handoff to DECISIONS.md + archive" when the session has a project cwd - summarizes, appends the handoff to that project's DECISIONS.md (a durable store a future session will actually read), then archives. Plain "archive without a handoff" stays available; a no-cwd session only gets the plain option.
Both are best-effort (never block the action) and reuse existing pieces (summarizeSession + the capture IPC + retireAndRespawn's new handoff slot). This is the planned-handoff complement to the on-the-go capture that covers abrupt handoffs.

## 2026-07-08 - Session-renewal strategy: renewal = faithful transfer

Decision on when/how to renew (retire + respawn) a session, forced by a concrete case: a fresh spawned session proposed a naive fix while a context-rich long session proposed a better one, purely because of context it carried that the fresh one lacked.

Reframe: renewal is not kill+restart. Context is both an ASSET (it produced the better fix) and a LIABILITY (bloat dilutes signal, hits token limits, carries stale assumptions). Renewal = transfer the asset, drop the liability - and it is only as safe as the transfer is faithful.

Why DECISIONS.md did NOT prevent the naive fix (the important diagnosis):
1. DECISIONS/PLAN are NOT auto-loaded - only the repo-root CLAUDE.md is (Aidin's own rule). A fresh session never opened them.
2. The load-bearing traps were not even in DECISIONS - they lived in the orchestrator's personal memory (the %APPDATA% MSIX sandbox-overlay / verify-before-theory lesson) and in the code (config.json is on D:\). Reading all of DECISIONS would still have missed them.
3. Auto-memory recall is relevance-matched, not guaranteed for a project-scoped worker session.
So "force the session to read DECISIONS" is insufficient on its own - the fix is to (a) move load-bearing gotchas into the always-loaded repo CLAUDE.md, and (b) make judgment-heavy spawns/handoffs actively CARRY the relevant WHY rather than hope for recall.

The strategy (see PLAN.md's Strategic-reorientation section for the full form):
- Trigger renewal on saturation OR (drained AND topic-shift), not context-% alone.
- Transfer bar for judgment-heavy work: a handoff must carry durable decisions + WHY + traps-learned + live state, to the bar "would this let a fresh session reach the GOOD answer, not just a working one?"
- Scale by work type: mechanical renews freely/ephemeral; judgment-heavy stays context-rich longer and renews only at topic boundaries after a faithful handoff.
- Mechanism: retire/respawn (built) is the primitive; "summarize & carry over" must be upgraded to inject the durable stores (not just summarize the transcript); the handoff nudge must fire on saturation OR drainage.
- When Helm drives Helm, context injection at spawn is load-bearing infrastructure.
- PRODUCER side (Aidin's extension): the second mate must capture the durable layer ON THE GO - a decision + WHY when it lands, a gotcha when learned, a short running state-of-play - NOT at renewal time. This is the only thing that survives an ABRUPT handoff (crash, sudden context-limit, quota cut, where no end-of-session summary ever runs), and it keeps the stores faithful so carry-over (the consumer side) has something faithful to inject. Discipline is the RIGHT LAYER, not more volume: capture decisions/traps/state, never the step-by-step (git history + transcript already hold that). Must stay cheap/targeted (a one-click capture affordance, not a heavy ritual) so it doesn't fight "stay thin".

## 2026-07-08 - Helm owns its own session index (FIXES the local_*.json gap flagged below)

This is the fix for the "load-bearing architectural gap" the entry immediately below surfaced but left unfixed.
Root cause (verified empirically AND re-verified in code): launcher.js starts every Helm session via headless `claude -p`, which writes the transcript to `~/.claude/projects/...` but NEVER a Desktop `local_*.json` in `%APPDATA%\Claude\claude-code-sessions`. readAllSessions (the only discovery path) reads ONLY that Desktop dir, so a session started inside Helm's own chat was structurally invisible in Helm's own Direct/Fleet/sidebar. The same root cause also broke archiving those sessions (patchSessionMeta scans Desktop files). Concretely confirmed: loom/jot have real local_*.json entries; this repo had zero.

Two fixes were on the table. A context-poor spawned session proposed writing our own `local_*.json` into Anthropic's dir in their format. Rejected: it writes into the real Desktop app's live, undocumented, reverse-engineered private index - a schema slip could destabilize the daily-driver Desktop app, two writers race on files we don't own, a Claude Code update could silently break our writer, and it is barely verifiable from a Claude session (%APPDATA%\Claude writes hit the MSIX sandbox overlay - the same trap that already forced the archive write to be Aidin-verified).

Chosen: Helm owns a `config.helmSessions` index (config.json, on D:\ - a REAL location, not the overlay; never Anthropic's schema). Same overlay pattern Helm already uses for titleOverrides/hiddenSessions. main.js records an entry the moment the CLI session id appears (so it shows while the first turn still runs), keyed by sessionId, with the cwd/model/title/timestamps Helm already knows; readAllSessions merges these with the Desktop list (Desktop file WINS on any id collision, so a resumed Desktop session is never doubled); session:archive routes a Helm-owned session's isArchived to our index. Status/last-role still derive from the transcript (which exists), so nothing downstream changed there.
createIfAbsent gating: a fresh launch creates an entry, a resume only bumps an existing one (so resuming a Desktop session never fabricates a stray Helm entry); internal launches (summarize-carry-over) are excluded.
Out of v1 scope (noted): durable folder-switch for a Helm session still warns rather than persists (switchSessionRootFolder's patchSessionMeta finds no Desktop file); rename already works (titleOverrides is a display overlay independent of the metadata file).
Verified: unit test (scripts/e2e/test-helm-session-index.mjs, 7/7) proves merge + Desktop-wins dedup + archived-status, no claude/Electron needed. The full live path (real Helm chat -> entry in config.json -> shows in Direct -> archivable) is reliably verifiable BECAUSE config.json is on D:\ (unlike the rejected %APPDATA% approach) - to confirm on a real user-launched Helm.

## 2026-07-08 - Three real dashboard/fleet bugs found and fixed after Aidin's own manual test pass, plus a load-bearing architectural gap surfaced (not yet fixed)

Aidin asked Claude-in-Helm to fix two P0 Jot bugs (empty-cwd Direct sessions never matching back into the fleet list, and the Dashboard's "New session" button giving no feedback for an empty draft).
Both were fixed correctly in `renderer.js`, but the fix sat uncommitted and the running dev app was never restarted, so no visible difference appeared - committed + restarted, then verified end to end via `scripts/e2e/test-draft-flash-cue.mjs` (updated; it encoded the pre-fix behavior on purpose) and `scripts/e2e/test-fleet-view.mjs` (regression, all green).

Aidin's own manual test pass afterward surfaced three more real bugs, unrelated to the two above:

**Bug: clicking a project chip in the Dashboard's "New session" panel bounced back to the top of the page.**
Root cause: `dashChipEl`'s click handler called `renderDashboardPage()` - a full `page.innerHTML = ""` teardown and rebuild - on every chip pick, purely to update the New Session slot's selection state.
Fixed to call the existing targeted-repaint path, `fillDashboardSections()` (its fingerprint already depends on `dashboardSelectedChip`, so it repaints the right slot).
Verified via a new `scripts/e2e/test-dashboard-chip-select.mjs`: a marker element planted as a direct child of `#dashboardPage` survives a chip click under the fix and is wiped under the pre-fix code (confirmed both ways - scrollTop itself was not a reliable signal since real dashboard content can be tall enough on its own to keep it numerically valid after a rebuild).

**Bug/confusion: "+ other..." vs "+ new domain..." read as two buttons doing the same thing, and there was no way to undo picking the wrong one.**
"+ other..." picks a folder for just this session; "+ new domain..." permanently registers a non-repo life-domain project (gym, kombucha, ...) as a recurring chip.
Aidin picked "+ new domain..." on Helm's own (already-a-repo) folder by accident and had no way to remove the resulting pin - `removeDomain`/`domains:remove` existed in the backend (`src/lib/domains.js`, IPC in `main.js`) but no UI ever called it.
Fixed: tooltips on both buttons explaining the distinction, a guard in `promptRegisterDomain` that rejects registering a domain pointed at an already-known repo path (toast points at "+ other..." instead), and a remove (×) control on domain chips wired to the existing IPC handler.
Not covered by an automated test - registration goes through a native OS folder-picker dialog that CDP cannot drive; exercised manually.

**Architectural finding (not yet fixed): sessions launched through Helm's own chat UI can never appear in Helm's own Direct/Fleet view.**
Aidin still could not find the original bug-fixing session under Captain/Direct after the above fixes.
Traced to the read layer: `readAllSessions` (`src/lib/sessions.js`) reads exclusively from `local_*.json` files under `%APPDATA%\Claude\claude-code-sessions`.
Empirically confirmed (a real `claude -p ... --output-format stream-json` invocation, file count before/after) that a **headless `-p` invocation never writes a `local_*.json` file** - that store is populated by interactive CLI/IDE-extension usage.
`src/lib/launcher.js` spawns every Helm-driven session - Direct, second mate, first mate, all of it - via exactly that headless `-p --output-format stream-json` mode.
Net effect: `state.sessions` (and everything built on it - Direct, Fleet second-mate binding, Jot category matching, the attention spotlight) can only ever surface sessions Aidin runs manually outside Helm (confirmed: `loom` and `jot` - his other CLI-driven personal projects - both have real `local_*.json` entries; `D:\Repo\Tools\helm` itself has none, across every session found on disk today).
This is architecture-level, not a quick patch, and needs a decision before building: most likely fix is having `launcher.js` write its own `local_<generated-id>.json` in the same schema/location on session start (so every existing consumer - Direct, Fleet, Jot matching, archive - keeps working unmodified), but this hooks into a store whose real schema is Anthropic's own and undocumented, discovered by inspection rather than a spec.
Flagged to Aidin rather than built unilaterally; not started.

## 2026-07-08 - Real ship's-wheel logo (replaces the ◆ glyph and the 🧭 compass)

The header brand mark was a plain "◆" text glyph, and the Captain/Direct fleet card used a 🧭 compass emoji - both placeholders from before the rename. Aidin supplied a generated ship's-wheel artwork (a gradient-shaded terracotta line icon on a flat cream background, 2816x1536) and asked it replace both.
Processed it into a usable asset rather than using it as-is: scanned for the wheel's true content bounding box (excluding a few stray artifact pixels at the extreme image corners and a faint background watermark), cropped to a centered square, and alpha-keyed the cream background out via a soft color-distance ramp (not a hard cutoff) so the existing gradient shading on the line art is preserved with clean anti-aliased edges. Saved as one 512x512 master PNG (`src/renderer/assets/helm-wheel.png`), reused at both display sizes (18px header, 18px inside the 28px fleet badge) rather than exporting multiple fixed sizes - simpler, and 512px downscales crisply for anything this app needs.
Rejected keeping the compass on the Captain card: the wheel is the app's actual namesake image now, and having two different nautical icons (wheel in the header, compass on Captain) for the same "this is Helm" idea was redundant - one consistent mark reads better.
A real Electron app/taskbar icon (.ico/.icns) was left out of scope - there isn't one configured today, and that belongs with the parked installer/packaging task, not this UI mark swap.

## 2026-07-08 - Renamed the app Maestro -> Helm

The app's model and UI became fully nautical over the Fleet build - captain (Aidin), first/second mates, crew, fleet, the anchor and compass icons.
"Maestro" is a musical-conductor metaphor (orchestra), which no longer matched.
Decision: rename to Helm - the wheel the captain steers the fleet from. One word, in the same style as the sibling tools (Jot, Loom), and on-metaphor for command/steering.
Considered and rejected: Conn (great and ownable but too obscure), Bridge (overloaded - networking, card game, Star Trek), Wheelhouse / Crow's Nest / Tiller / Quarterdeck (longer, or lean too far into lookout rather than command).
Executed as a deep rename (not just the display name): window.maestro -> window.helm, MAESTRO_* env -> HELM_*, the .maestro-* run dirs, the maestro-dispatch MCP server + maestro_* tools -> helm-*, localStorage keys, package name, three source files, the repo folder (D:\Repo\Tools\helm), and the GitHub repo (AidinD/helm).
The DECISIONS/PLAN history was swept to the new name too (git preserves the old name); a solo project reads better with one current name than a half-renamed log.

## 2026-07-08 - Collapsible sidebar (Chat is a supporting surface)

Now that the Fleet is the primary triage view, the Chat page's 300px session sidebar competes for width it no longer earns as the front door.
Decision: keep the sidebar (its categories, live search, and rich row-actions have no Fleet equivalent) but make it collapsible to a slim 44px rail that hands its width back to the workspace.
The collapse state persists in localStorage (renderer-only, no main-process IPC - matches the existing Lavish-recents pref pattern) and is applied on load, so it survives reloads.
Rejected: cutting the sidebar entirely (would lose organizing/search/row-actions that the Fleet's Direct column doesn't offer) and a full flat "list" mode (already removed 2026-07-07 as a Fleet-Direct duplicate).

## 2026-07-07 - Cut split view (single pane is the model)

Split view (two side-by-side panes with a draggable divider) is removed.
The newer Fleet flow already routed around it - every jump-in called ensureSinglePane ("take me to this", not "open beside") - and a double review found real bugs it carried: closing split via the toolbar toggle orphaned a running launch (no stop, wasted quota) and left stale nav history; the same session could be opened in both panes → concurrent --resume against one transcript; background tasks conflated across panes with no session attribution.
Aidin was ambivalent about split and chose to cut it.
So the workspace now always renders exactly one pane: removed the split toggle (button + handler + command-palette entry), the "Open in split pane" context action, the pane divider + drag-resize + ratio machinery, pickDraftTargetPane's pane-adding, openSessionInPane's forceSplit branch, the index===1 pane-close, and ensureSinglePane (now a no-op). Kept as a possible future: nothing - if a real need for side-by-side returns, rebuild it deliberately with the bugs above designed out.

## 2026-07-07 - Named mates, second-mate-as-session, and fleet-aware coordination (the model made concrete)

This day turned the 2026-07-06 tiered model into a built, reviewed Fleet.
Several decisions refined or corrected that model through live use.

**Named mates, not work/private domains (soft split).**
The 2026-07-06 model assumed two first mates split by life-domain (work/private).
In practice Aidin works fluidly across topics from one place, so a hard domain firewall was wrong.
Decision: two FIXED first-mate slots that always exist, each born with a random sea-captain name (film/games/lit) and renameable; the captain jumps into one and declares its focus, soft not firewalled.
Rejected: deriving a session's domain from its projects, or two separate meta-home roots, or a hard work/private classification - all impose a boundary Aidin doesn't want.
A saturated/drained mate is retired (kept as a `retired` record so its historical runs stay named) and a fresh one respawns in the same slot.

**A second mate is a SESSION, not a background task (corrected a build-time conflation).**
The first dispatch build labelled the headless Autopilot runs `tier:"second-mate"`.
But in the agreed model a second mate is a per-project SESSION (the judgment tier the captain can jump into and steer), and the autonomous run is CREW beneath it.
Decision: a second mate is DERIVED per (firstMate, project) from run history (deterministic id, no parallel store to drift), owns its crew (the dispatched runs), and is jumpable; dispatched runs were relabelled `tier:"crew"`.
Lesson recorded (Flow): don't let the easiest-to-build implementation silently redefine a term already agreed - flag it.

**Direct lists SESSIONS per session, not per project.**
Aidin's real sessions almost all live at the meta-home (one cwd) across many topics, so grouping the Direct column by project-cwd collapsed them all into nothing and excluded meta-home sessions entirely.
Decision (his call): Direct lists every non-archived session as its own resumable node, named by title - meta-home sessions included, no cwd grouping.

**First-mate role loaded as system context; the "+ New orchestrator session" button removed.**
With named mates, the two mates ARE the only orchestrator sessions, so a separate button that spun up a nameless third one was redundant and off-model - removed.
It was also the only place that injected the orchestrator bootstrap prompt, so a fresh first mate now boots with `first-mate-instructions.md` appended via `--append-system-prompt` (system context, not a visible draft) - the composer stays empty for the captain's first prompt, per spec.

**Fleet-aware focus survey (solves the two-mates coordination gap).**
The two first mates are independent sessions with no shared context, and `helm_collect_reports` is scoped to a mate's OWN dispatches - so mate B couldn't see what A had in flight and could propose overlapping focus.
Decision: a `helm_fleet_state` MCP tool exposes a compact cross-mate view (both mates + every mate's dispatched work, tagged `yours`), which the app snapshots to disk (staying the single authority); the first-mate instructions tell the mate to survey it and propose COMPLEMENTARY focus.
Rejected: giving the mates shared context - they're deliberately independent, refreshed-and-discarded sessions.

**Smaller, durable calls.**
Never use native `window.prompt`/`confirm` (disabled in Electron anyway, and off-theme) - always custom in-app UI.
An unclassified Jot list belongs to "All" only (dimmed under Work/Private), rather than showing bright in both.
A session's live Claude Code sub-agents (Task tool with no tool_result yet) are surfaced as crew under the session.

## 2026-07-05 - Goal runs require a native claude.exe; reject shell-shim installs and fail loud

A same-day spawn-fallback hardening (route the prompt via stdin in shell mode, to keep goal/notes text out of cmd.exe) was itself put through a pre-ship review and then reverted.
The review surfaced two problems.
H1: the shell-mode `child.stdin.write` sat in a SYNCHRONOUS try/catch, but a broken-pipe EPIPE on a child's stdin is emitted ASYNCHRONOUSLY as an `error` event - with no listener attached, that becomes an uncaughtException that can take down the whole Electron process (reproduced by the reviewer).
M1, more fundamentally: the entire shell path was already non-functional.
In `shell:true` mode Node concatenates argv unescaped and cmd.exe then corrupts the still-argv `--json-schema` (drops the quotes -> invalid JSON) and truncates the multi-word `--system-prompt` at the first space.
So the npm-global `claude.cmd` path never actually worked; the stdin change was hardening an injection surface on a path that couldn't run anyway, and its code comment wrongly implied those constants were shell-safe.
Decision: rather than make the shell path work (file-based schema/system-prompt args - its own testing burden for a path a native install never hits), reject it.
`runGoal` now fails loudly up front if claude doesn't resolve to a `.exe`, and `runIteration` spawns with `shell:false` + a positional prompt (reverted to the simple, known-good form).
This removes H1 (no stdin code at all), removes M1 (no shell mode), and is honest: a clear "install native claude.exe" error beats silently feeding every iteration a corrupted schema.
If npm-shim support is ever actually wanted, do it as a focused task with file-based args and its own test, not as an untested fallback.
Verified: the real goal-orchestrator E2E spike stayed green through the revert (native .exe path, primary checkout untouched).

## 2026-07-05 - Removed the warm whisper-server (built the same day), reverting single-clip transcription to whisper-cli

Earlier the same day a warm `whisper-server.exe` was added (whisperServer.js) so the single-clip transcription path loads the model once instead of paying whisper-cli's ~460ms model-load per call (~350-530ms warm vs ~1.2s cli, 2-3x).
Going through it in review surfaced the flaw: `startVoiceRecording` always prefers the real-time streaming path (`whisper-stream.exe`) and only falls back to the single-clip path when streaming is unavailable - so on any machine where streaming works (Aidin's does), the warm server is NEVER exercised in normal use.
It only ever sped up a rarely-hit fallback.
Decision: remove it. A managed long-lived server process - PID tracking pushed worker->main, a synchronous `taskkill /T /F` in before-quit, an exit backstop - is real, ongoing maintenance surface, and kill-on-quit PID tracking is a classic source of orphaned/mis-killed processes.
Carrying that lifecycle risk to shave a rarely-hit fallback from 1.2s to 0.4s isn't worth it; per-call `whisper-cli.exe` at ~1.2s (measured 901ms on 1s of audio incl. model load) is perfectly acceptable for a degraded path.
This matches the engineering-philosophy preference for simplicity/maintainability over unnecessary complexity.

Removed: `src/lib/whisperServer.js` (deleted), the warm-path branch + `stopWarmServer`/`getWarmServerPid` re-exports in whisperCpp.js, the serverPid push + exit backstop in voiceWorker.js, and the `voiceServerPid` tracking + before-quit taskkill in main.js.
`whisperCpp.transcribeAudio` is back to a clean whisper-cli-per-call, unchanged otherwise; the streaming path (whisper-stream.exe) and the transformers.js fallback are untouched.
Verified via `spike/test-whispercpp-cli-path.mjs` (real cli subprocess transcribes end-to-end after the removal) + no-dangling-reference grep + `node --check` on all three edited files.
If a streaming-unavailable machine ever makes single-clip the primary path and 1.2s becomes the bottleneck there, revisit - but build it lazily/without a persistent kill-on-quit process, or just accept cli latency for a degraded mode.

## 2026-07-05 - goalOrchestrator progress/success semantics: `producedChanges` + no-op convergence (ship-review cluster A-D)

An adversarial ship-review (two fresh opus contexts) of the autonomous goal-execution core surfaced a cluster of correctness issues; Aidin approved fixing all of them.
The root one: `appendNotes` runs BEFORE `commitIteration`, so the orchestrator's own notes.md/plan.md write always dirties the worktree, which means `git status` is never empty at commit time and `record.committed` is effectively always true.
So `committed` could not distinguish "the agent changed real code" from "the orchestrator wrote bookkeeping," and the `no_net_progress` escalation signal - which keyed off `!committed` - could therefore essentially never fire (dead logic).
Consequence: an agent that repeatedly reports `success:true` while doing nothing burned every remaining iteration and its tokens undetected (`consecutiveFailures` resets on any "success", so the two-failures stop never caught it either).
A live E2E run demonstrated the failure mode for real: an implement iteration reported "Created hello.txt" with `success:true` but never wrote the file - and the new signal caught it (`producedChanges:false`).

Decision - the honest work signal is "did files change OUTSIDE `.helm-goal/`", measured BEFORE the notes append:
- Added `producedRealChanges(worktreePath)` (parses `git status --porcelain`, ignores `.helm-goal/`), recorded as `record.producedChanges` each iteration; fails open (returns true) on any git error so a hiccup never wrongly flags a stall.
- Kept the atomic notes+code commit as-is (that ordering is deliberate - the commit is meant to capture notes.md too); the fix is the SIGNAL, not the commit behavior.
- Re-keyed `detectNoNetProgress` off `producedChanges`, and restricted it to implement-phase iterations (research/plan legitimately produce no code outside `.helm-goal/`, so counting them would false-positive). This let the now-redundant `commitCountByIteration` map + its per-iteration `countCommitsOnBranch` call be removed entirely.
- Added a DEFAULT-ON stop: `NO_OP_CONVERGENCE_STREAK` (2) consecutive no-op implement successes -> new `stoppedReason: "no_op_convergence"`. Chosen as a clean STOP, not a failure: a no-op implement success is ambiguous (agent stuck, or goal already satisfied) - either way, stop wasting iterations and let the human review the kept worktree, rather than mislabel it an error. Fires independently of the opt-in escalation feature so the token-waste is bounded by default.

Also in the same pass (smaller, from the same review):
- **Deliverable gate (finding 1.1):** `advancePhaseAfterSuccess` only advances plan -> implement once `plan.md` exists with real content (`.trim()`); a plan-phase success that wrote no usable plan re-runs plan instead of implementing against nothing.
- **Notes truncation (finding 4.1):** `truncateNotesIfNeeded` now rescues every "Key learnings" bullet from the dropped middle into a preserved ledger (`extractKeyLearnings`), so a long run's early decisions/dead-ends aren't silently lost to a later fresh-context iteration.
- **IPC input (finding, low):** `runGoal` now validates `projectPath` is a git work tree before any worktree/branch op, instead of trusting the IPC caller's bare truthiness check.
- **Rollback safety (committed earlier, 64f0346):** `discardWorktreeChanges` refuses to `reset --hard`/`clean -fd` unless `isOwnWorktreeRoot` confirms the target's git toplevel equals the path itself - blocks the one narrow way a destructive reset could reach a parent checkout (a deregistered worktree whose dir sits inside an ancestor repo).

Explicitly NOT fixed: the spawn fallback for a broken `claude` install (`shell:true` + prompt-as-argv) stays as-is with its loud warning - hardening it means routing the prompt via stdin, a larger separate change; the normal `.exe` path is already `shell:false`-safe.
Verification: 18-assertion deterministic unit spike (`test-progress-semantics.mjs`), the destructive-git spike (`test-discard-guard.mjs`), and two real end-to-end `runGoal` spikes (one flaked and proved the detection works; the clean re-run showed research/plan `producedChanges:false` vs implement `true`, hello.txt created, primary checkout untouched).

## 2026-07-05 - Orchestrator turns use real agents + files, not a simulated-multi-agent megaprompt

Aidin shared a popular blueprint for turning ONE Claude session into an autonomous org: a meta-prompt where the session role-plays an Orchestrator + First Mate + Second Mates, reprinting an orchestrator-log + backlog + agent-execution + final-output block (XML-tagged) in every response, invoking sub-agent "personas" for coding/critique inside the same context.
He asked whether we should implement it.
Decision: NO to the mechanism, YES to the goals - and we already implement the goals for real.

Why not the mechanism:
1. Simulated personas are not isolated. A `<agent_critic>` in the SAME context window is the same model with the same blind spots - it rationalizes its own output rather than independently refuting it. Real adversarial value requires a FRESH context, which is exactly what our dispatched review/verify agents (and `/ship-review`) provide by spawning separate sessions.
2. It accelerates context-rot. Reprinting full orchestrator state every turn bloats the window and pushes it into the ~40% "dumb zone" (Horthy) where recall degrades - the opposite of the claimed anti-drift benefit, and directly against the ephemeral-sessions + files-as-memory model this system is built on (see the 2026-07-03 strategic-reorientation and practitioner-research entries).
3. It is the durable megasession we explicitly rejected, dressed up: one long-lived session holding everything, no parallelism, no isolation.

What the blueprint gets right (and we already do): decomposition beats "be smart" (orchestrator-instructions.md), a visible backlog fights drift (but Jot/PLAN.md do it durably, not by reprinting in-context), self-critique matters (but via fresh-context agents), and the human should operate at the macro level (the orchestrator/Helm vision).
Minsky's "Society of Mind" is actually served BETTER by many real isolated agents than by three personas in one window.

What we adopted: a lightweight convention in orchestrator-instructions.md - make the plan/backlog and the delegate-vs-do-it-yourself split visible each orchestration turn - explicitly backed by real dispatched agents (own fresh context) and durable files, NOT by simulated roles. The essay itself was partly AI-generated marketing prose (overclaims like "quality increases exponentially"); took the real ideas (Minsky, Anthropic's orchestrator-worker), left the hype.

## 2026-07-05 - TOON encoding for the Lavish annotation-list prompt

Board task: apply the AXI/TOON token-efficiency principle (deferred 2026-07-04, "fold TOON in with structured-injection features as they mature") to prompts Helm builds for its own sub-agent calls.
Audited the four candidate call sites named in the task - the status classifier and judge (`orchestratorHelper.js`, `judge.js`), the goal orchestrator (`goalOrchestrator.js`), and the model/effort suggester (`suggest.js`, which turned out to be a pure regex heuristic with no LLM call at all).
**Finding: none of them embed an array of objects today.** Each already sends a short hand-built text summary (one session's recent turns, one run's tool list, one goal's notes.md), matching the 2026-07-04 finding that these surfaces were already compact.
The one genuine array-of-uniform-objects going into any Claude-facing prompt in the whole codebase is the Lavish annotation list (`formatAnnotationsAsPrompt` in `src/lib/lavishSdk.js`) - though it feeds the primary rooted session's composer, not one of Helm's own internal sub-agent calls.
This is exactly the "structured-injection feature... as it matures" case the prior decision flagged as the right moment to fold TOON in, so applied it there instead of forcing a conversion onto surfaces that don't have the shape TOON targets.

**Built `src/lib/toon.js`:** a small, dependency-free `encodeToon(value)` covering only the shapes Helm actually needs - an array of uniform objects becomes a `N{col1,col2,...}:` header plus one delimited row per item, a plain object becomes indented `key: value` lines (recursing for nested objects/arrays), and values containing the delimiter/newline/quote get JSON-style quoted+escaped.
Not a full TOON spec implementation by design - correctness and readability for these shapes over spec completeness.

**Changed `formatAnnotationsAsPrompt`:** the annotation list is now projected to `{anchor, text, feedback}` per row (anchor already resolves lavishId-vs-selector, so the TOON table has one clear "where" column) and encoded with `encodeToon` instead of a hand-built numbered list, with a one-line format hint ("Data is in TOON: a header row of column names in {}, then one row per item") so the receiving agent knows how to read it.
Updated `spike/test-lavish.mjs`'s assertions to match the new TOON output shape - same semantic coverage (intro line, anchor resolution, empty-text handling, DOM snapshot section), all 15 assertions still pass, including the untouched CSP-hash drift guard.

**Measured on a representative 8-annotation batch:** TOON-encoded array is 1111 -> 804 chars vs raw `JSON.stringify` of the same array (27.6% smaller); vs the OLD hand-formatted numbered-list text it had already replaced, the full new output was roughly a wash at 8 items (the format-hint line adds back what the table saves) but pulls ahead at realistic larger batches - at 20 annotations, 13.6% smaller than the old hand-formatted list and 39.4% smaller than raw JSON.
The win scales with row count since the header is paid once; small batches see little to no benefit, which matches the AXI write-up's own caveat that gains are biggest against verbose JSON/MCP output, not against an already-lean format.

## 2026-07-05 — True real-time streaming transcription via whisper-stream.exe, replacing rolling re-transcription

Follow-up to the 2026-07-04 "continuous voice input" entry (rolling re-transcription of the whole clip-so-far every `VOICE_ROLLING_INTERVAL_MS`).
That entry stated Whisper "is not a streaming model" and settled for rolling re-transcription as the pragmatic ceiling.
Aidin explicitly chose to go further: use whisper.cpp's own real-time streaming tool instead of hand-rolling a windowing scheme, so text grows word-by-word while speaking, like dictation.

**Binary: `whisper-stream.exe`, not `stream.exe`.**
`.whisper/Release/` ships both.
`stream.exe` is whisper.cpp's deprecated name for this tool - running it just prints a deprecation warning to stderr and exits immediately (confirmed by actually running it), so it is unusable.
`whisper-stream.exe` (390KB, vs. `stream.exe`'s 28KB stub) is the real, current SDL2-based streaming binary and is what `src/lib/whisperStream.js` spawns.

**stdout format, reverse-engineered from the real whisper.cpp source (`examples/stream/stream.cpp`) plus a live ~5-8s silent capture against this exact build/model:**
In sliding-window mode (`--step`/`--length`, what we use), every processing iteration prints `"\x1b[2K\r" + 100 spaces + "\x1b[2K\r" + <window text, no trailing newline>` - an ANSI clear-line+CR done twice, then the CURRENT window's full transcript REPRINTED in place (not an incremental append).
Every `n_new_line = max(1, length_ms/step_ms - 1)` iterations, a bare `"\n"` is printed and the internal audio buffer rolls forward, keeping only `--keep` ms of audio.
Because whisper-stream runs with its default `no_context=true` (no `-kc` flag), nothing about the recognized TEXT is actually carried across that roll - the `"\n"` is whisper-stream's own cosmetic scrollback break, not a hard linguistic guarantee that prior text can never change.
It is still treated as this app's commit boundary because it is the only one the tool provides, and in practice each window has stabilized by the time it rolls off (that is the whole purpose of `--keep`'s audio overlap).
A plain `"[Start speaking]\r\n"` banner precedes the first window.

**Parsing approach (`src/lib/whisperStream.js`'s `parseStreamChunk`):** re-splits the ENTIRE buffered-so-far stdout on the full boundary triplet (`clear, 100 spaces, clear`) on every call, rather than doing an in-place incremental regex-and-slice.
Every resulting segment except the last is a fully-finished reprint; the last segment always stays buffered since more stdout may still extend it (avoids flickering a truncated word into the composer).
Within a finished segment, a bare `"\n"` (not part of the boundary) is whisper-stream's own commit point - text before it becomes a `"committed"` event, text after it (with no further `"\n"` before the next boundary) becomes a `"partial"` event.
`"<|nospeech|>"` (whisper's silence marker) collapses to an empty string rather than being surfaced.
Verified deterministic with a throwaway standalone script feeding the same sample through as one whole chunk, byte-by-byte, and randomly-sized chunks (all three produced byte-identical event sequences) - both against a synthetic sample built from the source's exact print sequence, and against a real captured `whisper-stream.exe` run (silent room, so all `<|nospeech|>`, zero spurious events, correct trailing-incomplete-reprint buffering).

**Architecture:** in `voice:streamStart` (`src/main.js`), whisper-stream.exe is spawned directly from the main process (not routed through the existing `voiceWorker.js` utility process) - unlike whisper-cli/transformers.js inference, nothing CPU-bound runs on this process's own event loop here, just an async spawn plus incremental stdout reads, so the utility-process indirection that exists specifically to protect the event loop from blocking ONNX/whisper-cli calls isn't needed.
Partial/committed events stream to the renderer over a new dedicated IPC channel, `"voice:streamEvent"`, mirroring the existing `goal:event`/`session:event` pattern (every payload carries a `streamId` so a stale hold's late events can never be misapplied to a fresh one).

**Trigger unchanged, mic ownership switches.**
The hold-to-record trigger (mic button mousedown/mouseup/mouseleave, Alt-in-composer keydown/keyup/blur) is untouched.
`startVoiceRecording` (`src/renderer/renderer.js`) now tries `tryStartVoiceStream` first: if `config.voiceEngine === "whispercpp"` AND the main process confirms whisper-stream.exe + the model are actually installed, whisper-stream.exe owns the microphone directly via SDL2 and the renderer does NOT call `getUserMedia`/`MediaRecorder` for that hold at all.
If unavailable (missing binary/model, or `voiceEngine: "transformers"`), it falls back to the existing rolling re-transcription path unchanged - same trigger, same UX, just a different backend, so a machine without `.whisper/Release/whisper-stream.exe` degrades gracefully instead of losing continuous voice input.

**Lifecycle / orphan prevention.**
Stopping the hold (`stopVoiceRecording` -> `stopVoiceStreamIfActive`) removes the pane from `activeVoiceStreams` BEFORE awaiting the kill, so the process's own later "exit" event (which always fires, clean stop or not) finds nothing to act on.
Killing uses the same Windows `taskkill /T /F` tree-kill `main.js` already relies on for `claude.exe` subprocesses, not a plain `child.kill()` - whisper-stream links SDL2, which is not guaranteed to release the microphone on a bare kill signal on every setup.
`app.on("before-quit")` now also sweeps `liveVoiceStreams` with the synchronous kill variant, so quitting the app while a hold is active can't leave whisper-stream.exe orphaned and holding the mic - the exact same concern the existing `liveChildren`/`voiceWorker` cleanup in that handler addresses for other subprocess kinds.
An unexpected exit/error mid-hold (e.g. losing the capture device) surfaces as a mic-button title and releases the hold rather than leaving the UI stuck showing "recording" for a process that is actually gone; text already committed before the crash is left in the composer rather than discarded.

**Tuning: `--step 700 --length 5000 --keep 200`.**
`--step 700` gives sub-second visible updates (matching the word-by-word ask) while staying well inside the ~1.3s/11s-clip inference time already measured on Aidin's RTX 3070 (see `whisperCpp.js`) - a 5s window transcribes considerably faster than that, so 700ms steps should not queue up.
`--length 5000` keeps each window short enough to stay fast on this GPU while still giving whisper a few seconds of context per inference (very short windows alone tend to fragment words and hurt accuracy).
`--keep 200` is whisper-stream's own default, left alone - it only needs to bridge one word's worth of boundary overlap.

**Not verified: real microphone behavior.**
Everything above was verified statically (source code, `--help` output, a live silent capture, `node --check`, and a standalone parser test against both synthetic and real captured stdout) - none of it proves real speech actually renders as smooth word-by-word growth in the composer, that Swedish accuracy holds up at these window sizes, or that the tuning constants feel responsive rather than choppy in practice.
That needs Aidin's live microphone test: hold the mic button (or Alt), speak Swedish continuously, confirm text grows live in the composer word by word without long pauses; release and confirm the committed text is retained; try a longer hold to check the process survives multiple window rolls; and, on a machine/config where `.whisper/Release/whisper-stream.exe` is deliberately renamed away or the config is set to `voiceEngine: "transformers"`, confirm the mic button still falls back to the old rolling behavior rather than silently doing nothing.

## 2026-07-04 - Voice input perf fix: q8 quantization + off-main-loop worker process + slower rolling interval

Follow-up to the same-day voice-input entries (hold-to-record, multilingual, language picker, kb-whisper-small swap, rolling re-transcription).
Aidin's live-mic feedback after the kb-whisper-small Swedish-quality swap: "Swedish and 'auto' work BETTER than before, but the whole experience is SLOWER.
It takes too long to transcribe at all, and even the mic button feels laggy." Quality was the goal and stayed; speed and UI responsiveness regressed and needed a fix without giving quality back up.

**Root cause 1: `dtype: "fp32"` on kb-whisper-small.**
The model swap to `onnx-community/kb-whisper-small-ONNX` picked full-precision weights (~970MB download: encoder_model.onnx 353MB + decoder_model_merged.onnx 615MB), which is both a large download and slow per-inference (fp32 matmuls).
**Fix (`src/lib/voice.js`):** added a `MODEL_DTYPE` constant set to `"q8"`.
Verified directly on the repo (not guessed) which quantized files it actually ships - `encoder_model_quantized.onnx` (92.2MB) + `decoder_model_merged_quantized.onnx` (314MB), ~406MB total, under half the fp32 size.
transformers.js maps `dtype: "q8"` to the `_quantized` file suffix (`node_modules/@huggingface/transformers/src/utils/dtypes.js`), confirmed against the actual mapping table rather than assumed.
Picked `q8` over the even smaller `q4` (~300MB) specifically to protect the Swedish-quality gain that was the whole point of the kb-whisper-small swap - 4-bit weight quantization risks a bigger accuracy hit than 8-bit.
`onnx-community/kb-whisper-base-ONNX` (same KBLab Swedish training, roughly 1/4 the parameters) is documented as the next fallback in `voice.js` if `q8` still isn't fast enough on Aidin's machine.

**Root cause 2: transcription ran directly on the Electron main process's event loop.**
The `voice:transcribe` IPC handler in `src/main.js` used to call `transcribeAudio()` (CPU-bound ONNX inference, not I/O) directly, which blocks the main process for the whole multi-second transcription.
Every other IPC round-trip queues up behind a blocked main loop, which is very likely why "even the mic button feels laggy" - the button's own state round-trips through main just like everything else.
**Fix:** added `src/lib/voiceWorker.js`, a new entry point forked via Electron's `utilityProcess.fork()` from `main.js`.
It imports the same `voice.js` and answers `{ id, samples, language }` request messages over `process.parentPort` with `{ id, ok, text }` / `{ id, ok: false, error }` replies.
`main.js` spawns the worker lazily on first use, keeps it alive and reused for the rest of the app's lifetime (so the model is loaded exactly once, not per call), and kills it explicitly in the existing `before-quit` handler alongside the `liveChildren` cleanup.
The `voice:transcribe` IPC handler's public shape is unchanged; only what runs behind it moved process.

**Root cause 3 (contributing): the rolling re-transcription interval was tuned for a lighter, no-longer-current model.**
`VOICE_ROLLING_INTERVAL_MS` in `src/renderer/renderer.js` was 2000ms, tuned back when the model was `whisper-base`.
Continuous mode re-transcribes the FULL accumulated clip every tick (not a delta), so as kb-whisper-small (heavier than whisper-base even at q8) took a hold's clip through several ticks, ticks risked firing back to back with no breathing room, competing with each other and with the eventual release-time final transcription for the same CPU.
**Fix:** bumped `VOICE_ROLLING_INTERVAL_MS` to 4000ms so the model has room to finish a tick before the next one is due.
The existing non-overlap guard (`entry.inFlight`) was left as-is - it already prevents a pile-up, it just wasn't given enough breathing room at 2s against the heavier model.
Deliberately did NOT add clip-windowing (re-transcribing only the last N seconds instead of the full accumulated clip): the q8 speed win plus the longer interval were judged sufficient, and windowing would need new bookkeeping around `voiceStart`/`voiceLen` that risks regressing the carefully-tested "replace only the voice span" behavior documented in the "continuous voice input" entry above.

**Verified:** `node --check` on every touched file passes.
A standalone smoke test (loaded the real `voice.js`, not a mock, then deleted) confirmed the pipeline initializes with `dtype: "q8"` and transcribes a synthetic silent buffer without error - cold run (including the one-time quantized-weight download) ~50s, warm run ~5.6s process-to-result.
This proves the dtype string is valid for this repo and the pipeline loads/runs; it does NOT prove real-world Swedish transcription quality, latency, or mic-button responsiveness improved - that needs Aidin's live microphone test, same limitation as every prior voice-input entry.

**What Aidin needs to test:** hold the mic button and confirm it reacts instantly (no lag) even while a transcription is in flight; confirm a normal-length utterance transcribes noticeably faster than before; confirm Swedish (and "auto") transcription quality is still as good as the kb-whisper-small swap delivered; try continuous/rolling mode on a longer hold and confirm live partials keep up reasonably instead of trailing far behind.

## 2026-07-04 — Practitioner research validates the direction; 5 mechanisms to adopt, 4 traps to avoid

**Decision:** Before committing to the Helm rebuild (Aidin: "before we
build anything, research 5-10 AI pioneers like Kun Chen"), surveyed 8
agentic-engineering practitioners + Anthropic's orchestrator-worker doc.
Headline: Helm's core primitives (ephemeral per-feature sessions,
files-as-durable-memory, an orchestrator dispatching workers into isolated
git worktrees, token-efficiency first) are the SAME primitives these people
independently converged on — the direction is validated, and the value is in
their worked-out mechanisms.

People + their most-relevant idea:
- **Geoffrey Huntley** ("Ralph") — closest match: fresh context every loop,
  filesystem+git as memory (fix_plan.md / AGENT.md / specs/), serialize the
  build/validation step to one worker. (ghuntley.com/ralph/)
- **Dex Horthy** (12-Factor Agents, RPI) — the "dumb zone": recall degrades
  in the mid 40-60% of a big context window, so keep sessions <~40% fill;
  Research->Plan->(Worktree)->Implement phasing, <40 instructions per phase;
  don't use prompts for control flow. (github.com/humanlayer/12-factor-agents)
- **Steve Yegge** — trajectory: coding agents -> agent clusters -> fleets;
  Helm is the "cluster" tool (one human orchestrating parallel workers).
- **Armin Ronacher** — "second checkout = shared state is just the fs" (endorses
  worktree isolation); dumbest-thing-that-works code for reviewability;
  log to files so the agent self-debugs; healthy skepticism of full loops.
- **Simon Willison** — "vibe engineering"; tests are the agent's verification
  target and no longer optional; linear codebase walkthroughs.
- **Thorsten Ball** — "an LLM, a loop, and enough tokens": the worker is
  simple; the value is the orchestration/memory/isolation around it.
- **Paul Gauthier** (aider) — repo-map via tree-sitter (signatures not file
  dumps) for token-efficient whole-repo awareness; one commit per change.
- **Andrej Karpathy** — keep AI "on a leash": small verifiable chunks, human
  owns verification (the justification for small ephemeral sessions).
- **Anthropic multi-agent doc** — orchestrator owns all next-step decisions,
  workers isolated + never talk; WARNING: ~15x tokens vs single chat, and
  their worst early bug was runaway subagent spawning (matches our own logged
  fan-out-runaway lesson).

Adopt (tracked as a Jot epic, not yet built): RPI phasing per session; the
<40% context-fill budget as a per-worker KPI; the Ralph files-as-memory triad
+ serialize-validation rule; a verification gate before "done"; repo-map
context priming; Anthropic's orchestrator-worker as the literal dispatch spec.

Avoid / boundary: Yegge's AI-supervisor fleets (defer — fights files-as-memory
+ solo control); full autonomy for cared-about code (make human review a
first-class state); Huntley's re-read-whole-spec-every-loop (token tension —
use repo-map + budget for expensive models); the ~15x multiplier (constrain
fan-out width from day one). Full report + all source URLs captured in the
research task output; the adopt/avoid summary is mirrored in PLAN.md's
"Target UI + practitioner research" section.

This UNBLOCKS the "bygg om Helm" rebuild epic — but the rebuild plan should
be shaped WITH Aidin (the mock is the UI target; these mechanisms are the
orchestration substrate), not started unilaterally.

## 2026-07-04 — Orchestrator model clarified: one overarching orchestrator, rooted nowhere; workers rooted per-project

**Decision:** Aidin flagged (twice) confusion about "rooting" that I caused by
conflating two things. Clarified, and wrote it into orchestrator-instructions.md
("Where the orchestrator runs vs. where the work runs"):
- The orchestrator is ONE overarching thing above ALL projects, rooted in
  none. There is no per-project orchestrator.
- Two distinct notions of "rooted": (a) a session's own cwd — decides which
  project's CLAUDE.md/settings/skills auto-load for THAT session; (b) the
  target project of a piece of work — which the orchestrator names EXPLICITLY
  at dispatch. Never conflate them.
- Dispatch: launch each worker with cwd = its target project (so that
  project's CLAUDE.md loads for the worker), in an isolated worktree made via
  `git -C <projectPath> worktree add`. The orchestrator never has to be "in"
  the project. Mirrors firstmate (first mate isn't in a project; crewmates
  get worktrees of specific projects).
- The Agent-tool `isolation:"worktree"` shortcut infers the repo from the
  CALLING session's cwd (why it failed from this Dropbox-rooted session) — a
  harness-shortcut quirk, NOT evidence orchestrators must be rooted anywhere.

**Also (parallelism / worktrees, from a related discussion):** worktrees are
the substrate for conflict-free parallel work, but they DEFER conflicts to
merge time, not eliminate them — disjoint files merge clean, same-line edits
still conflict, and a shared append-target like DECISIONS.md conflicts at
merge (so the orchestrator writes shared files AFTER merge). Tonight I
hand-orchestrated raw Agent calls on ONE shared working tree, which is why I
serialized on shared files (renderer.js) instead of parallelizing — the
Agent-tool worktree isolation was unavailable from this session's root, and
Helm's own worktree-based dispatch isn't built. Building it (treehouse
automation + dispatch) is what turns "serialize on shared files" into real
conflict-free parallelism.

**Operating context:** we currently work IN Claude Desktop; Helm is the
tool being built, not the runtime. Assume Claude Desktop until Aidin says
migrated. So today CLAUDE is the hand-orchestrator; the self-hosting hazard
doesn't bite yet.

## 2026-07-04 — Ship-review round on the risky commits: containment sound, real fixes applied

**Decision:** Aidin asked for ship-reviews of the commits that warrant it.
Ran report-only adversarial reviews (fresh context, no file edits, no app
launch — to avoid app-instance collision with the concurrent harness build)
on the three genuinely risky commits, then applied every real finding myself,
serially, committing per-feature. Verdicts + fixes:
- **Lavish (CSP/iframe):** containment SOUND (no sandbox escape, XSS, IPC
  reach-through, or spoofable postMessage). Fixed: the in-code comment stated
  the security model BACKWARDS (dangerous — would mislead someone into
  relaxing index.html's hash-pin and breaking containment); img-src tightened
  to `data:`; 8MB cap on lavish:readFile. Notably, the review's own "inner
  'unsafe-inline' is inert, set it to 'none'" suggestion was WRONG (it's the
  required inner half of the CSP intersection — 'none' would CSP-block the
  SDK) — caught by reasoning through CSP semantics rather than applying blind.
- **goalOrchestrator:** destructive-git containment CONFIRMED airtight (reset
  --hard/clean -fd can only hit the isolated worktree, never the primary
  checkout — full chain verified). But a real HIGH: iterations ran with no
  `--permission-mode`, so real goals would hang to timeout (feature
  dead-on-arrival; only the trivial spike passed). Fixed with
  bypassPermissions (safe via worktree isolation). Also: auto-remove
  zero-commit worktrees+branches (were leaking every run), base-commit-based
  commit count (was miscounting on non-main repos), server-side maxIterations
  clamp. Re-ran the spike: real iteration now completes.
- **Focus page:** write path CONFIRMED atomic + BOM-free + shape-correct. One
  MED lost-update race (Helm vs. the Jot app both doing whole-file writes)
  — fixed with a stat compare-before-swap + retry so a concurrent Jot write
  is detected and retried, never clobbered.

Takeaway: the ship-reviews earned their cost — the goalOrchestrator
permission-mode HIGH would have shipped a headline feature that silently
didn't work.

## 2026-07-04 — Reusable Electron E2E harness over CDP (scripts/e2e/)

**Built** a standing Electron E2E harness so testing Helm's UI (and later jot/loom) is repeatable, and so an agent or a human can SCREENSHOT and inspect the running app.
Context: Helm is a native Electron app with no browser-servable dev server, so the standard preview_* / browser tools don't apply.
The same ad-hoc CDP dance (launch electron with `--remote-debugging-port`, find the renderer target, drive it) had been hand-rolled repeatedly; this turns it into a small reusable module.

**Files:** `scripts/e2e/harness.mjs` (the module) and `scripts/e2e/demo.mjs` (a verification script that drives Helm end to end).
Put under `scripts/` alongside the existing `scripts/kill-helm.ps1` / `restart-dev.sh` rather than a new `test/` tree, matching where the repo already keeps its dev tooling.
This is a NEW standalone tool that only DRIVES the app from outside; it does not touch `src/` (main.js, renderer.js, preload.cjs).

**CDP transport: raw WebSocket + the `/json/list` HTTP endpoint, ZERO npm dependencies.**
Node 24 (and any Node 18+) ships a global `WebSocket` and `fetch`, so the harness talks CDP directly with nothing to install.
Chose this over the `chrome-remote-interface` package deliberately: on Windows a zero-dependency path is the most robust (no native build, no lockfile churn, nothing to break on `npm ci`), and the CDP surface we need is tiny (`Runtime.evaluate`, `Page.captureScreenshot`, `Runtime.enable` + the `consoleAPICalled`/`exceptionThrown` events, `Page.enable`).
Electron 31 is Chromium ~126, so full modern CDP is available.
The API is intentionally small and obvious: `launch()`, then `eval`, `click`, `type`, `getText`, `waitForSelector`, `screenshot`, `getConsole`/`getConsoleErrors`, `close`.

**Cleanup scope: match on the unique `--remote-debugging-port=<port>` flag, NOT the app-directory basename.**
This is the load-bearing decision and a deliberate divergence from `kill-helm.ps1`.
`kill-helm.ps1` matches electron processes by command line containing `*Tools\helm*`, which is correct for boot-testing (nothing else is running Helm then).
But the E2E harness is expected to run WHILE the user's own Helm is live - and a single Electron app spawns several `electron.exe` (main + GPU + renderer + utility).
Verified at run time: 4 `electron.exe` already matched `*helm*` before launch (the user's session).
Matching on the app-directory basename would have killed that live session too - exactly the class of mistake CLAUDE.md warns about.
The `--remote-debugging-port=<port>` flag is a per-launch unique token that appears only on the main process we spawned, so a `-like` match on it can never hit an unrelated Electron app.
`close()` resolves the matching main PID(s) and `taskkill /PID <pid> /T /F` each, taking the whole child tree (GPU/renderer/utility) with it and nothing else.
Guarded against an invalid/low port to refuse a broadening match.

**Verified end to end** (`node scripts/e2e/demo.mjs`): launched Helm on port 9333, waited for `#pageToggle`, screenshotted the chat dashboard, clicked the Focus tab, waited for `#focusPage` visible, screenshotted again, read console (0 messages, 0 errors), then clean shutdown.
Two real PNGs produced (1184x755, 137 KB + 66 KB, confirmed PNG signatures).
Process check before vs after: 4 Helm `electron.exe` at start, 4 after, 0 strays on port 9333 - the user's session untouched, the launched instance fully gone.

**Pointing it at another Electron app later (jot/loom):** pass `launch({ appDir, command, args, port })`.
`appDir` is the cwd to launch from; `command`/`args` default to `npm`/`["start"]` (the harness inserts `-- --remote-debugging-port=<port>` so the flag reaches electron through npm).
Cleanup keys off the port, so no per-app kill script is needed - the same harness works unchanged for any Electron app whose start script runs `electron .`.

## 2026-07-04 — AXI ecosystem mapped; gh-axi adopted, TOON as a principle (standalone build has thin surface today)

**Decision:** Aidin asked whether to pull in the rest of Kun Chen's "axi"
tools (the token-saving angle). Mapped the whole ecosystem at the source
level (read-only, via gh api). Findings:
- **AXI is a design principle + a small lib (`axi-sdk-js`), not a runtime.**
  The core token lever is **TOON** output (Token-Oriented Object Notation,
  a tabular JSON-alternative, ~40% fewer tokens on structured lists) plus 10
  principles (minimal schemas, pre-computed aggregates to kill follow-up
  calls, definitive empty states, loud-failing flags).
- **Reality check that reframes it:** the dramatic savings (57-74%) are vs
  MCP. Vs an already-lean CLI like raw `gh`, the token delta is ~1% - the
  AXI win there is reliability/turn-count, not raw tokens. So AXI pays off
  where you're replacing verbose JSON/MCP output or making tool output
  unambiguous, not for shaving already-terse commands.
- **All `-axi` tools are Node 20+ and cross-platform** (each carries a
  Windows badge; `axi-sdk-js` has explicit Windows shim-parsing). The
  earlier "lavish server is Unix-only" concern was only its port-recovery
  path (lsof/ps); the core is plain Node HTTP - moot for us anyway since
  Helm's Lavish uses IPC, no server.

**Decided (Aidin: "kör på din rekommendation"):**
- **gh-axi: ADOPTED.** Verified it installs+runs on Windows (`npx -y gh-axi
  --help`, exit 0, its own output is already TOON-compact). Added a
  proportionate rule to the global personal CLAUDE.md: prefer `gh-axi` for
  non-trivial GitHub API work, plain git for local ops.
- **TOON: adopt as a PRINCIPLE, standalone build queued but reconsidered.**
  On reflection, Helm's current agent-facing surfaces are already
  compact (the classifier/judge send short text, not verbose JSON), so a
  standalone "convert Helm's output to TOON" build has thin surface
  *today*. The real value is prospective - as the structured-injection
  features (`/triage` feeding the board, Focus feeding goals, goal-
  orchestrator notes) mature, encode THOSE as TOON. So: fold TOON in with
  those features rather than build a TOON layer into thin surface now.
  Tracked as a Jot task; not built.
- **Also tracked:** stop reading the whole `todos.json` into context when
  only a category/few fields are needed (the AXI minimal-schema lens applied
  to how Jot data is consumed, both by Helm-to-agent injection and by
  Claude reading it directly) - a small recurring token win.
- **Skipped:** terminal-axi (empty repo, LICENSE only), agent-browser-axi
  (redundant with chrome-devtools-axi), rough-cut-axi (niche, no license),
  tasks-axi (redundant with Jot), mcp-compressor (wrong direction).
  chrome-devtools-axi is a later "if/when Helm agents do browser work"
  adopt-candidate (57% fewer tokens vs chrome MCP).

## 2026-07-04 — Fas 4 Lavish: a FIRST-PASS interactive-plan annotate loop (draft, not final UX)

**Built** a v1 of the "Lavish"-style interactive-plan feature (PLAN Phase 4).
The distinctive value over a plain text plan is the ANNOTATE-FEEDBACK LOOP: an HTML mockup is rendered in a sandboxed iframe with an annotation SDK injected, the user clicks an element and types feedback ON it, and each annotation comes back as a structured record that can seed the next agent prompt.
This is explicitly a DRAFT for Aidin to react to - scoped to the core loop plumbing (show mock -> annotate -> get structured feedback out), NOT a polished product.

**Lifted the annotation-capture logic from Kun Chen's lavish-axi (MIT), did not reinvent it.**
Fetched `src/artifact-sdk.js` read-only via `gh api` and lifted its `selector()` (best-effort CSS path: prefer `#id`, else `tag:nth-of-type`, capped ~5 ancestors), `context()` (the `{uid, selector, tag, text}` record, `text` = up to ~240 chars of trimmed innerText), the shadow-DOM floating annotation-card overlay, the capture-phase hover/click handlers with the `isNativeInteractiveControl` guard (native controls behave natively instead of annotating), and `snapshot()` (indented uid/tag/text tree).
Attribution is in the header of `src/lib/lavishSdk.js`.
**Wrote fresh / deliberately dropped:** all of lavish-axi's Mermaid pan/zoom, its layout-overflow auditing, and its text-range selection (out of scope for v1); and - the key architectural collapse - its entire Express-server + postMessage + HTTP long-poll + `state.json` transport.
lavish-axi needs that only because its artifact is a cross-origin sandboxed iframe with no app context (and that server layer is macOS/Linux-only, so it would break on Windows anyway).
In Electron the iframe lives in the same renderer process, so the injected SDK posts each record to `window.parent` (the one channel that crosses the sandbox boundary), the renderer host collects it into `lavishState`, and a formatter turns it into text on demand.
No server, no long-poll, no persisted state.

**Improvement over lavish worth keeping:** if the artifact HTML already carries a stable `data-lavish-id` on an element, the SDK records it as `lavishId` (via `closest('[data-lavish-id]')`), and the formatter prefers that anchor over the recomputed CSS selector - so anchoring is exact when we control the mockup.

**The one non-obvious problem, and its fix: CSP.**
First attempt loaded the mockup via the iframe's `srcdoc` attribute.
A `srcdoc` document INHERITS the embedder's Content-Security-Policy, and Helm's page CSP is `default-src 'self'` - which blocks the inline SDK script (a srcdoc document can only make the inherited policy STRICTER, never looser).
Confirmed live: the SDK `<script>` was present in the frame DOM but never executed, with a `Refused to execute inline script ... default-src 'self'` console violation.
Switched to loading the mockup as a `data:text/html` URL (a separate browsing context) AND pinned the SDK's exact sha256 in the parent CSP's `script-src`.
A framed `data:` document still has the embedder's CSP applied on top of its own, so the parent MUST whitelist the SDK by hash for it to run - the rest of the app stays inline-script-free (no blanket `'unsafe-inline'`).
The SDK source is deterministic (`buildArtifactSdkSource()` returns a constant string), so a single pinned hash works; Chromium's reported hash matched the computed one exactly.
To stop this from silently breaking if the SDK is ever edited, `spike/test-lavish.mjs` asserts both that the exported `LAVISH_SDK_SCRIPT_SHA256` matches the current source AND that `index.html` contains that hash - drift fails loudly (it already caught one hash change during this build, after a `snapshot()` tweak).
Artifact author's own inline scripts do NOT run under this scheme (only the pinned SDK does) - acceptable for v1 (mockups are static HTML); noted as a later consideration if generated mockups need their own scripts.

**Single source of truth in an ES module, bridged to the non-module renderer via IPC.**
`renderer.js` is loaded as a plain `<script>` (not `type=module`), so it can't `import` from `src/lib/lavishSdk.js`.
Rather than duplicate the SDK-source and formatter into the renderer, `main.js` exposes `lavish:buildSrcdoc` (wrap artifact HTML into the SDK-injected document) and `lavish:formatPrompt` (format collected annotations to text) - both pure string transforms, no fs.
A separate `lavish:readFile` reads an HTML artifact by path (the renderer has no fs).
`preload.cjs` exposes `readArtifactFile` / `buildArtifactSrcdoc` / `formatAnnotations`.

**Surface: a new "Plan" page**, added via the exact same `#pageToggle` pattern as Focus/Goal/Analysis/Archive/Settings (a `data-page="lavish"` button + `#lavishPage` div toggled with `.hidden`, rendered by `renderLavishPage()`).
Load form accepts pasted HTML OR a file path (with the composer's own `pickFiles` picker); an annotate-mode toggle; the sandboxed review iframe; a collected-annotations list; and "Send to composer" / "Copy feedback" / "Clear" actions.
"Send to composer" drops the formatted block into the focused pane's composer and switches to the Chat page (also copies to clipboard); "Copy feedback" just copies.

**Deliberate re-render split so a click never reloads the mockup.**
A new annotation (or Clear/Remove) refreshes ONLY a stable `#lavishCollectedWrap` region via `renderLavishCollected()`, never the whole page - because re-rendering the page would recreate the iframe, reloading the mockup and resetting the SDK's state on every single click.
Found and fixed this during live testing.

**Guardrails honored:**
- USER-TRIGGERED ONLY - everything starts from a click; nothing on a timer.
- Left untouched (recently-committed, unrelated): voice input code, mic button, thinking indicator, language picker, Focus page, Goal page.
- Did NOT call the Agent tool / delegate - built directly.

**Verified end-to-end via live CDP against the running renderer** (`--remote-debugging-port`, the established technique), driving the frame through a `Page.createIsolatedWorld` context:
1-3. Plan page shows, iframe renders, SDK executes inside the frame (mockup DOM present).
4. Clicking a NON-interactive element (`<h1>`) opens the annotation card in the shadow DOM (clicking a `<button>` correctly does NOT - native controls are exempt, exactly as lavish intends).
5. The typed feedback lands in host `lavishState` with correct `selector` (`div#hero > h1`), `tag`, `text` ("Welcome home"), `lavishId` (`hero-block`, picked up from the ancestor's `data-lavish-id`), and `prompt`; DOM snapshot captured on ready.
6. The formatter (real IPC -> main -> lavishSdk) produced the expected text block, preferring the `data-lavish-id` anchor.
7. Snapshot excludes the injected SDK `<script>`.
8. Toggling annotate mode OFF suppresses the card (no new annotation) without rebuilding the iframe.
9. "Send to composer" drops the formatted feedback into the focused pane's composer and switches to Chat.
Plus `node --check` on all changed JS, a standalone unit test of the pure helpers (`spike/test-lavish.mjs`, 14 assertions incl. the CSP-hash drift guard), and a clean boot with zero CSP violations in the log.

**What still needs Aidin's real click-test:** the actual feel of clicking-and-typing on a real, visually-styled mockup (the CDP test dispatches synthetic clicks, not a human's); whether the "Plan" page is the right home vs. integrating into the composer/plan flow; and the annotation-card ergonomics on a dense layout.

**This is a first-pass DRAFT.** Explicitly deferred to a later pass: artifact GENERATION during planning (an agent producing the mockup in the project's visual style - PLAN calls this the noted next step); the deep "start a fresh rooted session with this feedback as the prompt" wiring (v1 drops it into the composer instead); Mermaid/text-range/layout-audit parity with lavish-axi; and letting artifact-authored scripts run.

## 2026-07-04 — Fas 3 Point 11: a minimal FIRST-PASS UI onto the goal orchestrator (draft, not final UX)

**Built** the first UI that can trigger and watch `src/lib/goalOrchestrator.js`'s `runGoal`, which had been backend-only since earlier the same day (no interface consumed it).
This is explicitly a DRAFT for Aidin to react to - the point is to make the already-built orchestrator TESTABLE, not to finalize its interface.
Deliberately kept minimal and clearly-bounded rather than deeply integrated: one run at a time, one new "Goal" page, no coach/escalation layer.

**Surface: a new "Goal" page**, added via the exact same `#pageToggle` pattern as Focus/Analysis/Archive/Settings (a `data-page="goal"` button + a `#goalPage` div toggled with `.hidden`, rendered by `renderGoalPage()` in `renderer.js`).
Not threaded into the crowded session-list/pane paths - same isolation reasoning the Focus page used.
The page has three inputs (goal textarea, project-folder text field with the composer's own "…" `pickFolder` picker, max-iterations number defaulting to 5), a Start button, a Cancel button, a live per-iteration progress list, and a final summary card.
The project folder defaults to the focused pane's `cwd` when it has one (matching the composer's rooting default), else the picker.

**Live progress uses its OWN IPC channel, parallel to session events - not overloaded onto `session:event`.**
`main.js`'s `goal:run` handler builds a `send()` that does `webContents.send("goal:event", { goalRunId, ...payload })`, exactly mirroring the shape of the existing `session:event` path (`launchId` there, `goalRunId` here).
The handler wires the orchestrator's `onIteration` callback straight to `send({ kind: "iteration", record })`, and emits `started` / `done` / `error` on the same channel.
`preload.cjs` exposes `runGoal` / `cancelGoal` / `onGoalEvent` (the last mirrors `onSessionEvent`'s subscribe-and-return-unsubscribe shape).
The renderer's `onGoalEvent` subscriber ignores any event whose `goalRunId` doesn't match the current `goalRunState`, so a stale/previous run's late events can't clobber current state, and it only re-renders when the Goal page is actually visible.

**Cancel is wired to the real `cancelToken`.**
`goal:run` holds `{ cancelToken }` in a `liveGoalRuns` map keyed by a `crypto.randomUUID()` goalRunId (same id discipline as `session:start`'s launchId); `goal:cancel` flips `run.cancelToken.cancelled = true`, and the orchestrator stops at its next iteration boundary (an in-flight iteration always runs to its own completion/timeout - the module never kills mid-iteration).
The handler resolves immediately with `{ ok, goalRunId }` (fire-and-return) so the renderer can wire Cancel while the run streams progress; the run's own resolution/rejection is reported over `goal:event`, never left to reject an already-resolved `invoke`.

**Guardrails honored (this runs REAL autonomous claude subprocesses making real commits):**
- USER-TRIGGERED ONLY - the run starts only from the Start button's click handler; nothing here is on a timer or any automatic event.
- No push/merge affordance - the orchestrator already refuses to push/merge/PR, and this pass deliberately adds no button that would.
- The final summary card states explicitly, in the UI, that the run did NOT push or merge and that all work lives in the isolated worktree + branch (shown by path) for the user to review/merge or discard by hand - so Aidin knows where the work went.
- Left untouched (recently-committed, unrelated): the voice input code, mic button, thinking indicator, language picker, and the Focus page.

**Verified the WIRING without a full real autonomous run** (per the task's explicit instruction not to spend tokens/spawn real claude just to test UI):
- `node --check` on all changed JS (`main.js`, `preload.cjs`, `renderer.js`, `goalOrchestrator.js`) - all pass; CSS brace-balance 325/325.
- Full boot-test via `scripts/restart-dev.sh` (never a bare taskkill, per CLAUDE.md) - clean boot, no errors.
- Live CDP verification against the real running renderer (the same `--remote-debugging-port` technique the token-ticker investigation established): clicking the Goal tab renders the page with all form fields, Cancel correctly disabled while idle; all three bridge methods (`runGoal`/`cancelGoal`/`onGoalEvent`) present on `window.helm`; and the real render functions `goalIterationCard`/`goalSummaryCard` produce correct DOM (iteration card shows number + "committed" badge + summary + key-changes with the `goal-iter-ok` accent class; summary card shows commits/branch/worktree/stopped-reason plus the "did NOT push or merge" note).
- The complete IPC round-trip was proven incidentally-but-strongly: a Start click against a deliberately non-existent folder drove the REAL path (renderer -> `goal:run` IPC -> `runGoal` -> `createWorktree` throws "Project path does not exist" BEFORE any iteration -> real `goal:event` `{kind:"error"}` -> `onGoalEvent` -> `goalRunState.status="error"` -> re-render). This confirms the end-to-end channel AND that a bad path fails fast with ZERO claude subprocesses spawned and zero tokens spent. Confirmed afterward: no stray worktree (`git worktree list`), no `helm/goal-*` branch, helm's own working tree clean apart from the intended edits.
- NOT exercised live (would need a real autonomous run): a successful `iteration`/`done` event mutating state through to the summary card. That path is the same handler/switch already proven for the `error` kind, and both render funcs are proven to render correctly - but the genuinely-successful end-to-end run is left for Aidin's own test, as instructed.

**This is a first-pass DRAFT needing Aidin's review.** The UX is genuinely open (a dedicated page was one of several equally-valid choices); no coach/escalation layer (Point 12); single concurrent run; no re-run-from-summary, no worktree-open-in-explorer shortcut, no per-model/effort selection in the form (the backend accepts them; the form omits them for v1 simplicity). Point 11 remains IN PROGRESS, not done.

## 2026-07-04 — Continuous voice input: rolling re-transcription (live partials while holding), not real streaming

Follow-up to the same-day voice-input entries (hold-to-record, multilingual,
language picker, whisper-base).
Aidin's ask: make transcription CONTINUOUS - show what it's hearing
progressively WHILE he speaks, like Claude Desktop, instead of all-at-once when
he releases the hold.

**Design reality, stated honestly: Whisper is NOT a streaming model.**
There is no token-level streaming to tap into - the model transcribes a whole
clip at once.
So "continuous" here is built as ROLLING RE-TRANSCRIPTION, the pragmatic
approach that actually fits Whisper: while the hold is active, on an interval we
take ALL the audio captured so far, transcribe the whole accumulated clip, and
replace the live partial text in the composer with the latest fuller result; on
release, one last full transcription produces the authoritative text.
No attempt at real streaming was made because the model can't do it.

**Kept the trigger identical - this is purely additive.**
Hold-to-record (mic button mousedown/mouseup/mouseleave, and Alt-in-composer
keydown/keyup/blur) is untouched, as are the mic SVG icons, the language picker,
the model, and the thinking indicator - all already done and committed.
Continuous is about showing partial results DURING the existing hold, not a new
interaction.

**Rolling loop (`src/renderer/renderer.js`, `startVoiceRecording` ~line 228).**
`MediaRecorder` is now started with a 1s timeslice (`mediaRecorder.start(1000)`)
so `dataavailable` chunks accumulate ~every second instead of arriving as one
blob only at stop.
A `setInterval(rollingTick, VOICE_ROLLING_INTERVAL_MS)` (new named tunable
constant, 2000ms) drives the live updates: each tick concatenates the
chunks-so-far, reuses the EXACT existing path - `decodeToMono16k` +
`window.helm.transcribeVoice(samples, language)` -> the same
`voice:transcribe` IPC -> the same `transcribeAudio` in `voice.js` - and shows
the result as the live partial.
No second transcription path was built; `voice.js` is UNCHANGED (the same
`transcribeAudio` works on a partial clip - confirmed by reading it, nothing
there assumes a "complete" utterance).
2s was chosen because whisper-base takes a couple seconds per call and each tick
re-transcribes the FULL clip-so-far; shorter risks the model never keeping up.

**Non-overlap: skip a tick, never queue a backlog.**
The per-recording entry carries an `inFlight` boolean.
`rollingTick` returns immediately if `inFlight` is already true (the previous
tick's whisper call hasn't returned yet), so a slow transcription just means
fewer live updates that interval, never a pile-up of queued calls that outlives
the recording.
The interval is cleared the instant `MediaRecorder` fires `stop`
(`clearInterval(entry.rollingTimer)`), and a `stopped` flag makes any
late-returning rolling tick discard its own result rather than clobber the
authoritative final text.
A tick also discards its result if `activeRecordings.get(index) !== entry` - the
pane was reset/replaced mid-recording (same staleness concern the index-keyed
map already guards elsewhere).

**Text replacement: replace only the VOICE span, never the user's typed text.**
The core requirement was that a partial "vi ska" becoming "vi ska bygga" updates
IN PLACE rather than appending duplicates, AND that text the user typed manually
before recording is never destroyed.
Implemented via a pure helper `replaceVoiceSpan(currentValue, voiceStart,
voiceLen, newVoiceText)` returning `{ value, newVoiceLen }`.
`voiceStart` is captured once - the caret position (`selectionStart`) when the
hold began - so everything before it is the user's own text and is left
untouched; `voiceLen` tracks how much the voice text currently occupies, so each
update replaces exactly the previous partial's span.
A separator space is added before the voice text only when there is preceding
user text that doesn't already end in whitespace, and that space counts as part
of the voice span so a later SHORTER partial still replaces cleanly (no stranded
space).
The final result on release goes through the same helper, replacing the last
partial; an empty final result cleanly removes any stray partial rather than
leaving it behind.

**Perf honesty (a known v1 limitation, not papered over).**
whisper-base is slower than tiny, and re-transcribing the full accumulated clip
every 2s is real CPU that grows with recording length.
The non-overlap skip and immediate interval-stop-on-release are implemented;
a windowed/VAD approach that only re-transcribes recent audio was deliberately
NOT built for v1 (over-engineering before we know it's needed).
If long recordings feel laggy in real use, that windowing is the documented next
step.
A second real unknown: this decodes a mid-stream webm/opus blob
(header chunk + accumulated chunks) via `decodeAudioData` on each tick - the
standard MediaRecorder-timeslice approach, but its behavior on a partial stream
is exactly the kind of thing only a live mic can confirm.

**Verified.**
`node --check src/renderer/renderer.js` passes.
The text-replacement logic was unit-tested standalone
(`spike/test-voice-span-replace.mjs`, a new spike): it reads the shipped
`replaceVoiceSpan` out of renderer.js and evals it (testing the real code, not a
copy), 10 assertions, all pass - empty composer, partial growing in place,
partial shrinking, preceding user text with/without trailing whitespace, newline
separators, final-empty-removes-stray, and the after-span edge case.
Full boot-test via `scripts/restart-dev.sh` (never a bare taskkill, per
CLAUDE.md): clean boot, killed exactly Helm's own 4 PIDs, no errors in the
boot log, exactly 4 Helm PIDs running afterward (no stray duplicate
instances).
**What this could NOT verify** (no microphone on this machine, same limitation
as every prior voice-input entry): the actual live experience - partials
appearing in the composer while speaking and updating in place, the 2s cadence
feeling right, whisper-base keeping up (or not) with the rolling re-transcription
on real hardware, mid-stream webm/opus decoding working per-tick, and whether the
final text cleanly supersedes the last partial.
All of that needs Aidin's own real-microphone test.
The non-overlap skip logic and the voice-span replacement logic ARE verified
(the former by code inspection of the `inFlight`/`stopped` guards, the latter by
the standalone unit test above).

## 2026-07-04 — Voice input: a language picker next to the mic (replaces hardcoded forced-Swedish)

Follow-up to the same-day "force Swedish transcription" entry, after Aidin's
feedback: instead of forcing one language, give him a small language menu next
to the mic button so he can pick the transcription language (he mixes Swedish
and English).
The previous version hardcoded `const TRANSCRIBE_LANGUAGE = "swedish"` in
`src/lib/voice.js` and passed it unconditionally.
That entry itself had named "a language toggle/picker in the composer" as the
proper fix for true mixed use, deferred at the time - this is that fix.

**UI - reused the existing dropdown component, not a hand-rolled `<select>`.**
The composer's model/effort/permission pills are all built by one shared helper,
`dropdownPill(initialValue, options, onSelect)` (`renderer.js:567`), which
returns `{ el, setValue, value }` and renders a `.meta-pill` button that opens
the app's own `showContextMenu` on click.
The new language picker (`languageDD`, `renderer.js` in `paneComposerEl`) calls
that exact same helper with the same `[{value,label}, …]` option shape, so it
looks and behaves identically to its neighbours - same class, same menu, same
keyboard/mouse behavior.
It is appended into the same `controls` row, immediately before `micBtn`
(`controls.append(… effortDD.el, languageDD.el, micBtn, sendBtn)`), so it sits
right next to the mic it controls.

**Options / default.**
Auto-detect, Svenska (swedish), English (english), plus Norsk (norwegian),
Dansk (danish), Deutsch (german), Español (spanish) - a short list, trivially
added since they're all just more `{value,label}` entries the same pattern
already handles.
Display labels are the nicer native names; the `value` passed through is always
the full lowercase English language NAME transformers.js requires
("swedish"/"english"/…), or "auto" for auto-detect - never an ISO code.
Default selection is **Svenska** (`config.voiceLanguage` defaults to "swedish"),
preserving today's forced-Swedish behavior exactly.

**Persistence - a single global setting, via the existing setConfig IPC.**
Added `voiceLanguage: "swedish"` to `DEFAULT_CONFIG` (`config.js`) - a top-level
primitive, so the existing shallow `{ ...current, ...patch }` merge in the
`config:set` handler (`main.js:168`) persists it correctly with no
nested-object protection needed (unlike `jot`/`autoCompact`/etc.).
The dropdown's `onSelect` calls `window.helm.setConfig({ voiceLanguage })`
and stores the returned config back into `state.config`, the same one-liner
every other setting toggle in the renderer uses.
The dropdown's initial value is read back from `state.config?.voiceLanguage`
on render.
Deliberately a single global setting, not per-pane state (overkill for v1, per
the ask).

**Plumbed the language through to `transcribeAudio`.**
The path is renderer's `startVoiceRecording` -> `window.helm.transcribeVoice`
(preload.cjs) -> IPC `voice:transcribe` (main.js) -> `transcribeAudio` (voice.js).
Each hop now carries the language: `startVoiceRecording` reads
`state.config?.voiceLanguage || "swedish"` fresh at transcribe time (so a change
mid-recording still applies) and passes it; `transcribeVoice(samples, language)`
forwards it in the IPC payload; the `voice:transcribe` handler destructures
`{ samples, language }` and passes it on; `transcribeAudio(float32Samples,
language = "swedish")` uses it.
In `voice.js` the hardcoded `TRANSCRIBE_LANGUAGE` const is replaced by
`DEFAULT_TRANSCRIBE_LANGUAGE = "swedish"` (the fallback default, so a stale
caller that passes nothing keeps today's behavior rather than silently
switching to auto-detect).
When the value is "auto" (or null/empty) the `language` option is OMITTED
entirely from the pipeline call - that is how transformers.js's ASR pipeline
triggers auto-detection (its JSDoc: language "Default is `null`, meaning it
should be auto-detected."); otherwise it passes
`{ language: <name>, task: "transcribe" }`.

**Left untouched, per the ask:** the hold-to-record logic, the mic SVG icons,
and the thinking indicator - all already done and committed. This change only
ADDS the dropdown and the language plumbing.

**Verified.** `node --check` on all five changed files
(`config.js`/`voice.js`/`main.js`/`preload.cjs`/`renderer.js`) - all pass.
A mechanical plumbing test (standalone script importing the real
`transcribeAudio`, fed a 1s silent 16kHz buffer): a named language ("english")
runs without throwing; "auto" runs without throwing AND emits transformers.js's
own `"No language specified - defaulting to English (en)."` log line - the
message that only appears when the `language` option is genuinely omitted,
proving the auto-detect branch works as intended, not just that it doesn't
crash; the no-arg default correctly ran in Swedish mode (produced Swedish
output off the silence, confirming the "swedish" fallback passes a real
language); an empty string behaved as auto-detect (same omitted-language log).
Full boot-test via `scripts/restart-dev.sh` (never a bare taskkill, per
CLAUDE.md) - clean boot, no errors, killed exactly Helm's own 4 PIDs.
**What this could NOT verify** (no microphone and no Swedish voice on this
machine, same limitation as every prior voice-input entry): real transcription
QUALITY in any language, and the dropdown actually rendering/selecting/
persisting through a real click in the running app. Both need Aidin's own live
test - in particular whether picking each language actually improves his real
Swedish and mixed Swedish/English transcription over the old forced-Swedish
behavior.

## 2026-07-04 — Live token ticker investigated (no reproducible bug found); thinking-dot recolored + animated

**Context:** Aidin reported, after live-testing the 2026-07-03 "Live time/
tokens ticker" feature: "Och dessutom räknar den fortfarande inte upp tokens
live" (it still doesn't count up tokens live). That feature's own DECISIONS.md
entry admits no live click-through was ever done — only a standalone Node
script against a captured transcript, plus a static code read. Per this
repo's own Bug-Fixes-&-Testing rule, this had to be reproduced end-to-end in
the real running app before touching any code — "I read the code and it
looks right" was explicitly not an acceptable standard here, since that is
exactly what shipped the bug in the first place.

**How it was actually driven live:** Helm is a native Electron app with no
browser-servable dev server, so the standard preview tools don't attach to
it. Launched the real `electron.exe` (found in `node_modules/electron/dist/`)
directly with `--remote-debugging-port=9333`, which exposes a Chrome DevTools
Protocol endpoint over the real renderer page. A small throwaway Node script
(`cdp.mjs`, not committed — scratchpad only) connected over that CDP
WebSocket and used `Runtime.evaluate` to fill the real composer textarea,
click the real Send button, and read back real `pane` state and DOM content
from the live running app — genuine end-to-end interaction, not a simulation.
(Aside, logged for whoever hits this next: launching the Electron process via
a bash `(cmd &)` detached subshell is unreliable in this environment — the
process and its CDP port die a few seconds after the bash tool call returns,
even though `electron.exe` itself is still technically running. Launching via
`run_in_background: true` on the Bash tool, or via a `Start-Process`-launched
detached process, both kept the CDP port alive reliably across many
subsequent tool calls.)

**What was actually verified, live, across 5 independent real runs**
(including 2 with temporary raw stream-json tracing added to both
`launcher.js` and `renderer.js`'s "usage" handling, removed again afterward —
`git diff` on both files is empty): a brand-new session with no prior
`--resume`, a resumed/continued session, and a second pane in split-view all
showed the exact same correct chain, every time:
- `launcher.js`'s per-`assistant`-event usage-emission block (added in the
  2026-07-03 commit) fires correctly off real `evt.message.usage`, deduped by
  `message.id` as designed — confirmed via raw trace output, not inference.
- Every `{kind: "usage", totalTokens}` event reaches
  `window.helm.onSessionEvent` in the renderer and finds its
  `launchPaneHistory` entry (`entryFound=true` on the very first event of a
  fresh run, checked explicitly).
- `pane.liveTokens` increments correctly and cumulatively (watched it climb
  e.g. 492,049 → 1,119,755 → 1,892,945 → 2,162,001 tokens over one real run).
- `renderLiveStats` finds `.pane-status` and creates/updates
  `.pane-live-stats` with real, changing text (` · 21.0s · 236.1k tokens`
  etc.), confirmed via both `document.querySelector` reads and a real
  `Page.captureScreenshot` showing the ticker visibly live under a busy pane.
- `startLiveStatsTicker`'s 250ms interval is genuinely running (elapsed-time
  component of the readout climbed in step with wall-clock time across
  repeated samples).

One earlier test run did show 4 "usage" emissions from `launcher.js` with no
matching renderer-side receipt — the initial signal that looked like a real
race (an `await window.helm.suggestModelEffort(...)` / `startSession(...)`
gap between a send starting and `launchPaneHistory.set()` actually running,
which could in principle let very early stream events arrive before the map
entry exists). This did NOT reproduce on a clean, isolated retest with full
instrumentation from event #1 onward. The likely explanation, in hindsight:
that specific test had accidentally been driven against a pane that had
resumed a huge, live, already-1900-turns-deep session (traced back to a
stray `cwd`/session default left over from earlier manual CDP polling
in this same investigation) — self-inflicted test contamination, not a
defect in the shipped code.

**Conclusion: no reproducible defect found in the current, committed ticker
code.** The most plausible real explanation for Aidin's report is that his
live Helm window was still running the pre-fix build — this repo has no
hot-reload (confirmed: no file-watcher, no `webContents.reload` call
anywhere in `main.js`), so any code change only takes effect after a full
restart via `scripts/restart-dev.sh`, and 10 further commits shipped after
the ticker commit before this report came in. Filed here rather than
silently closed out, since it's a real user report and the fix (if the
stale-window theory is right) is simply "restart Helm" — flagging in case
it recurs after a confirmed-fresh restart, which would mean this
investigation missed something and needs to resume with a different angle
(e.g. a specific model/effort combination, or a much longer real session,
not reproduced here).

**Thinking-dot color + animation (Aidin's second ask, same message):**
"Kan vi ha en roligare tänkar ikon, inte bara pulserande och roligare färg än
blå, orange som bubblorna hade passat bättre tror jag" (a more fun thinking
icon, not just pulsing, and a more fun color than blue — orange like "the
bubbles"). "Bubblorna" is the user's own chat turn bubbles
(`.turn.user .turn-bubble`), which already use `background: var(--accent)`
(`#d97757`) — grepped `style.css` for existing orange/amber values first per
the ask to reuse rather than invent; `--accent` was the obvious existing
candidate, already described in an existing comment as "accent orange."
- `.pane-status-icon` (`src/renderer/style.css`) recolored from `var(--active)`
  (blue) to `var(--accent)` (orange), matching the user bubbles exactly.
- Replaced the flat scale+opacity pulse with a three-dot wave: the single
  `<span>` `setPaneBusyUI` already creates is the center dot, with
  `::before`/`::after` pseudo-elements adding the left/right dots (no JS
  change needed) on staggered `animation-delay` for a left-to-right bounce,
  evoking a "typing" indicator rather than a flat pulse.
- The original `pane-status-pulse` keyframe was kept (renamed usage only on
  `.pane-status-icon` itself) since `.icon-btn.recording` (the mic button)
  independently reuses that same keyframe name for its own unrelated
  live-recording cue.
- The reactive "ping" on new events (`tool_use`/`usage`/`assistant`) now
  pings orange instead of blue too; still only the center dot pings, with the
  two side dots continuing their ambient wave underneath.

**Verified:** `node --check` on all touched JS (traces added then fully
reverted — confirmed via `git diff` showing zero changes to `launcher.js`/
`renderer.js`), a CSS brace-balance check, a full `scripts/restart-dev.sh`
boot-test (clean log), and live CDP verification of the new dot: computed
`background-color: rgb(217, 119, 87)` (`#d97757`, matching the bubbles
exactly) on the real running element during a real busy run, `animationName`
confirmed as `pane-status-wave` on the pseudo-elements and `pane-status-ping`
reactively on new events, and a real screenshot showing both the orange user
bubble and the orange animated thinking dots side by side.

## 2026-07-04 — Fas 3 Point 11 v1: a real goal orchestrator (`src/lib/goalOrchestrator.js`)

**Built** the first real slice of PLAN.md's Point 11 ("real orchestration") —
the biggest piece of Fas 3 still unbuilt. New module
`src/lib/goalOrchestrator.js` exporting `runGoal({ projectPath, goal,
maxIterations, model, effort, onIteration, cancelToken })`. Backend/library
only, same posture as `worktree.js` before it — no dispatch UI, no wiring
into `main.js`/`renderer.js`, nothing consumes it yet on purpose.

**Shape, adapted (not copied) from gnhf's actual source-verified
architecture** (DECISIONS.md's 2026-07-03 source-read entries, PLAN.md's
Phase 4 "DECIDED" note: vendor/adapt gnhf's `Orchestrator` pattern, not a
live dependency — there's no package boundary to depend on cleanly anyway):

1. **Isolated worktree per run**, via `worktree.js`'s already-spike-verified
   `createWorktree(projectPath, {...})` — all iterations run there, the
   primary checkout is never touched.
2. **A loop of FRESH `claude -p` subprocess iterations, no `--resume`** —
   confirmed live (2026-07-03) as gnhf's real architecture for the CLI-agent
   family, not an assumption to revisit. Reuses `launcher.js`'s
   `resolveClaudeBinary()` + direct-`.exe`-spawn convention (the same
   space-truncation-bug avoidance already proven there) rather than
   reinventing subprocess plumbing. Capped at `maxIterations` (default 5) —
   v1 is deliberately small-scale.
3. **Continuity via `.helm-goal/notes.md` in the worktree, not
   conversation memory** — `readOrCreateNotes` reads (creating if absent)
   before each iteration and folds the content into that iteration's prompt;
   `appendNotes` appends a structured summary after. This is gnhf's actual
   verified continuity mechanism, not an invented alternative.
4. **Structured per-iteration output**, matching the exact cost-optimized
   recipe `judge.js`/`orchestratorHelper.js` already established
   (`--output-format json` + `--json-schema`, though NOT the Haiku-only/
   no-tools stripped-down variant those two use — an iteration is a real
   coding turn that needs its normal tools, unlike a classifier/judge call).
   Schema: `success` (bool — false discards the iteration), `summary` (one
   sentence, doubles as the git commit message — no separate LLM call to
   produce one, mirroring gnhf), `keyChanges` (array), `keyLearnings` (array
   — the only channel through which knowledge survives into the next fresh
   subprocess). The iteration system prompt explicitly instructs: smallest
   next step, run your own build/test/lint, do NOT commit yourself (the
   orchestrator commits), stop any background processes before finishing.
5. **One orchestrator-authored git commit per successful iteration**,
   message built from that iteration's own `summary` field
   (`[goal-orchestrator] iteration N: <summary>`). On `success:false` or a
   hard process error (timeout/spawn failure/bad JSON/schema mismatch):
   `git reset --hard` + `git clean -fd` in the worktree, mirroring gnhf's
   verified rollback behavior. A "commit itself failed" case (e.g. a hook
   blocked it) is deliberately NOT treated the same as a bad iteration — it's
   logged clearly and the (presumably good) changes are left uncommitted for
   a human to inspect, rather than being discarded.
6. **Stop conditions**: `maxIterations` reached, two consecutive
   `success:false`/hard-error iterations in a row, or an explicit
   `cancelToken.cancelled` flag checked between iterations (never mid-run —
   an in-flight subprocess always finishes or times out on its own).
7. **Never pushes, never merges to the primary checkout, never opens a PR** —
   per the human-gating principle (PLAN.md Phase 3) and matching the
   `ship-review` skill's own "stop before push" stance (same reasoning:
   pushing/merging is more consequential and harder to undo than a local
   fix-and-verify loop). Returns `{ worktreePath, branchName, notes,
   commitCount, iterations, stoppedReason }` and leaves everything on disk
   for a human (or a future dispatched review pass) to look at.
8. **`onIteration` callback**, optional, fires after each iteration's result
   — for a future UI/CLI caller to show live progress. No UI built this pass.

**A real ordering bug caught by the spike, not by inspection:** the first
version appended to `notes.md` AFTER `commitIteration`'s `git add -A && git
commit`, so every successful commit captured notes.md one iteration stale,
and the worktree was left dirty (`git status --porcelain` showed a modified
`notes.md`) after every "successful, nothing left to review" run. Fixed by
moving `appendNotes` before `commitIteration` in the success branch only —
the failure/error branches correctly already appended AFTER
`discardWorktreeChanges` (a `reset --hard` would otherwise wipe an
uncommitted pre-discard append). Caught because the spike asserts a genuinely
clean working tree post-run, not just "a commit happened somewhere."

**Verified with a real spike, real `claude` subprocess calls, not mocked**
(`spike/test-goal-orchestrator.mjs`) — this feature's entire value
proposition is real autonomous iteration, so per Aidin's own instruction it
had to be proven against a live invocation. Goal: "create hello.txt
containing the word hello, then stop" against a scratch git repo under the
OS temp dir (never Helm's own working tree). Real run: 3 iterations (the
capped max), first one created and committed `hello.txt`, the next two
correctly recognized the goal was already complete and made no further
changes (still committed, since `success:true` — a genuinely idempotent
"nothing more to do" report, not a bug). 24 real assertions, all passed:
worktree created on disk, checked out on the right `helm/goal-*` branch,
3 real commits independently visible via `git log main..branch` (not just
this module's own count), `hello.txt` content verified byte-exact both in
the worktree AND inside the actual commit via `git show branch:hello.txt`
(rules out an uncommitted stray file passing the check), working tree
genuinely clean post-run, `notes.md` content matches what's actually on disk
and documents the iteration, `stoppedReason` correct, primary repo checkout
(`main`) completely untouched throughout, and the scratch repo has zero
remotes at all — proving push wasn't just skipped but structurally
impossible in this test. Total spike cost: a few cents (Haiku-effort-`low`
Sonnet calls).

**A second, environmental (non-code) issue surfaced and fixed in the spike
itself:** the first two spike versions called `fs.rmSync` directly on the
scratch root without first calling `worktree.js`'s own `removeWorktree()` —
unlike the pre-existing `test-worktree-lifecycle.mjs`, which does. This left
git's internal `.git/worktrees/<id>` registration pointing at a directory
Node was deleting out from under it, and Windows would refuse to release the
directory handle (`EPERM`/"being used by another process") for tens of
seconds afterward — confirmed NOT a leftover process (checked via
`Get-CimInstance`, nothing had the path open) and confirmed NOT reproducible
in the already-proven worktree-only spike, which does call `removeWorktree`
first. Fixed by adding the same proper teardown call before the raw
directory delete; re-ran clean immediately after.

**Explicitly deferred to a future pass** (v1 scope, not gaps to silently
paper over): a dispatch UI (start/monitor/cancel a goal run from Helm's
own interface — `onIteration`/`cancelToken` are the hooks a future caller
would use, nothing consumes them yet); the coach/escalation layer (PLAN.md's
Point 12 framing — this module has no judgment about WHEN to escalate to
Aidin, it just runs and stops on its own fixed conditions); real cancellation
wiring beyond the flag itself (no IPC channel, no way for a human to actually
flip `cancelToken.cancelled` from a running UI yet); dependency-install into
the worktree (same gap `worktree.js`'s own `createWorktree` already defers —
a goal touching a project that needs `npm install` to even build will have
its first iteration discover and presumably fix that itself, same as gnhf's
own documented behavior); a configurable `--permission-mode` per run (the
spike ran successfully on the CLI's own default, unconfigured — a future
pass may want tighter/looser control per project, matching firstmate's
per-project mode idea already noted in PLAN.md's Phase 4 section); and any
independent build/test verification of an iteration's own `success:true`
self-report (gnhf's own documented weak spot — v1 trusts the agent's
self-report plus process exit code only, same as gnhf).

**Verification commands run:** `node --check` on both new files; confirmed
`goalOrchestrator.js` imports only `node:child_process`/`node:fs`/`node:path`
plus the two local lib modules (no Electron-specific import, so it works in
plain Node outside the Electron app, matching the "pure library module" ask);
`node spike/test-goal-orchestrator.mjs` — full real run, all 24 assertions
passed (paste of the actual run output kept in this session's own report,
not duplicated here). No boot-test via `restart-dev.sh` — this is a pure
backend library with no `main.js`/renderer wiring, per the task's own scope.

## 2026-07-04 — Mic button: SVG icon instead of emoji, and a standing "icons over emoji" convention

Aidin's feedback on the hold-to-record mic button (previous entry, same day):
"kan du också fixa mikrofon ikonen till att använda något mer stilrent. Gör
det till en vana i helm" (fix the mic icon to something more sleek/
polished, and make this a habit in Helm).

- `src/renderer/renderer.js`: the mic button's two raw-emoji states
  (`micBtn.textContent = "🎤"` idle, `"⏹"` recording) replaced with two small
  inline SVG constants, `MIC_ICON_IDLE` (mic capsule + stand, stroke-based)
  and `MIC_ICON_RECORDING` (filled rounded square), assigned via
  `micBtn.innerHTML` at the three call sites (initial creation, the
  `mediaRecorder` `"stop"` handler reverting to idle, and
  `startVoiceRecording` switching to recording).
- Not a new pattern invented from scratch - matches the one inline-SVG
  precedent already in this file, `wireScrollToBottomButton`'s down-arrow
  (`stroke="currentColor"`, no hardcoded color, sized to fit its button).
  `currentColor` means the glyph automatically respects `.icon-btn`'s
  existing hover/active/`.recording` CSS (the red pulse background swaps
  `color` too, so the stop-square recolors with it for free) instead of
  baking a color into the SVG.
- No icon-library dependency added - this app has none today, and two small
  hand-written glyphs (a handful of path/rect commands each) don't justify
  pulling one in.
- Deliberately scoped to only the composer's mic button. Left
  `.pane-status-icon` and the pane header's status-row/thinking-indicator
  emoji untouched - separate in-flight work by someone else at the time of
  this change.
- **Made it a standing habit, not a one-off**, per the ask: added an "Icons
  over emoji" section to `CLAUDE.md` - prefer small inline SVG glyphs
  (`currentColor`, no library) over raw emoji for interactive controls going
  forward, since emoji render inconsistently across platforms/fonts and read
  as less polished; informal status text/badges (the existing "⚠"/"❓ Needs
  your input" markers) are explicitly still fine as emoji, since building a
  custom glyph for those isn't worth it. Points at this mic button as the
  reference example.

**Verification.** `node --check src/renderer/renderer.js` passed. No
style.css changes were needed - `.icon-btn`/`.icon-btn.recording` already
apply `color`, which both new SVGs inherit via `currentColor`/`fill`, so no
new brace-balance risk. Full boot-test via `scripts/restart-dev.sh` (never a
bare taskkill, per this file's own rule) came up clean with no console
errors. This is a native Electron app with no browser-preview tooling
available in this environment - the actual visual result (icon shape,
crispness, alignment inside the 26px button) still needs Aidin's own look
before calling it done.

## 2026-07-04 — Voice input v1 feedback: hold-to-record (button + Alt), and a multilingual model so Swedish actually works

Follow-up to the 2026-07-03 "Voice input v1" entry, after Aidin live-tested
the shipped mic button and gave two pieces of feedback.

**1. "Jag vill ha en hold to record function. Typ alt knappen eller någon
enkel kombination."** (I want a hold-to-record function, like the Alt key or
some simple combo.) v1 was click-to-start/click-to-stop
(`toggleVoiceRecording`, renderer.js). Replaced entirely with hold-to-record —
not layered alongside the old toggle, per the ask that hold is now THE
interaction model, not a second confusing mode.

- `renderer.js`: `toggleVoiceRecording` split into `startVoiceRecording`/
  `stopVoiceRecording`, called from two independent hold mechanisms that both
  route through the same pair so neither can leave the button in a
  half-held state: (a) `mousedown`/`mouseup` on the mic button itself, with
  `mouseleave` also stopping it — dragging the mouse off the button while
  held must not strand a recording with no way to release it; (b) `keydown`/
  `keyup` on Alt while focus is in that pane's composer textarea, with a
  `blur` listener as the equivalent of `mouseleave` for the keyboard path
  (Alt-tabbing away blurs the textarea without a matching `keyup` ever
  firing).
- New `heldRecordings` Set (index-keyed, alongside the existing
  `activeRecordings` map) tracks which panes are CURRENTLY being held,
  independent of whether a `MediaRecorder` exists yet — `getUserMedia`'s
  permission round-trip is async, so a hold can end before the stream is even
  ready. `startVoiceRecording` re-checks `heldRecordings.has(index)` right
  after that `await` and bails out (stopping the tracks it just opened) if
  the hold was already released, so a fast tap can never open a recording
  nothing will ever stop.
- **Alt was checked for collisions before picking it**, per the ask: grepped
  every `keydown`/`keyup` handler in `renderer.js` (Enter-to-send, Escape for
  the context menu/image lightbox, inline-rename Enter/Escape) — none read
  `e.altKey` or check `e.key === "Alt"`, and `main.js` sets no
  `accelerator`/`globalShortcut` anywhere (confirmed via grep — zero matches).
  The one real interaction: no custom `Menu` is set in this Electron 31 app,
  so the OS-default File/Edit/View/Window/Help application menu bar is
  present, and bare Alt normally shifts keyboard focus to it.
  `e.preventDefault()` in the `keydown` handler suppresses that reliably in
  Chromium/Electron, so Alt is free to reuse for this without stealing focus
  from the composer.

**2. "Språk funkar inte för svenska, kan man fixa hem ett svenska paket?"**
(Language doesn't work for Swedish, can we get a Swedish package?) Root
cause, confirmed rather than assumed: v1 shipped `Xenova/whisper-tiny.en` —
the `.en` suffix is Hugging Face/OpenAI's own naming convention for an
ENGLISH-ONLY fine-tune of Whisper. It was never going to transcribe Swedish
regardless of any option passed to it.

- `src/lib/voice.js`: `MODEL_ID` changed to `Xenova/whisper-tiny` (no `.en` —
  the multilingual checkpoint, same tiny size class, ~150MB). Confirmed
  Swedish is genuinely in this checkpoint's vocabulary, not just "should
  work in theory": inspected the downloaded `generation_config.json`'s
  `lang_to_id` map directly — it contains a `<|sv|>` token.
- **`language` left unset, not hardcoded to `"sv"`.** Read transformers.js's
  own `automatic-speech-recognition` pipeline source
  (`node_modules/@huggingface/transformers/src/pipelines/automatic-speech-
  recognition.js`) rather than assuming: its JSDoc states `language` "Default
  is `null`, meaning it should be auto-detected." Chose to keep that default
  rather than force `"sv"` — Aidin mixes Swedish and English naturally in the
  same utterance (matches his own usage pattern), so a hardcoded language
  would fight that instead of helping it. Auto-detect picks per-utterance
  instead.

**Verified end-to-end, not just a model-name swap.** Checked for a Swedish
SAPI voice on this machine first (per the ask) — `System.Speech.Synthesis`
only has `Microsoft Hazel Desktop` (en-GB), `Microsoft David Desktop`
(en-US), and `Microsoft Zira Desktop` (en-US) installed; no Windows language
pack and no OneCore speech voices exist here either (`Get-WinUserLanguageList`
returned empty). **No genuine Swedish speech sample could be generated or
found on this machine** — this is the one thing that still needs Aidin's own
live test (real mic, real Swedish, ideally some natural Swedish/English
mixing to match his actual usage).

What WAS verified directly against the shipped module: a standalone script
imported `src/lib/voice.js`'s real `transcribeAudio` (not a mock), fed it a
real speech WAV (Windows SAPI TTS, same technique the original English spike
used), and confirmed (a) the new multilingual model downloads and caches
correctly (`node_modules/@huggingface/transformers/.cache/Xenova/whisper-tiny/`,
alongside the old now-unused `whisper-tiny.en` cache, both gitignored), (b)
transcription still works correctly end-to-end against English speech — a
real regression check, not an assumption that multilingual models stay
English-compatible — producing "Hello, Vice-Draud. Please switch to hold to
record as supports Swedish." against the spoken "Hello Helm, please switch
to hold to record and support Swedish." (a couple of words mangled, expected
given robotic SAPI TTS input — the original English-only spike had similar
roughness), and (c) the console log line `"No language specified - defaulting
to English (en)."` confirms auto-detect is genuinely active end-to-end, not
silently ignored — it inspected the actual audio and correctly identified
English, which is exactly the mechanism that will identify Swedish when the
real input is Swedish.

**Verification commands run:** `node --check` on both edited files
(`src/lib/voice.js`, `src/renderer/renderer.js`); the standalone
`transcribeAudio` exercise above against a real SAPI-generated WAV; a full
boot-test via `scripts/restart-dev.sh` (clean boot, no errors) with
`Get-CimInstance` confirming only Helm's own 4 processes were running
afterward (no stray prior instances, no Reinmaker collision). **What this
could NOT verify** (no live microphone on this machine, same limitation as
every prior voice-input entry): the hold-to-record interaction actually
feeling right with a real hand on a real mouse/keyboard, Alt not misbehaving
against any OS-level or driver-level global hotkey Aidin might have configured
outside this app, and — the actual point of this whole fix — real Swedish
transcription quality against Aidin's own voice, accent, and mixed Swedish/
English speech. All three need Aidin's own live test.

## 2026-07-04 — CLAUDE.md quick-links: open the real canonical file (not the stub), and open its FOLDER (not the bare file)

Follow-up to the 2026-07-03 "CLAUDE.md quick-links" entry, after Aidin
live-tested the shipped links and gave two pieces of feedback.

**1. "den globala länken går till den tomma filen istället för den som finns
i dropbox"** (the global link opens the empty file instead of the one that
exists in Dropbox). The previous `claudeMd:openGlobal` deliberately opened
`~/.claude/CLAUDE.md` - the thin stub, not the canonical Dropbox file it
`@imports` - on the reasoning that Claude Code itself resolves the import
automatically and the stub is the one path every machine actually has. That
reasoning was sound for how Claude Code consumes the file, but wrong for
what a human clicking a link in the app wants to see: the stub is a few lines
pointing elsewhere, not the actual rules. Aidin has now said directly he
wants the real file. Fixed by having `main.js` read the stub's own content,
regex-match its `^@(.+\.md)$` import line, and resolve that path
(`D:/Dropbox/Mina Dokument/Claude/CLAUDE.md` on this machine) instead of the
stub. New `resolveCanonicalGlobalClaudeMd()` helper isolates that parse step
so it can be exercised independently of Electron.

**2. "det är nog dessutom bättre om länken går till foldern med de samlade
filerna, t.ex om jag vill se decisions eller plan"** (better if the link
goes to the FOLDER with the collected files, e.g. to see DECISIONS or PLAN).
Both `claudeMd:openGlobal` and `claudeMd:openProject` now call
`shell.showItemInFolder(file)` instead of `shell.openPath(file)` - Explorer
opens on the containing folder with CLAUDE.md pre-selected, so
DECISIONS.md/PLAN.md/OPINIONS.md/VOICE.md/skills/ sitting right next to it
are immediately visible, without an extra "go up one level" step.
`showItemInFolder` chosen over `openPath` on the folder itself specifically
for that highlighted-selection behavior - a bare folder-open would land in
the same place but without drawing the eye to CLAUDE.md first. The global
link now resolves to the canonical Dropbox Claude folder (via the same
`@import`-parsing helper above); the project link resolves to `cwd` itself,
the project's own root folder - both changes are one-line swaps in
`main.js`'s two IPC handlers since `showItemInFolder` still takes a file
path and derives the folder itself. The existing "only show the project link
if a project CLAUDE.md exists" gate (`claudeMd:projectExists`) is unchanged.

**Verification:** a standalone script
(outside the app, no Electron/shell dependency) that calls the same
stub-parsing and existence-check logic the real handlers now use, asserting:
the resolved global file is the Dropbox canonical path (not the stub) and
its folder contains OPINIONS.md/VOICE.md/skills/; the resolved project
folder equals `cwd` and contains this repo's own
CLAUDE.md/DECISIONS.md/PLAN.md; both the "no CLAUDE.md at this cwd" and
"no cwd" cases still correctly report not-ok. All checks passed before
wiring the logic into `main.js`. Also ran `node --check` on both edited
files and a full boot-test via `scripts/restart-dev.sh` (clean boot, no
errors, Reinmaker's PIDs untouched). Actually clicking the links and
confirming Explorer opens on the right folder with the right file selected
still needs Aidin's own live test - no way to observe a real Explorer window
from here.

## 2026-07-04 — Classifier sweep was leaking a permanent transcript per check; encodeProjectDir was silently wrong for any path with a space

**Bug (Aidin's report, "sessions rooted themselves in Mina Dokument\Claude
again"):** Investigated instead of assuming a switch-root-folder regression.
Real cause: the orchestrator classifier (`orchestratorHelper.js`,
`config.orchestratorHelper.enabled: true`, sweeping every ~15 min) spawns a
real `claude -p` call per session it checks, correctly rooted in that
session's own folder - but that call creates a full, permanent session
transcript on disk with nothing ever cleaning it up. Confirmed live: 320 of
442 `.jsonl` files under the Dropbox Claude project directory were the
classifier's own throwaway artifacts (content-matched via its exact prompt
template, `"Session: X\nLinked task: ..."`) - not real conversations. Since
many of Aidin's genuinely personal (non-project) sessions are rooted in that
same general folder, the classifier's leak concentrated there, reading as
"my sessions keep re-rooting" when it was actually junk accumulating
alongside them. Disabled `orchestratorHelper.enabled` immediately as a
stop-gap (a config flip, non-destructive) while fixing the root cause.

**Fix attempt #1 surfaced a second, deeper, pre-existing bug.** Added
`deleteOwnTranscript(cwd, sessionId)` to `classifySessionStatus`'s `close`
handler - delete the just-created transcript immediately after reading its
`structured_output`, since nothing else ever reads it again. First
verification (a real end-to-end call against this repo's own project
folder, not a mock) still leaked a file. Traced with temporary debug tracing
(removed before committing): `encodeProjectDir` (`paths.js`, built earlier
2026-07-03 for the original `switchSessionRootFolder` fix) only replaces `:`
and `\` with `-` - it silently preserves spaces and any other special
character. The real Claude Code convention (confirmed by inspecting every
directory under `~/.claude/projects` - none contain anything outside
`[a-zA-Z0-9-]`) replaces EVERY non-alphanumeric character 1:1 with a hyphen,
e.g. `D:\Dropbox\Mina Dokument\Claude` -> `D--Dropbox-Mina-Dokument-Claude`.
The old regex produced a wrong, non-existent directory name for exactly this
folder (a space in "Mina Dokument"), so the delete silently no-opped -
`fs.existsSync` on the wrong path just returns false, no error, no signal
anything was wrong.

**Fix:** `encodeProjectDir` now does `cwd.replace(/[^a-zA-Z0-9]/g, "-")`.
Verified no regression for ordinary paths (only `:`/`\` present) - old and
new regexes produce byte-identical output when there's nothing else to
replace. The ONLY other caller besides the new cleanup is
`switchSessionRootFolder` (`sessions.js`) - meaning tonight's earlier
root-folder-switch fix has ALSO been silently computing the wrong copy-
destination directory for any target path containing a space this whole
time, a real latent bug now fixed as a side effect, not just today's leak.

**Re-verified end-to-end after the fix** (real `classifySessionStatus` call
against this repo's own large real transcript, twice): both runs returned a
genuine classification AND left zero files behind, real transcript
untouched both times. `orchestratorHelper.enabled` left OFF in config.json
pending Aidin's own decision on whether to re-enable now that the leak is
fixed - this fix stops new leaks, it doesn't retroactively clean up the 320
already-accumulated junk files, which need his explicit go-ahead before any
deletion (a call I won't make unilaterally).

## 2026-07-03 — Fas 3 Point 8 v1: a Jot-backed "Focus" page (ranked goals + goal breakdown with safe subtask write)

**Built** the first slice of PLAN.md's Phase 3 "Point 8 — split work +
prioritize focus," scoped deliberately to exactly two capabilities and no
more: (1) a read-only Focus page that ranks the user's active GOALS, and (2)
a goal-breakdown view that can add subtasks back into Jot. NOT built (out of
scope by the task's own framing): goal-to-session dispatch, auto-scheduling,
drag-reprioritization — those are later.

**Backed by Jot, not a second task system.** Per PLAN.md's own framing and
the ephemeral-sessions reorientation (the unit worth organizing is
work/goals, which already live in Jot), this reads the SAME
`D:\Dropbox\jot\todos.json` the sidebar's category matching already reads.
Reused the existing `src/lib/jot.js` read layer rather than writing a second
parser — extended it, didn't fork it.

**Bug found and fixed while reusing the read layer: Helm's Jot integration
was silently disabled.** The real todos.json carries a UTF-8 BOM (EF BB BF —
left by an editor or a legacy external write; Jot's own app writes without
one). `loadJot`'s `JSON.parse(fs.readFileSync(...,"utf8"))` throws on a
leading BOM, so it was falling through its own `catch` into `emptyIndex` on
every call — meaning category counts, deadline sorting, and the whole
attention-scoring Jot contribution had been quietly reading zero. Fixed with
a shared `readJotFile(jotPath)` helper (strips a leading `﻿`, then
parses) that both the existing `loadJot` and the new goal functions go
through. Verified: `loadJot({}).ok` now returns 11 categories against the
real file where it previously returned the empty index.

**Capability 1 — `loadGoals(jotConfig)` (read-only ranking), jot.js:**
returns top-level todos (`parentId === null`) whose status is `open` or
`in-progress` (the goals actually worth choosing between now), each carrying
its category, priority, deadline, subtask progress (done/total), review-count,
and its own subtasks (so the breakdown needs no second read). Ranks them by an
attention score built from the SAME signals sessions.js scores sessions with:
deadline proximity via a `goalDeadlineBoost` that is byte-for-byte the same
tiering as sessions.js's `deadlineBoost` (replicated, not imported, to keep
this addition isolated to jot.js and off sessions.js's export surface that
other in-flight work also edits — noted inline that they agree on purpose and
may diverge later), in-progress status, Jot priority (lower number = more
urgent, mapped through a bounded `priorityBoost` so an extreme value can't
dominate), and small boosts for being an epic and for having review-status
subtasks. Verified against the real file: 31 active goals, top-ranked ones
are the in-progress p0 goals, as expected.

**Capability 2 ended up READ-WRITE (not read-only) — `addSubtask(jotConfig,
parentId, text)`, jot.js.** Confidence to write came from reading jot's own
`INTEGRATION.md` (the authoritative external-agent contract) and its
`storage.ts`: Jot's own writer is `JSON.stringify(state, null, 2)` as UTF-8
**without a BOM**, and the contract prescribes exactly the safe-write flow
this codebase already uses elsewhere (read latest → modify in memory → temp
file → atomic rename). So `addSubtask` re-reads the FRESHEST file immediately
before writing (never trusts an earlier in-memory snapshot — the Jot app
live-reloads and may have flushed its own edit since), appends ONE todo (a
minimal targeted change, never a blind whole-file overwrite of remembered
state), and writes via temp-file + `fs.renameSync` (atomic on-volume) so an
interrupted write can't leave todos.json torn — the same discipline as
sessions.js's `patchSessionMeta`. Output is UTF-8 no-BOM, 2-space JSON: the
file Helm leaves behind is byte-shape-identical to one Jot's own app
wrote. The new subtask inherits the parent's `categoryId` (verified data-model
behavior), gets `status:"open"`, `priority:0`, a fresh UUID. Guards refuse:
empty text, a missing parent, or a parent that is itself a subtask (Jot nests
exactly one level — no grandchildren).

**Verified the write against a COPY, never the real board.** A standalone
script copied the real todos.json (with its BOM) into the scratchpad and
exercised `addSubtask` against that copy only: append lands under the right
parent, category inherited, text trimmed, output has no BOM and re-parses
cleanly, all three guards fire, no stray `.tmp` left behind, and the real
`D:\Dropbox\jot\todos.json` was confirmed untouched throughout. The atomic
temp-file+rename behavior was exercised as part of that (the written file is
always fully valid JSON).

**Surface: a new "Focus" page** (`renderFocusPage` in renderer.js), added as
its own page in the established `#pageToggle` pattern (a `focus` button + a
`#focusPage` div toggled with `.hidden`, exactly like Analysis/Archive/
Settings) — deliberately NOT threaded into the crowded session-list/pane
rendering paths where it could collide with other recent renderer work. The
page lists ranked goals as cards (top 3 get an accent left-edge as the
"work on this now" recommendation, the rest under an "Also active" divider),
each expandable to show its description, subtasks with status, and an
add-subtask input. Adding re-renders from the freshly-read file (never an
optimistic guess), so the UI always reflects real Jot state. All styling is
self-contained under `.focus-*` classes reusing the existing CSS variables and
the analysis-page visual language (no dependency on button/input classes that
don't exist in this repo).

**Wiring:** `main.js` — two IPC handlers (`jot:goals` read-only, and
`jot:addSubtask` for the write, both loading `config.jot`); `preload.cjs` —
`getJotGoals`/`addJotSubtask` on the `window.helm` surface, one line each,
same pattern as every other channel.

**Verification:** `node --check` on all four changed JS files
(`jot.js`/`main.js`/`renderer.js`/`preload.cjs`); a CSS brace-balance check
(286/286); direct exercises of `loadGoals` against the real file (read-only)
and `addSubtask` against a scratch copy (see above); and a full boot-test via
`scripts/restart-dev.sh` (clean boot, no app-level errors — the GPU disk-cache
warnings in the log are benign Electron cache noise, not app errors; confirmed
via `Get-CimInstance` that only Helm's own 4 PIDs recycled and Reinmaker's
4 PIDs — 20556/4560/25124/6292 — were untouched, consistent with the
documented safe-restart behavior). **What this could NOT verify** (native
Electron app, no browser-servable preview — same limitation noted on every
other UI change in this file): the Focus page actually rendering, the goal
cards/chips/breakdown looking right, and the add-subtask flow end-to-end
through the real IPC in the running app. That needs Aidin's own visual test.

## 2026-07-03 — Orchestrator lifespan: no privileged "the orchestrator" session; land on a dashboard, start fresh orchestrator sessions

**Decision:** Aidin flagged that two original UI choices — app opens directly
onto "the orchestrator," and any session can be assigned as "the
orchestrator" — were made before the ephemeral-sessions philosophy and now
contradict it. Both treat the orchestrator as one durable, history-
accumulating session-identity, which is the same megasession anti-pattern the
strategic reorientation rejects, and also contradicts the already-made
decision that the classifier is stateless (2026-07-02). Confirmed the
redesign (full detail in PLAN.md's new "Orchestrator-lifespan redesign"
subsection under Phase 3): (1) remove session-assignment — no privileged
session IS the orchestrator; the sensor/sweep/dispatch runs headless in the
main process; (2) app lands on the overview/dashboard (Phase 1's original
vision), not a chat; (3) "open the orchestrator" becomes "start a NEW
orchestrator session" — fresh each time, pre-loaded with orchestrator-
instructions.md + a current-state brief (Jot, PLAN.md), never resumed
history, reusing Phase 2's planned handoff mechanism. This session itself is
the illustrating example: it worked as an orchestrator and became exactly the
long everything-session we're moving away from.

Not ripped out today (current default still works); it's the confirmed
direction for new orchestrator UI work. Aidin explicitly delegated steering
Helm's direction along this philosophy to me from here, being newer to it
himself — so this and future direction calls are made on that standing
authority, still surfaced here for his review, not presumed silently.

## 2026-07-03 — Voice input v1: local offline Whisper (transformers.js), not OS speech API or whisper.cpp bindings

**Context:** PLAN.md's Phase 4 candidate pool flags voice input as "the best
first experiment" — Kun Chen uses OpenSuperWhisper as his PRIMARY prompt-
composition method instead of typing. Aidin asked for a spike first, then a
minimal build, not upfront design certainty ("build a first prototype, then
we review it together").

**Spike — three options checked in the requested preference order:**
1. **Windows' own OS-level speech recognition** (Windows Speech Recognition /
   `Windows.Media.SpeechRecognition`) — not pursued past a quick check: there
   is no simple Node/Electron binding for this WinRT API; reaching it would
   mean either a native addon or a PowerShell/COM bridge, both meaningfully
   more fragile and heavier than option 2 below for the same outcome.
2. **A local whisper.cpp binary or an npm wrapper** — checked both
   `nodejs-whisper` and `whisper-node`. Both compile whisper.cpp from source
   at install/first-run time; their own Windows install docs require
   MinGW-w64/MSYS2 (`make`/`cmake`) on PATH. Verified directly on this
   machine: no `cmake` or `make` on PATH, only a bare `gcc.exe` from an
   existing msys64 install (not the full toolchain either package's docs
   ask for) — exactly the "exotic manual install" case Aidin asked me to
   flag rather than force through.
   - Found a third path in the same family that DOES clear the bar:
     **`@huggingface/transformers`** (transformers.js, the actively-maintained
     successor to `@xenova/transformers`) runs Whisper via prebuilt
     `onnxruntime-node`/`sharp` binaries — no C++ compile step at all.
     `npm install` completed cleanly in ~8s with zero build tooling. This is
     the option actually used (see below) — closer to option 2's spirit (a
     real local Whisper model) than option 3, without its blocker.
3. **OpenSuperWhisper itself** — Aidin's actual daily tool. It is macOS-only
   (a native macOS app); not installable or scriptable on this Windows
   machine. Stated plainly rather than attempting to force it — matches the
   ask.

**Chosen: `@huggingface/transformers` running `Xenova/whisper-tiny.en`,
inference in Helm's own Electron MAIN process (Node), not the renderer.**
Verified live end-to-end via a real spoken WAV (Windows SAPI
`System.Speech.Synthesis` TTS used to generate a genuine speech waveform for
the spike, since no live mic input is available to me): first call
auto-downloaded the model (~151MB fp32 ONNX, two files — encoder + merged
decoder — into `node_modules/@huggingface/transformers/.cache`, a one-time
background download, not a blocking manual step) and transcribed correctly
("Hello Helm. Please open the project folder and start a new session.")
in ~13s total (mostly the download); a second run with the model already
cached loaded in ~1.4s and transcribed a short clip in ~1-2s. Picked
`whisper-tiny.en` (smallest usable size, English-only) to match the
deliberately minimal v1 scope — no language picker yet (see below).

**Why main-process inference, not renderer:** keeps the renderer's strict CSP
(`default-src 'self'`) completely irrelevant to the model/runtime — no WASM/
worker CSP exceptions needed — and matches this repo's existing division of
labor (all CLI/file-system/model work lives in `src/lib/*`, IPC-bridged to
the renderer via `preload.cjs`, same shape as `judge.js`/`suggest.js`).

**Built (minimal "record → transcribe → insert" loop only, per the ask —
no language selection, no continuous dictation):**
- `src/lib/voice.js` (new) — `transcribeAudio(float32Samples)`, lazily creates
  and caches one `pipeline("automatic-speech-recognition", "Xenova/whisper-
  tiny.en")` for the process lifetime (re-creating it per call would reload
  the model from disk every time). A failed first load clears the cached
  promise so a transient network error on the first-ever download doesn't
  permanently wedge the feature.
- `src/main.js` — a `mainWindow.webContents.session.setPermissionRequestHandler`
  added in `createWindow()` (none existed before), scoped to only grant the
  `"media"` permission (needed for the renderer's `getUserMedia`) and deny
  everything else; Electron denies all media requests by default without an
  explicit handler. New `voice:transcribe` IPC handler rebuilds a
  `Float32Array` from the plain array the renderer sends (contextBridge's IPC
  boundary carries a plain array more reliably across Electron versions than
  a typed array) and calls `transcribeAudio`.
- `src/preload.cjs` — `transcribeVoice(samples)` added to the exposed
  `window.helm` surface, same one-line-per-channel pattern as every other
  entry.
- `src/renderer/renderer.js` — a microphone icon-button (`.icon-btn`, same
  class/size as the existing pick-folder/attach buttons) added to
  `composer-controls`, immediately before the send button. Click starts
  `getUserMedia({audio: true})` + `MediaRecorder`; click again (now showing a
  stop icon) stops it. On stop: decodes the recorded Blob via
  `AudioContext.decodeAudioData` then `OfflineAudioContext` (1 channel,
  16kHz) to get the exact mono/16kHz `Float32Array` Whisper's feature
  extractor expects — resampling falls out of the same decode step for free,
  no separate resampling library needed — sends it to
  `window.helm.transcribeVoice`, and **appends** the returned text into
  the composer's textarea (a trailing space/newline is added first only if
  the existing text doesn't already end in one). Chose append over replace:
  voice is meant as an alternative way to ADD to what you're composing, not a
  silent overwrite of anything already typed. Recording state and the
  in-flight `MediaRecorder`/stream are keyed by pane INDEX in a module-level
  `activeRecordings` Map — same reasoning as the existing `liveStatsTickers`
  map (a pane can be reset/replaced mid-recording; looking `panes[index]` up
  fresh means a stale recording has nowhere valid to land).
- `src/renderer/style.css` — `.icon-btn.recording` (red, same hex family as
  `.send-btn.stopping`, for a consistent "something live/attention-needing"
  cue) reuses the existing `pane-status-pulse` keyframe so it visibly pulses
  while recording, no new animation needed.
- `package.json` — added the one new runtime dependency,
  `@huggingface/transformers` (`npm install`, no other package changes).

**Verification:** `node --check` on all four edited/new JS files, a CSS
brace-balance check, and a full boot-test via `scripts/restart-dev.sh` twice
(clean both times; confirmed via `Get-CimInstance` that only Helm's own 4
PIDs recycled and Reinmaker's 4 PIDs were untouched throughout). Separately
verified the actual shipped `src/lib/voice.js` module end-to-end against a
real speech WAV via a standalone script importing it directly — confirmed
correct transcription text, and confirmed the model cache lands in this
repo's own `node_modules` (gitignored, so it never gets committed). **What
this could NOT verify** (no live mic access, no browser-servable preview for
a native Electron app — same limitation noted on every other UI change in
this file): whether `getUserMedia` actually prompts for and receives real
microphone permission end-to-end in the packaged app, whether the microphone
button renders correctly alongside the other composer controls, and — most
importantly — real transcription QUALITY against Aidin's own voice, accent,
and speaking environment (background noise, distance from mic, etc.). All of
that needs Aidin's own live test. Deferred by design, per the ask to keep v1
to exactly "record, transcribe, insert": language selection, continuous/
live dictation, a visible recording-duration indicator, and error-surfacing
richer than a button tooltip.

## 2026-07-03 — Model/effort suggestion-accuracy check made proactive, folded into the existing sweep

**Context:** PLAN.md's Fas 3 write-up already named this as one of "two more
periodic checks folded in here rather than getting their own mechanism"
(2026-07-02 decision, "infogas i Fas 3:s orkestrator-helper istället för en
egen separat loop") — the other being auto-compact, already shipped. Until
now the model/effort suggestion-accuracy review only existed as an on-demand
"Suggestion accuracy" report on the Analysis page (renderer.js's
`renderAnalysisPage`, backed by `usage.js`'s `readUsageSummary`), which Aidin
has to remember to open. This closes that gap: the same periodic
`runOrchestratorSweep` that already runs the session-status classifier and
auto-compact now also periodically re-checks suggestion accuracy and
surfaces a finding when it looks meaningfully off — sensing + surfacing
only, per the task's own scope; changing the suggestion heuristic itself
(`suggest.js`) stays a separate, bigger follow-up.

**Built:**
- `usage.js`'s `computeSuggestionAccuracyVerdict(summary)` — extracted the
  EXACT followed-vs-overridden "appropriate" rate comparison the Analysis
  page already computed inline, so the proactive sweep and the on-demand
  report are provably the same metric, not two that could drift apart. Takes
  `readUsageSummary()`'s output, returns `null` when there isn't at least one
  judged run on each side (mirrors the report's own empty state), otherwise
  `{ followedTotal, overriddenTotal, followedRate, overriddenRate,
  diffPoints, message }`. Verified against hand-computed cases (a "heuristic
  looks bad" case and a "heuristic looks fine" case) — output matches the
  report's own arithmetic exactly.
- `main.js`'s `runSuggestionAccuracyCheck(config)` — called from the end of
  `runOrchestratorSweepBody` behind a new `config.suggestionAccuracyCheck.
  enabled` toggle (off by default, same opt-in posture as the classifier and
  auto-compact). No model call and no extra file I/O beyond what the
  on-demand report already does (`readUsageSummary` parses the local
  `usage-log.jsonl`), so cost isn't the reason it's gated — re-nagging Aidin
  about the same stale finding is. Gated on **data volume, not wall-clock
  time**: `config.suggestionAccuracyCheck.lastCheckedFollowedTotal/
  lastCheckedOverriddenTotal` remember the totals as of the last check, and
  the sweep only re-evaluates once at least `SUGGESTION_ACCURACY_CHECK_
  EVERY_N_RUNS` (10) new judged+suggested runs have accumulated since. A
  fixed calendar interval (e.g. weekly) was considered and rejected — Aidin's
  usage is bursty, so a wall-clock trigger would either fire on completely
  unchanged data during a quiet week or stay silent through a heavy one; a
  count of new data points ties the check to when the verdict could actually
  have moved.
- The finding surfaces as `config.suggestionAccuracyNotice = { message,
  diffPoints, totalAtCheck, dismissed }`, written only when `diffPoints < 0`
  (overriding the suggestion did better than following it — the "suggested
  Sonnet but Opus was judged appropriate more often" signal). A
  positive/neutral diff clears any existing notice instead of leaving a
  stale one around once new data shows the heuristic is fine again.
  Dismissing (Analysis page) sets `dismissed: true`; the SAME staleness
  pattern as `acknowledgedSessions` (keyed on a value that changes with real
  new activity, here `totalAtCheck` instead of `lastActivityAt`) means a
  dismissal only sticks until the next check finds enough new data to
  produce a genuinely different reading, not forever.
- Surfaced on the **Analysis page** (not a per-session row) since this is a
  whole-heuristic finding, not about any one session — placed directly above
  the existing "Suggestion accuracy" block it's derived from, using the same
  dashed-border "propose, you decide" visual language as the archive-suggest
  pill (`.analysis-notice`/`.analysis-notice-dismiss` in style.css). A new
  settings toggle ("Proactively check suggestion accuracy (Fas 3)") sits
  alongside the existing orchestrator-helper/auto-compact toggles rather than
  a new settings section, matching the task's own instruction to keep this
  small.
- `config.js`: new `suggestionAccuracyCheck` (deep-merged like the other
  nested toggles, so a partial `config.json` never silently drops
  `lastCheckedFollowedTotal`/`lastCheckedOverriddenTotal`) and
  `suggestionAccuracyNotice` defaults.

**Verified:** `node --check` on all four changed JS files
(`config.js`/`usage.js`/`main.js`/`renderer.js`); a standalone ESM
exercise of `computeSuggestionAccuracyVerdict` against synthetic
"heuristic looks bad"/"heuristic looks fine"/empty-data cases; a
standalone exercise of the check's gating logic across four sequential
calls (fires and sets a notice on enough new bad-heuristic data, skips on 0
new runs, skips below the 10-run threshold, then fires again and CLEARS the
notice once enough new data flips the verdict positive); a run of the real
`computeSuggestionAccuracyVerdict` against this repo's actual
`usage-log.jsonl` (correctly returns `null` today — no overridden+judged
runs logged yet); and a full boot-test via `scripts/restart-dev.sh` (clean
boot, no errors, twice — once before and once after an unrelated concurrent
edit to `main.js` from other in-progress work).

## 2026-07-03 — Live time/tokens ticker, "needs your input" flag, CLAUDE.md quick-links

Three independently-scoped UI fixes bundled into one pass (all touch
renderer.js/style.css) rather than three parallel agents, to avoid concurrent
edits to the same files.

**1. The time/tokens readout is now LIVE, not static.** Aidin's feedback on
the just-shipped version: "den här är inte rolig eller särskilt animerande,
och den räknar inte upp varken tokens eller tid" — it only ever showed a
number after the fact, from the final `result` event.

- `launcher.js` now also reads `evt.message.usage` off every `"assistant"`
  stream-json event (not just the final `result` event) and emits a new
  `{kind: "usage", totalTokens}` event per the CLI's own per-message usage
  snapshot. Verified via the claude-api skill that each assistant message's
  `usage` is that message's own token count, not a cumulative running total —
  so summing across every assistant event in a turn (each is one real API
  call in the underlying agentic loop) gives the correct turn total with no
  double-counting.
- Renderer: `pane.runStartedAt`/`pane.liveTokens` (new `freshPane()` fields),
  a `startLiveStatsTicker`/`stopLiveStatsTicker` pair (module-level map keyed
  by pane INDEX, same pattern as `paneNavHistory` — looks up `panes[index]`
  fresh every 250ms tick so it naturally goes inert once that slot no longer
  holds the run it was started for), and `renderLiveStats` which appends a
  ticking "Ns · Nk tokens" span to `.pane-status`. Started at the true send
  moment in `sendFromPane` (not inside `setPaneBusyUI`, which also fires on
  every intermediate tool_use — that would reset the clock each time) and
  stopped at every point a run ends (`done`, `error`, stop-button, switch-
  folder failure, start failure) and at every point a pane gets replaced
  wholesale (new chat, split close, rewind, session navigation) so no ticker
  is ever left running against a discarded pane.
- The existing final-summary logic (`pane.lastTurnStats` /
  `wireTurnStatsOnLastReply`) is untouched — the live ticker hands off to it
  the moment `pane.busy` goes false, matching the ask ("don't remove the
  current final-summary logic, make it update live before that point").
- "Thinking" dot now visibly reacts to each new event: `pulsePaneStatusIcon`
  toggles a `.pane-status-icon-ping` class (a one-shot brighter/bigger CSS
  animation, self-clearing since it's driven by the animation itself, not a
  toggled state) on `tool_use`, `usage`, and `assistant` events, layered on
  top of the existing ambient pulse rather than replacing it — simplest
  change that reads as "more animated" per the ask not to over-engineer this
  part.

**2. Flag a completed reply that's actually asking the user something.**
Context: a 2026-07-03 spike (see the persistent-process entry below)
already conclusively established headless `-p` has no live pause-and-ask
mechanism — a real Claude-Desktop-style blocking dialog is architecturally
impossible here, not something to attempt. This is the agreed approximation
instead: a purely visual "don't miss this" flag, not a new input mechanism —
the user still answers via the normal composer.

- `looksLikeQuestion(text)` — cheap, synchronous, deliberately not an LLM
  call: true if the last non-empty line ends in `?`, OR the last couple of
  lines match a small set of common ask-for-input phrasings that don't
  necessarily end in `?` (e.g. "Let me know how you'd like to proceed.").
  Verified against 7 hand-picked cases including two deliberate near-misses
  (a rhetorical question followed by a statement, a code snippet containing
  `?.`) — 7/7 correct.
- `wireQuestionFlagOnLastReply` applies it to the LAST assistant bubble
  whenever the pane is not busy (mirrors the non-destructive/idempotent
  pattern the other `wireX` helpers on `renderPane` already use, for the same
  queued-prompt intermediate-render reason documented on
  `wireTurnStatsOnLastReply`). When true: a `.needs-input` class tints the
  bubble's existing border with `--waiting` (the same amber already meaning
  "needs you" elsewhere in the app, e.g. the sidebar status) and a "❓ Needs
  your input" badge is prepended inside the bubble.

**3. Clickable links to open Aidin's global and the current project's
CLAUDE.md.** Re-does a prior pass that had misread this as a documentation-
only fix — the actual want was in-app navigation.

- `main.js`: three new IPC handlers — `claudeMd:openGlobal` (opens
  `~/.claude/CLAUDE.md`, the thin stub, not the canonical Dropbox file it
  `@imports` — Claude Code resolves the import automatically regardless of
  which one is opened, and the stub is the one path every machine actually
  has, so it's the more reliable fixed target; Aidin can follow the `@import`
  line himself for the canonical file), `claudeMd:openProject` (opens
  `<cwd>/CLAUDE.md`), and `claudeMd:projectExists` (existence check so the
  renderer can skip the affordance entirely rather than show a link that
  errors on click). All via `shell.openPath`, same mechanism `skills:open`
  already uses.
- Renderer: `updateClaudeMdLinks(header, cwd)` renders two small icon-buttons
  (🌐 global, 📄 project — reusing the `.icon-btn` class the header's
  existing ←/→/+/✕ buttons use, sized down via a new `.claude-md-links` rule
  since the header's full 26px icon size would dwarf the 11px `.pane-sub`
  text it sits beside) next to the pane header's folder-path text. Called
  from both `paneHeaderEl`'s initial build and `updatePaneSubText` (the
  existing live-update path for cwd changes — folder pick, typing, a root-
  folder switch) so the project link never points at a stale folder. The
  project button is only appended after `projectClaudeMdExists(cwd)`
  resolves true, per the ask to hide rather than error on a missing file.

**Verification:** `node --check` on all four edited JS files, a CSS brace-
balance check, and a full boot-test via `scripts/restart-dev.sh` (clean log,
Reinmaker's pre-existing PIDs confirmed untouched). No live click-through was
possible beyond that — native Electron app, no browser-servable dev server —
so all three items still need Aidin's own visual/interactive confirmation:
the live ticker actually counting up during a real run, the question-flag
badge/border rendering as expected on a real question reply, and both
CLAUDE.md links actually opening the right file in his default editor.

## 2026-07-03 — Worktree automation v1 built (`src/lib/worktree.js`) — the Phase 4 prerequisite

**Built:** a first version of the worktree-automation module PLAN.md's Phase
4 section flags as the prerequisite for everything else in that roadmap
(parallel dispatch, gnhf-style orchestration, no-mistakes-style pipelines) —
nothing else there can safely run multiple agents against one repo without
it. New module `src/lib/worktree.js`, exporting `createWorktree`,
`removeWorktree`, `listWorktreePaths`, `worktreeExists`,
`hasUncommittedChanges`, `worktreesRootFor`, `worktreePathFor`. Backend/
library only — not wired into `main.js`'s IPC handlers or `renderer.js` yet;
nothing consumes it today, on purpose, to stay clear of other in-flight
renderer/main changes.

**Shape, inspired by (not copying) treehouse/gnhf's actual source** (both
studied 2026-07-03, see the entries below): every function takes an
EXPLICIT `projectPath` argument and never touches this process's own cwd —
the exact design question resolved in the "worktree-rooting" entry below.
All git calls go through a local `runGit(projectPath, args)` helper that
always shells out as `git -C <projectPath> ...`, using the codebase's
existing `execFileSync("git", [...])` pattern from `version.js` rather than
inventing a new way to shell out. Worktree location mirrors gnhf's own
sibling-directory convention: `worktreesRootFor(projectPath)` resolves
`<repo>-worktrees/` next to the repo itself (e.g.
`D:\Repo\Tools\helm-worktrees\<id>`), not nested inside the repo, so
worktrees never show up as clutter in the very repo they're isolating work
from. `createWorktree` runs `git worktree add <worktreePath> -b
<branchName>` and returns `{ worktreePath, branchName, envFilesCopied }`.

**Improved on gnhf's documented gap, kept simple:** gnhf's own `git.ts`
(confirmed via source read) leaves a fresh worktree with only tracked files
— no `node_modules`, no `.env` — and relies on the first agent iteration to
notice and fix it. `createWorktree` closes the cheap half of that gap:
after `git worktree add`, it copies any top-level `.env`/`.env.local` from
the source repo into the new worktree (`copyEnvFiles`, top-level only, not
recursive) so a fresh worktree isn't immediately broken for projects that
need an env file just to boot. Deliberately did NOT attempt dependency
install (`npm install` or otherwise) in this pass — genuinely more complex
(registry access, install timing, per-project package-manager choice) and
out of scope for v1; noted both here and inline in `createWorktree`'s doc
comment as a clear follow-up once something actually dispatches work into
these worktrees.

**Fail-closed removal, matching firstmate/gnhf's own teardown principle:**
`removeWorktree` refuses to remove a worktree with uncommitted changes
(`hasUncommittedChanges`, via `git status --porcelain`) unless the caller
explicitly passes `{ force: true }`. Also refuses to remove a path that
isn't a currently-registered worktree at all (checked via
`worktreeExists`/`listWorktreePaths`, both backed by `git worktree list
--porcelain`) rather than silently no-op'ing — every failure mode throws
instead of swallowing, so a caller always knows whether removal actually
happened.

**Verified with a real spike, not just "no error thrown":**
`spike/test-worktree-lifecycle.mjs` creates a throwaway git repo under the
OS temp dir (never Helm's own working tree), then exercises the full
lifecycle against it: create -> confirm the worktree directory exists on
disk, the tracked file is present, `.env` was copied byte-for-byte, and
`git worktree list --porcelain` independently agrees a new worktree exists
on the right branch; list -> confirms both the new worktree and the
project's own primary working tree are reported; a dirty-worktree removal
attempt -> confirms it's correctly blocked and the directory survives;
forced removal -> confirms the directory is actually gone from disk AND
git no longer lists it; a second removal attempt on the now-gone worktree
-> confirms a clear error rather than a silent no-op. All 20 assertions
passed on a real run; the scratch repo and its worktrees directory are
deleted at the end (via a `finally` block, so cleanup runs even on
failure), and `git status`/`git branch --show-current` on Helm's own
repo were checked before and after — completely unaffected throughout.

**Verification commands run:** `node --check` on both new files;
`node spike/test-worktree-lifecycle.mjs` (full pass, real filesystem/git
state inspected at each step, not just exit code).

## 2026-07-03 — Orchestrator instructions extracted into their own file (the third CLAUDE.md-shaped layer)

**Context:** Aidin asked a good architecture question while looking at
`orchestratorHelper.js`'s inline classifier prompt: as the orchestrator's job
grows beyond classifying (into dispatch, escalation, etc. — see PLAN.md's
Phase 3 write-up), where should its own "how should the orchestrator itself
behave" instructions live? Agreed it's a THIRD layer, distinct from (1)
Aidin's global personal CLAUDE.md (general collaboration rules, applies
everywhere) and (2) each project's own repo CLAUDE.md (dev conventions for
that specific project). This third layer is the orchestrator's own operating
manual — the same role `AGENTS.md` plays for `firstmate` (already studied,
see the 2026-07-03 source-read entries below): a dedicated, editable file
completely separate from any project it happens to be supervising.

**Built:** extracted the classifier's inline `CLASSIFIER_SYSTEM_PROMPT`
string out of `src/lib/orchestratorHelper.js` into a new
`src/lib/orchestrator-instructions.md`, loaded at runtime via
`fs.readFileSync` (resolved relative to the module's own file via
`fileURLToPath(import.meta.url)`, so it works regardless of cwd) instead of
being hardcoded JS. Chose to keep it next to `orchestratorHelper.js` in
`src/lib/` rather than the repo root — it's consumed by exactly one module
today, unlike `PLAN.md`/`DECISIONS.md`/root `CLAUDE.md`, which serve the
whole repo/every session.

**Content — relocated, then modestly expanded, not rewritten:** the file
keeps the original classification instructions (the 5 status tags, JSON-only
response, the 12-word `reason` constraint) verbatim, and adds two sections
already decided in PLAN.md's Phase 3 write-up rather than inventing anything
new: the **orchestrator vs. worker** distinction (orchestrator holds the
continuous thread and can explain why; workers are ephemeral and scoped) and
**human gating scaled to blast radius** (propose via a UI affordance, never
fully autonomous for anything that mutates state a human would want to
review — today's classifier output is explicitly framed as a signal that
feeds sorting/pills, never a trigger that acts on its own). Deliberately kept
lean — a foundational first version sized to what the classifier alone needs
today, to be grown as dispatch/escalation/coaching actually get built, not a
full spec written in advance.

**Behavior unchanged, verified:** the classifier's actual recipe —
`--allowed-tools ""`, empty `--strict-mcp-config`, the Haiku model/effort
args, the `TAG_SCHEMA` JSON schema, and the 5 `STATUS_TAGS` values — is
untouched; `git diff --stat` confirms only `orchestratorHelper.js` changed
(10 insertions/9 deletions, all in the prompt-loading section) plus the one
new untracked markdown file. Verified: `node --check` on the edited file,
a standalone ESM import test that exercises the exact `readFileSync` path
resolution at module-load time (confirms `classifySessionStatus` still
exports correctly and the file loads without throwing), and a full boot-test
via `scripts/restart-dev.sh` (clean log, no errors; confirmed via
`Get-CimInstance` that Helm's own 4 processes recycled correctly and
Reinmaker's 4 processes were untouched, consistent with the documented safe-
restart behavior).

## 2026-07-03 — firstmate/gnhf relationship CONFIRMED; worktree-rooting question resolved

**Decision:** Aidin confirmed the recommendation from the deep source read
(see the entry below): firstmate → reference only, not code (impossible to
run on Windows regardless, tmux/POSIX-locked); gnhf → vendor/adapt its
`Orchestrator` source into Helm's own codebase; treehouse → build first,
independent of the rest. "Reuse the code" for firstmate specifically means
reuse the SOURCE-LEVEL KNOWLEDGE of how it solved wake-classification,
escalation, and worktree hand-off — not running its bash.

**Also resolved a real technical question Aidin raised:** if Helm's own
future orchestrator dispatches work across many different projects, it
can't itself be "rooted" in all of them at once — so how would it create a
worktree for a project it isn't rooted in? Answer: it doesn't need to be.
The constraint hit earlier tonight (Agent-tool worktree isolation failing
because it infers the target repo from the calling session's own cwd) is
specific to that one convenience feature in Claude Code's own tooling, not
a property of git worktrees in general. Confirmed directly in both repos'
source: `treehouse get` takes an explicit project reference regardless of
firstmate's own cwd, and gnhf's `createWorktree` (`git.ts`) takes an
explicit repo/path argument. Helm already tracks `session.cwd` per
project, so its own orchestrator can run `git -C <projectPath> worktree add
<worktreePath> -b <branch>` directly against the right repo from wherever
the orchestrator process itself happens to run — no rooting requirement.

## 2026-07-03 — Thinking indicator + per-reply time/token readout; verified the Done-checkmark bug stays fixed

**Built two small UI additions, both hooked into existing state rather than
inventing new tracking:**

1. **"Thinking" pulsing dot** — `.pane-status-icon` (style.css), a small
   animated dot shown next to the pane's status text while `pane.busy` is
   true. Wired into `setPaneBusyUI` (the one existing chokepoint that already
   toggles the send/stop button between "➤"/"■") and the composer's
   initial-render busy branch, so it can never drift out of sync with the
   button it sits beside. Dropped the literal `"● "` bullet character that
   used to prefix status strings ("● Working…", "● Working — ToolName", "●
   Stopping…") — redundant now that a real animated dot renders the same
   meaning.
2. **"12.3s · 1.2k tokens" readout** on the reply that just completed
   (`.turn-stats`, appended to the same `.turn-actions` row Copy/Done already
   live in). Sourced from data already flowing through the app: `launcher.js`
   now also extracts `duration_ms` and a summed token count (input + output +
   cache create/read) from the CLI's own `result` event, alongside the
   `costUsd`/`numTurns` it already pulled from the same event for the usage
   log. `main.js` rides these along on the existing `"done"` event's
   `summary` object (previously `costUsd`/`numTurns` stayed main-process-only,
   never reaching the renderer) — no new IPC channel. Only shown for the
   reply belonging to the run that JUST finished in that pane; a reloaded/
   reopened session shows no stats line, since per-turn usage isn't parsed
   out of historical transcripts (`transcript.js` doesn't extract `usage`
   today, and doing so was out of scope for this pass).

**Bug caught and fixed before shipping (self-review, not live testing —
caught by tracing the code, not by reproducing it):** the first version
nulled `pane.lastTurnStats` out the instant `wireTurnStatsOnLastReply` read
it, mirroring the (unrelated) single-consume shape of nothing else in this
file. That broke under one real sequence: a queued prompt firing
immediately after "done" triggers `sendFromPane`'s own synchronous
`renderPane()` call BEFORE the "done" handler's own `loadTranscriptInto(...)
.then(refresh)` resolves — so the stats got consumed (and their DOM span
drawn) on that intermediate render, then silently lost when the reload's own
`renderPane` call rebuilt the scroll area from scratch
(`scroll.innerHTML=""` on every call) with nothing left to reattach. Fixed by
making the function non-destructive — it recomputes on every render, the
same pattern `wireDoneButtonOnLastReply`'s `isAcked` check already uses —
and instead clearing `pane.lastTurnStats` explicitly in `sendFromPane` the
moment a genuinely NEW turn starts (the point where "the reply that just
completed" is no longer the last one).

**Verification:** `node --check` on all three edited JS files, a CSS
brace-balance check, and a full boot-test via `scripts/restart-dev.sh` (clean
log, confirmed via `Get-Process` that only Helm's own PIDs were recycled —
the pre-existing Reinmaker instance's PIDs were untouched, consistent with
the documented safe-restart behavior). No live click-through was possible
beyond that — this is a native Electron app, not a browser-servable dev
server, so the usual preview tooling doesn't apply; Aidin will confirm
visually.

**Third ask — re-verified the "Done checkmark follows along" bug (2026-07-02
entries) stays fixed, no code change:** traced every path that pushes new
assistant content into a pane against `wireDoneButtonOnLastReply`'s
`isAcked` check. All five paths that push a new assistant-role turn
(`"assistant"` stream event, `"error"` event, the switch-folder failure, the
start failure, and the "Stopped" path) call `bumpSessionActivity` before
`renderPane()`, keeping `state.sessions`' `lastActivityAt` fresh at render
time. The one path that does NOT call it — the normal successful completion,
which just does `loadTranscriptInto(index).then(refresh)` — doesn't need to:
`launcher.js` always emits the reply's actual text via a separate
`"assistant"` stream event before the CLI process exits and `"done"` fires
(confirmed by re-reading `launcher.js`'s stdout-line handler), so
`bumpSessionActivity` has already run for that exact content by the time the
success branch's reload happens. No remaining gap; nothing changed here.

**Context:** Aidin asked me to act as orchestrator and dispatch agents
against the open Helm backlog rather than build everything inline in
this one long session. Triaged the open Jot items first (see the entry
below) into safe-to-dispatch vs. stale vs. gated-on-a-decision, then
launched two agents: a background research agent to study firstmate +
gnhf SOURCE (the task PLAN.md's Phase 4 section had been flagging since
the video-summary pass), and a worktree-isolated coding agent for a small
UI-polish bundle.

**Incident:** The research agent, asked to "clone both repos and read
their source," repeatedly interpreted that as a delegation task instead of
doing the work itself: it spawned a sub-agent and reported "completed"
with no findings, five times in a row (each generation's own result was
some variant of "I've launched an agent to do this, I'll report back" —
one generation even fanned out to 2 parallel children instead of 1,
widening rather than just chaining). `TaskStop` against each completed
generation's id correctly reported "not running" — there is no way to
reach into a chain like this and kill a live but not-yet-surfaced
descendant, matching the standing memory note on agent-fanout risk. Total
cost across the misfire: roughly 435k combined subagent output tokens
before real work appeared, against a task that should have been a single
well-scoped call.

**Resolution:** Rather than send a 6th corrective message into an already
overgrown tree, abandoned that lineage entirely (any further orphaned
notifications from it are harmless — wasted tokens, no destructive action)
and did the research directly in the main conversation via `gh api`
(reading key files from both repos without cloning) — got a solid,
directionally-correct recommendation from that alone. The two orphaned
generations 5/6 THEN separately reported back with real, deeply-read
findings (they had, it turned out, actually done the work — just five
generations later than they should have and at enormous token cost). Their
findings were meaningfully more thorough than the direct `gh api` pass
(full grep sweeps, git history, exact line citations, and two decision-
relevant facts the quick pass missed entirely: firstmate is macOS/Linux-
only, and gnhf has zero exported library API) — folded into PLAN.md's
Phase 4 section, superseding the faster first-pass findings.

**Lesson for future research-style dispatches:** the failure mode was
specific and repeatable — a general-purpose agent given a multi-repo
"clone and deeply read" task defaults to delegating rather than executing.
Next time, state explicitly in the prompt: "do this yourself in this turn
using Bash/gh directly — do not call the Agent tool or delegate to another
agent." Cheap insurance against a 400k-token misfire for what should be a
single agent's work.

## 2026-07-03 — Jot triage before dispatch: most of the open backlog wasn't
## actually ready for blind agent fan-out

**Decision:** Before dispatching any agents against the ~20 open Helm
Jot items, read each one against DECISIONS.md's own history rather than
assume "open in Jot" means "ready to build." Found four real buckets:
already-resolved-but-not-closed (2 items — a duplicate of an already-
`done` model/effort-analysis decision, and the mid-turn-input-box question
already conclusively answered negative by the 2026-07-03 persistent-
process spike), too-vague-to-delegate (advanced-view redesign, "Routines
section?" — need Aidin's specifics first), gated-on-the-firstmate-decision
(gnhf, no-mistakes, half of worktree-automation — building these before
the strategic question above is answered would bypass the very human-
gating principle PLAN.md itself calls for), and genuinely-safe-to-dispatch
(a thinking-indicator icon, a time/tokens chat readout, re-verifying an
old checkmark bug, plus the firstmate/gnhf research above). Closed the two
stale duplicates with a note pointing at the superseding decision, left
the vague ones untouched, and only dispatched agents against the last
bucket. This triage-before-dispatch step is itself an orchestrator
behavior (per PLAN.md's own "orchestrator vs. worker" framing) — sensing
and routing before delegating, not fan-out as a default.

## 2026-07-03 — Added a repo-root CLAUDE.md, closing the "on-ramp" gap for this repo

**Decision:** Direct follow-through on the strategic reorientation below -
a fresh short-lived session needs a cheap way to bootstrap "what is this
project, what's the current phase, what's already been decided" without
the user re-explaining it. `PLAN.md`/`DECISIONS.md` already held that
content, but neither auto-loads the way a repo-root `CLAUDE.md` does, so a
new session had no path to them unless told. Added `CLAUDE.md` (repo root):
a short pointer to both files plus the one genuinely repo-specific footgun
(the `taskkill /IM electron.exe` / Reinmaker collision, see the 2026-07-02
entry below) - deliberately NOT duplicating anything already covered by
Aidin's global personal `CLAUDE.md` (git conventions, testing discipline,
etc.). Also closes the Jot tasks "länk till personlig och projekt claude.md"
and "CLAUDE.md-trim -> skills" (the trim/skills side was done tonight on the
global file - see that file's own history for the Jot-section-to-skill
move) and directly answers "fix a better claude.md" and "Bryter vår auto
compact mot kortlivade sessioner filosofin?" (answered in the reorientation
entry immediately below - kept, de-prioritized as a strategy, not removed).

## 2026-07-03 — Strategic reorientation: ephemeral sessions, not a durable fleet

**Decision:** Aidin realized he's been working wrong — long-lived sessions,
roughly one per PROJECT, when the real unit should be one per FEATURE/task.
A session should carry only context relevant to what's happening now; durable
knowledge belongs in files (CLAUDE.md, DECISIONS.md, memory), not in an
indefinitely-kept-alive session. Full reasoning in PLAN.md's new "Strategic
reorientation" section (placed right after the vision table, since it
reprioritizes work across Phase 3/4, not just a footnote).

Three concrete implications, discussed and agreed:
1. **Auto-compact (Fas 3's proactive idle-session version) is a partial
   anti-pattern** — it keeps a megasession alive-and-lean instead of
   prompting an actual wrap-up. The context gauge is the pro-pattern tool
   (nudges toward ending); auto-compact is a crutch for avoiding that.
   Not removed (shipped, opt-in, genuinely useful for one legitimately long
   task) — de-prioritized as a strategy going forward.
2. **Session-list curation (drag-sort, categories, deadline-sort) is also
   partly an anti-pattern** — it organizes sessions as durable objects worth
   tending, when the real unit worth organizing is work/goals (already in
   Jot). Not ripped out; let its importance fade as ephemeral sessions
   become the norm rather than cutting it surgically now.
3. **Re-ranks priority toward "on-ramp" tooling** — whatever makes a fresh
   session cheap to start and cheap to feed context into (CLAUDE.md/skills,
   Fas 2 handoff, DECISIONS.md/memory discipline, and from Phase 4:
   treehouse, `/triage`, the handoff skill) now matters more than features
   that make megasessions more pleasant to live in.

Same fork as the already-flagged firstmate strategic question (Phase 4) —
firstmate has no session list at all, just a crew + disposable worktrees,
oriented around dispatch and goals. Both threads point the same direction.

This session (this very transcript) is itself the illustrating example: a
single "Helm project" megasession spanning the classifier, auto-compact,
context gauge, root-folder-switch debugging, CLAUDE.md consolidation, and
this Phase 4 planning — already auto-compacted multiple times, expensive per
turn. Split into per-feature sessions, each would have been sharp, cheap,
and left a clean topical transcript.

## 2026-07-03 — Root-folder switch didn't stick: session.cwd lives in a file the switch never touched

**Bug (the real one, found via two rounds of live testing):** Aidin tested
the switch feature twice. First test: pick a new folder, navigate away and
back — folder reverted (fixed below by preserving pane state — but that
fix alone didn't solve it). Second test: pick a new folder, send a real
message, WAIT for the reply, then navigate away and back — folder STILL
reverted. That ruled out the pane-state theory as the root cause.

Root cause: `session.cwd` — read by literally every part of the app that
shows or reuses a session's folder (sidebar rows, pane header, the
composer's cwd field on open) — comes from `buildSession`'s `cwd: meta.cwd`,
where `meta` is the DESKTOP APP'S OWN `local_<uuid>.json` sidecar metadata
file. `switchSessionRootFolder` only ever copied the `.jsonl` transcript; it
never touched that sidecar. So the switch worked for exactly one immediate
`--resume`, but the moment the session was reopened, Helm re-read the
still-stale old `cwd` from the sidecar and the switch silently evaporated —
regardless of how many real turns had run from the new folder.

**Fix:** extracted `setSessionArchived`'s existing careful mutation pattern
(find the sidecar by sessionId, re-read fresh right before writing to
shrink the race window against the desktop app's own concurrent writes,
patch one field, write via temp-file + atomic rename) into a shared
`patchSessionMeta(sessionId, patchFn)` helper — `setSessionArchived` is now
a one-line wrapper over it. `switchSessionRootFolder` calls
`patchSessionMeta(sessionId, meta => { meta.cwd = newCwd })` on every
invocation (not just when the transcript copy was needed — an earlier
attempt, made before this fix existed, could leave a correctly-placed
transcript with still-stale metadata). Verified live against a real session
(Jot): `session.cwd` now updates immediately after the switch call, with no
new turn needing to run. Review came back fully clean (setSessionArchived
behaviorally identical post-refactor, no race with the CLI process since the
switch is awaited before `startSession` spawns anything, double-switching an
already-broken session is safe). Re-ran the fixed switch for all 14 sessions
touched tonight (13 + this session's own) so they're now genuinely durable,
not just transcript-copied. Aidin confirmed live: "nu verkar det fungera!"

## 2026-07-03 — Pane header's folder path never updated live

**Bug:** Aidin: "vi borde fixa pathen vid titeln" — after picking a new
folder or completing a root-folder switch, the path shown next to the pane
title never changed. Root cause: `paneHeaderEl()` builds `.pane-sub` (the
path span) ONCE at pane-construction time; `renderPane()` (called on every
send/turn) only ever rebuilds the `.pane-scroll` area, never the header. So
`.pane-sub` was permanently stale from the moment the pane was first
rendered, regardless of how `pane.cwd` changed afterward.

**Fix:** `updatePaneSubText(index, cwd)` queries the live DOM for that
pane's header and updates/creates/removes its `.pane-sub` span directly,
without rebuilding anything else. Called from all three places `pane.cwd`
changes: typing in the cwd input, picking a folder via "…", and
`sendFromPane`'s own `pane.cwd = cwd` assignment.

**Separately surfaced while diagnosing this**: Aidin's actual "switch root
folder" confusion (a session's root flip-flopping between two folders across
messages) turned out to be unrelated to Helm at all — both turns carried
`"entrypoint":"claude-desktop"`, meaning he was sending via the real Claude
Desktop app on the same session, not Helm's own composer. Desktop has its
own, separate session-resume resolution that Helm's switch/mtime-based
`findTranscriptPath` fix has no influence over — using Desktop and Helm
interchangeably on the same session can pick either transcript copy
unpredictably. Not a Helm bug; a real limitation of mixing the two front
ends on one session, worth remembering if it comes up again.

## 2026-07-03 — "Switch root folder" + stop silently dropping CLI failures

**Decision:** Aidin noticed the "…" folder-picker is always clickable, even
on an already-resumed session, and asked what it actually does there ("kan
en session byta root folder? diskussion"). Investigated rather than
guessing: `claude --resume` scopes its own session lookup by cwd — spiked
resuming from a different folder and got "No conversation found with
session ID" outright. Worse: Helm had NO handling anywhere for CLI
stderr — the error vanished completely (no case in the renderer's event
switch), so picking a new folder on an existing session and sending
silently ate the message with the pane just going back to idle. Chose to
build the real feature (verified buildable — copying the transcript into the
target folder's own project dir first, same trick as rewind-to-here) rather
than just closing the trap.

**Built:**
- `stderrText` now flows through launcher.js's `done` summary; the renderer's
  `"done"` handler gained a branch for genuine failures
  (`!sawResult && code !== 0`) that surfaces a visible `⚠` error turn instead
  of silently reloading an unchanged transcript. This is a general safety
  net, not just for this one failure mode.
- `switchSessionRootFolder()` (sessions.js): copies (never moves) the
  transcript into `newCwd`'s own encoded project dir
  (`paths.js`'s new `encodeProjectDir`, mirroring the CLI's own naming).
  `sendFromPane` calls this first when a resumed pane's folder was changed,
  before `startSession`.
- `findTranscriptPath` changed from "first directory match" to "most
  recently modified match" — after a switch, the same session id briefly
  exists in two project dirs, and directory-enumeration order isn't
  meaningfully "correct."
- **Bug caught by a standalone test before shipping**: `fs.copyFileSync`
  PRESERVES the source's mtime on Windows — without an explicit
  `fs.utimesSync` bump on the copy, the new mtime-based tie-break sometimes
  still resolved to the STALE pre-switch copy. Fixed; re-verified 4/4 checks
  (switch succeeds, resolves to the fresh copy, `--resume` works from the
  new folder, still resolves correctly after a real new turn).
- **Review caught two more before shipping**: (1) the switch-success path was
  missing the `panes[index] === pane` identity guard every other await
  boundary in `sendFromPane` uses — added for consistency (pane could've
  been reset/reassigned during the switch's await). (2) A spawn-level
  failure (binary not found) resolves with `{error: err.message}` and no
  `stderrText` — the new error branch now falls back to `evt.summary?.error`
  instead of dropping that message for a generic "exit code -1" text.

**Where a session's context/CLAUDE.md/settings get enforced after a
switch**: same as any Helm-launched session — resolved per-invocation
from the CLI process's cwd, not baked in at session creation. So yes,
switching folders and sending genuinely changes which project's CLAUDE.md,
settings, and skills apply going forward — not something Helm implements
itself, just a consequence of how `-p` already works for every session.

## 2026-07-03 — Merge suggest-hint and context gauge onto one row

**Decision:** Aidin: "kan du lägga dessa på samma rad" (screenshot showing
the model-suggestion hint on its own line and the context gauge stacked
below it). Wrapped both in a new `.composer-meta-row` flex row instead of
two separate full-width lines. `.composer-context` keeps `margin-left: auto`
(not `justify-content: space-between` on the row) specifically so it still
pins to the right when `.suggest-hint` is empty and `display:none` removes
it from the row — space-between would have left it sitting at the start
with nothing to space between.

## 2026-07-03 — Learn real context-window per model from the CLI (not a hardcoded max)

**Decision:** Aidin: "går det inte att få ut kontext size från modell-
informationen?" Yes. The CLI's `result` event reports each model's real
context window at `evt.modelUsage[model].contextWindow` (verified live:
claude-haiku-4-5 → 200000). So instead of the hardcoded 1M guess for the
gauge's %, Helm now LEARNS the true window per model: the launcher
extracts `contextWindows` from every result event, and the launch's done
handler merges any new model→window into `config.modelContextWindows`
(persisted; a no-op write once steady). Done even for internal launches
(they run real models). The gauge's `contextWindowForPane()` prefers the
learned window for the session's model and falls back to
`config.contextWindowTokens` only for a model not yet seen.

Self-correcting and authoritative: as Aidin runs each model through Helm
once, its window becomes exact. The 1M fallback just covers the gap until
then (and for sessions only ever run outside Helm, whose interactive
transcripts carry no contextWindow field).

## 2026-07-03 — Context gauge → bar+% with a click-to-open context+quota popover

**Decision:** Iterated the context gauge per Aidin's feedback (referencing
Claude Code's combined readout): make it a bar + percentage, and fold the
quota into a popover you get by clicking it — "de visar en mätare av
kontexten och när man trycker på den ser man både kontext och kvot."

- The gauge (in the composer, under the model/effort row) is now a clickable
  bar + "%" instead of a plain token count.
- Clicking opens a `.context-popover` (anchored above it) showing a Context
  window row (Nk / max (X%) + bar) and a Quota row (utilization % + bar).
  Closes on second click / outside click / Escape (wired alongside
  closeContextMenu).
- Quota MOVED out of the top-header `#quota` span into this popover
  ("flytta ner quota menyn dit också"). `renderQuota` is now a no-op;
  `state.quota` still flows via refresh() and the popover reads it live.

**The % needs a max, which isn't reliably readable per session** (the
interactive transcript has no `contextWindow` field; it varies by model —
200k / 1M). Added `config.contextWindowTokens`, defaulted to 1000000 to match
Aidin's current environment (his own Claude Code shows "/ 1.0M"). The gauge
still shows the absolute token count in the popover, so a wrong max only
skews the %/bar, never hides the real number — and it's one config value to
correct. A real per-model window lookup is a future refinement.

## 2026-07-03 — Per-session context-size gauge in the pane header

**Decision:** Aidin's ask (with a Claude-Desktop screenshot showing "Context
window 429.1k / 1.0M (43%)"): a context-usage readout. Added a "◱ Nk ctx"
chip to the pane header for the open session, reusing
`estimateSessionContextTokens` (the same proxy auto-compact keys off — so the
gauge and auto-compact stay consistent). `transcript:get` now also returns
`contextTokens`; the pane stores it and the header renders it.

Deliberately absolute tokens, NOT a percentage/bar like the reference: the %
needs the model's context-window size (200k / 1M / …), which varies and isn't
reliably known per session here — a made-up denominator would mislead. The
honest absolute number ships now; a real %/bar is a refinement for if/when
the window size is reliably readable (the transcript's `result` events carry
`contextWindow`, but not in every format — left for later). Distinct from the
compaction pill (which marks WHERE a compaction happened); this is the
live "how full right now" readout.

## 2026-07-03 — Fas 3 auto-compact shipped + a compaction pill in the chat

**Built** the auto-compact feature (Aidin chose automatic-not-propose):
- `estimateSessionContextTokens()` — transcript-tail proxy for current
  context size (last usage block's input+cache_creation+cache_read).
  Verified within ~1% of the CLI's own pre_tokens on a real compaction.
- `compactSession()` — `--resume -p "/compact"`, confirms via the
  `compact_boundary` event. Verified end-to-end (ok, pre 33132 → post 2125).
- Folded into the periodic sweep, own `autoCompact.enabled` toggle (off by
  default) + `thresholdTokens` (150k default). Re-compaction guard keyed on
  transcript BYTE SIZE (not lastActivityAt, not the token estimate — a
  /compact-only run writes no fresh low-token usage block, so the estimate
  stays stale-high; and compaction may bump lastActivityAt): a session is
  re-eligible only once its transcript grows past the size sampled right
  after its last compaction. A small "⊟ Auto-compacted (X→Y)" row note
  surfaces it (Aidin's concern about silent compaction).

**Review was fully clean** on all six probes; applied its two minor notes:
compaction is now restricted to `idle` sessions only (not `waiting` — the
one status that could be a session streaming a turn OUTSIDE Helm; also
matches Aidin's "aktiv men idle" framing), and `enrichWithJot` now runs only
in the classify branch (the compaction pass never reads Jot).

**Q: does the CLI's own auto-compact-when-full still work in Helm
sessions?** Yes — verified this session's transcript carries 2
`trigger:"auto"` compact_boundary events. Helm never touches context
management, so the built-in fires normally near the limit; Fas 3
auto-compact is a separate, earlier proactive trigger (`trigger:"manual"`,
150k, idle). They coexist.

**Compaction pill in the chat** (Aidin's ask "skriv även ut i chatten med en
pill att compacting skett"): `transcript.js` now emits a `compact_boundary`
marker turn wherever the transcript has one, and the renderer draws a
centered divider pill "⊟ Context compacted (auto/manual · X→Y tokens)".
Works for ALL triggers uniformly (CLI built-in, Fas 3 auto, manual). Handles
BOTH transcript formats — headless stream-json (`compact_metadata`,
snake_case) and interactive desktop (`compactMetadata`, camelCase) — since
Helm reads sessions from both. Verified parsing against a real transcript
(trigger:"auto", pre 917979 → post 53922).

## 2026-07-03 — Spike: headless /compact works (auto-compact is buildable)

**Decision:** Before building the Fas 3 auto-compact feature, spiked whether
headless `-p` can even trigger the CLI's built-in `/compact`
(`spike/test-compact-headless.mjs`). Result: definitively YES.
`--resume <session> -p "/compact"` emits a clean event sequence —
`system/status status:"compacting"` → `status:null compact_result:"success"`
→ a `system/compact_boundary` event carrying
`compact_metadata: { trigger:"manual", pre_tokens, post_tokens, duration_ms,
preserved_segment }`. In the test: pre_tokens 32989 → post_tokens 2261
(~93% reduction), and context genuinely survived (recalled a fact planted
before the compaction).

Notable gotcha for whoever builds the "did it work" detection: compaction
does NOT shrink the transcript `.jsonl` on disk (it's append-only) — it
APPENDS a summary user-turn + the `compact_boundary` marker, so line/byte
count goes UP (24 → 36 in the test), not down. The authoritative success
signal is the `compact_boundary` event's `compact_metadata` (and its
pre/post token counts), never file size.

Also learned: the `compact_boundary.compact_metadata.pre_tokens` is exactly
the "how much context was in use" number — but it's only available AFTER a
compact. To decide WHEN to auto-compact, the pre-compaction context size has
to come from elsewhere (the last `result` event's `usage` in the transcript
tail — cache_read + input tokens — is the readable proxy). That "when to
fire" logic + the propose-vs-act gating decision is the actual build, now
unblocked. The "can we fire it at all" question is closed.

## 2026-07-03 — Fas 3 first slice: the orchestrator-helper classifier

**Decision:** Aidin approved starting Fas 3 ("börja bygga nu"), scoped down
per his own preference to the smallest self-contained first slice: just the
periodic session-status classifier (the "sensor"), NOT auto-compact, NOT the
model/effort-accuracy loop, NOT the visualizer — those stay for later passes
per PLAN.md's own framing.

**Built:** `src/lib/orchestratorHelper.js` — `classifySessionStatus()`,
mirroring `judge.js`'s cost-optimized recipe almost line for line (same
`--system-prompt` + `--allowed-tools ""` + empty `--strict-mcp-config`,
Haiku, structured JSON schema output). Reads the last 6 turns of a session's
transcript + its Jot task summary, classifies into
`waiting_for_input`/`stuck`/`done_not_archived`/`blocked_external`/
`genuinely_active`. `main.js`'s `runOrchestratorSweep()` runs this every 15
minutes (off by default via `config.orchestratorHelper.enabled`) over
non-archived `waiting`/`idle` sessions, skipping any unchanged since its last
classification, capped at 15 classifications/sweep. Results merge into
`sessions:get`'s response as `session.orchestratorTag`. The renderer shows
the tag's `reason` as a small note on the row (the plan's own "auditable,
not a black box" principle — a minimal stand-in for the full visualizer,
which stays deferred until there's real behavior to design a UI around) and
sharpens the existing "Archive?" pill: it now also fires when the classifier
says `done_not_archived`, even before the session has aged into "idle" —
replacing the old blunt idle-and-no-Jot-work proxy with something that's
actually read the content, per the plan's own framing.

Also fixed a stale PLAN.md claim: Point 11's write-up said the mid-turn-
interjection spike had "confirmed working" — that was true as of the
2026-07-02 spike note but got FLIPPED by today's fuller spike (see below);
corrected before it misled a future read of the plan.

**Review caught one real issue before shipping**: `setInterval` doesn't know
whether a previous sweep is still running — up to 15 sequential classifier
calls (each with its own 30s timeout) stay under the 15-minute interval in
the stated worst case, but that's a coincidental margin, not an enforced
one. Added a `sweepInFlight` guard so a slow sweep can't overlap a second
one and double the concurrent spend. Everything else review checked
(cost/rate safety, staleness-check correctness, archive-pill condition
safety, fingerprint completeness, object-isolation between the sweep's and
the IPC handler's separate `readAllSessions()` calls) came back clean.

## 2026-07-03 — restart-dev.sh's kill step was silently a no-op all session — rewritten in PowerShell

**Bug:** Aidin noticed a new Helm window opening without the old one
closing. Investigated instead of guessing: `restart-dev.sh`'s kill step
(`wmic ... | grep -i "$REPO_PATH_WIN"`, built earlier today specifically to
stop boot-tests from killing Reinmaker) had a real bug — `grep`'s regex mode
interprets a literal Windows path's backslashes as escape sequences (`\R`,
`\T`, `\m`...), so matching `D:\Repo\Tools\helm` against wmic's CSV output
silently failed on EVERY invocation, and `|| true` swallowed the failure
with zero visible error. Every restart-dev.sh call this session launched a
NEW Helm instance on top of whatever was already running instead of
replacing it — confirmed live: found 3 stray Helm instances (12 stray
electron.exe processes) piled up by the time Aidin caught it.

`grep -F` (fixed-string) was tried next and still failed/crashed against the
real wmic output in this environment (a `grep` abort, not investigated
further — not worth chasing when a cleaner tool was available). Rewrote the
kill step in PowerShell (`scripts/kill-helm.ps1`, invoked via
`-File` — nesting the PS one-liner inside a bash single-quoted `-Command`
argument mis-parsed `-Filter` on the first attempt, a second quoting layer
not worth fighting): `Get-CimInstance Win32_Process` + a plain `-like`
string match, no regex-escaping ambiguity. Verified live end-to-end twice —
first run correctly found nothing to kill (fresh baseline) and started one
instance; second run correctly found and killed that exact instance (all 4
of its child processes) before starting a new one, with Reinmaker's 4
processes confirmed untouched both times.

## 2026-07-03 — Spiked persistent-process architecture: doesn't unlock what we wanted

**Decision:** Both "a real input box when Claude needs an answer mid-turn"
and "interject info into a PROGRESS run" were blocked on the same
architecture question — a persistent `claude -p --input-format stream-json`
process per pane instead of one process per turn — and it was unverified
whether either use case is even possible headlessly. Aidin approved running
a spike before deciding whether the architecture change is worth it
(`spike/test-persistent-process-blocking-input.mjs`,
`spike/test-permission-deny-path.mjs`).

**Result — negative for both, and NOT an investment question anymore:**
1. Headless `-p` mode has NO pause-and-ask primitive at all. A tool call
   either runs or gets denied synchronously based on flags
   (`--allowed-tools`/`--permission-mode`) — no stream-json event type pauses
   the turn and waits for a stdin-supplied decision, with or without a
   persistent process. Confirmed with both an allowed-tool run (ran
   immediately, no permission event) and a should-be-restricted run (also
   ran immediately, no block, no hang, no permission event — `-p` mode's
   permission model just isn't an interactive round-trip).
2. A second stdin message written 1.5s into a 14-second-long first turn
   (while it was still actively generating) was NOT folded into that
   turn's output — the CLI ran the first turn to full completion, THEN
   processed the second message as an entirely separate next turn. This is
   functionally identical to Helm's existing "queue next prompt"
   (already built via a fresh process per turn) — a persistent process adds
   no new capability here.

**Conclusion:** this isn't "is the architecture change worth it" — it's "the
architecture change doesn't solve the problem" for either feature, given the
CLI's actual headless behavior. Both items stay parked, now with a
conclusive technical reason instead of an open question. (Multi-turn on one
persistent process DOES work correctly for strictly sequential turns — just
not for anything resembling a live mid-turn interjection or a blocking
question.)

## 2026-07-03 — Scroll-to-bottom button + slightly larger chat font

**Decision:** Two quick asks. (1) "öka fontstorlek i chatten aningen" —
`.turn-bubble`'s font-size bumped 12.5px → 13.5px; left markdown code-
block/table sizes untouched (their own smaller size is a deliberate density
choice for dense content, not something "aningen" was asking to change).
(2) "scroll to bottom knapp" — a floating "↓" button, hidden by default,
appears once you've manually scrolled more than 80px away from the bottom
(e.g. to reread earlier history), click smooth-scrolls back down.

Implementation note/bug caught before shipping: `.pane-scroll` is the SAME
persistent DOM node across every `renderPane()` call (only its innerHTML
gets cleared) — a plain `addEventListener("scroll", ...)` inside the wiring
function would have piled up a new listener on every single render (every
streamed chunk, every poll-triggered update) forever, each stale one still
closing over its own now-detached button from a past render. Fixed by
stashing the listener function on the element and removing the previous one
before attaching a new one — exactly one live listener at a time, no matter
how many times the pane re-renders.

## 2026-07-02 — Done checkmark is now toggleable (un-ack undoes it)

**Decision:** Aidin: "checkmarken bör gå att ta bort också (?) eller?" Agreed
— a checkbox you can't uncheck is an odd affordance, and clicking an already-
acked checkmark to say "actually, this needs attention again" is exactly the
real state `acknowledgedSessions` already models (deleting the entry makes
`main.js`'s status override fall through to the normal `deriveStatus`
result, correctly reverting to "waiting" if still within the attention
window). Removed the `disabled` gate; the button now toggles both ways —
click un-acked → acked (adds the config entry), click acked → un-acked
(deletes it) — with the same instant local visual feedback ahead of the
async round-trip in both directions.

## 2026-07-02 — Fixed: the Done checkmark was "following along" onto new replies

**Bug:** Aidin: "nästan rätt. Min avsikt var att checkmarken skulle betyda,
jag är klar till det här läget. Men om jag sen fortsätter prompta tillkommer
nya saker och då ska inte checkmarken följa med." Root cause: `isAcked` in
`wireDoneButtonOnLastReply` compares `config.acknowledgedSessions[sessionId]`
against `session.lastActivityAt` — but `session` comes from `state.sessions`,
which is ONLY refreshed by the 30s poll / explicit `refresh()`, never
updated live as a run streams. When a new reply streamed in mid-conversation,
the pane's live `pane.turns` already had the new content, but
`state.sessions`' `lastActivityAt` for that session was still the OLD
(pre-new-reply) value — which could still exactly equal the earlier ack
timestamp, making `isAcked` wrongly true and painting the checkmark onto a
reply it was never placed on.

**Fix:** `bumpSessionActivity(sessionId)` mutates the matching
`state.sessions` entry's `lastActivityAt` to `Date.now()` the INSTANT new
content actually streams into a pane — called right before `renderPane()` in
all four places a pane pushes a new assistant-role turn (`"assistant"`
event, `"error"` event, the "⚠ Failed to start" path, and the "⏹ Stopped."
path). This invalidates any stale ack match immediately, without waiting for
the next poll. Verified with a standalone sequence simulation (4/4): ack
holds through no-op time passing, clears the instant new content streams in,
and stays correctly un-acked once the real poll's timestamp catches up.

## 2026-07-02 — Swapped Done/Copy icon order (Done first)

**Decision:** "vi borde byta plats på checkbox och copy ikonen, annars ser
det konstigt ut när den är ikryssad." With Done appended AFTER Copy, an
acked (always-visible) checkmark sat to the right of Copy's hover-only slot
— hovering made Copy pop in to its LEFT, visibly shifting the checkmark
sideways. Switched to `actions.prepend(done)` so Done leads the row; its
position stays fixed whether or not Copy is currently visible.

## 2026-07-02 — Boot-test restarts were silently killing Reinmaker

**Bug (mine):** every boot-test in this repo restarted Helm via
`taskkill /F /IM electron.exe` — matches by image name only, machine-wide.
Aidin reported "Appen stängdes, jag tror du och reinmaker slåss om samma
port." Investigated instead of guessing: no port conflict — Helm's source
has zero `listen()`/`createServer()` calls anywhere. The real cause: Reinmaker
(tgs-reinmaker) runs unpackaged in dev mode via `electron .`, so its process
also shows up as bare `electron.exe` in Task Manager, indistinguishable by
name from Helm's own dev process. Every blind image-name kill this
session silently closed Aidin's live Reinmaker session too — confirmed live:
found 4 running `electron.exe` PIDs, all four traced via `wmic ... get
CommandLine` to `tgs-reinmaker\node_modules\electron\dist\electron.exe`, none
to Helm.

**Fix:** `scripts/restart-dev.sh` — resolves the repo's own path, queries
`wmic process where "name='electron.exe'"` for CommandLine, and only kills
PIDs whose command line actually points at THIS repo before restarting.
Verified live: ran it while Reinmaker's 4 processes were up — Helm
restarted cleanly and all 4 Reinmaker PIDs were untouched afterward. This is
now the only sanctioned way to restart Helm during dev work; a bare
`taskkill /IM electron.exe` must not be used again in this repo.

## 2026-07-02 — Done button: check icon beside Copy, hover-only, persists as a checkmark once clicked

**Decision:** Follow-up on the per-reply Done button (previous entry):
"kan vi lägga den som en liten check ikon bredvid copy ikonen som endast
dyker upp på hoover. Och när den är checkan dyker en checkmark upp på
svaret." Redesigned:
- `turnEl()` now wraps the assistant reply's Copy button in a `.turn-actions`
  row (previously appended directly to the `.turn` column) so a second
  button sits BESIDE it, not stacked underneath.
- The Done button reuses the `copy-btn` class, giving it the exact same
  hover-only opacity behavior as Copy — invisible until you hover the reply.
- Once clicked (or on a re-render of an already-acknowledged reply — checked
  via exact equality between `config.acknowledgedSessions[sessionId]` and
  the session's current `lastActivityAt`), it gets an `.acked` class that
  forces it permanently visible and accent-colored, and gets disabled — a
  persistent checkmark confirming that specific reply was marked done,
  matching the copy button's own instant-feedback pattern but WITHOUT
  reverting afterward (since the underlying state, unlike a copy action,
  actually changed).
- Backend (config.acknowledgedSessions, the main.js status-override ordering
  fix) is completely unchanged — only the affordance's visual treatment and
  DOM position moved.

## 2026-07-02 — Performance + token usage audit; one real fix applied

**Decision:** Aidin's Jot task "performance + token usage granskning av
appen" — ran an audit (two agents, renderer perf + Helm's own internal
LLM-call costs) rather than guessing. Verdict: the app is already well-
optimized at its actual single-user scale (~9 groups, ~35 grouped + ~100
total sessions). Token/cost axis fully clean — the model-fit judge (Haiku,
per completed run) uses the established cheap-call recipe correctly, is
gated off `internal:true` launches, and costs ~$0.015/run;
`suggestModelEffort` isn't an LLM call at all (pure regex, also debounced);
Fas 2's summarize-and-carry-over correctly does NOT use the cheap recipe
(it's a real generative Sonnet call by necessity) and only fires on an
explicit user click. No cost leaks found anywhere.

**One real, worth-fixing finding on the renderer side**: the 30s
`setInterval` poll unconditionally called `renderSidebar()` (full
`innerHTML=""` + rebuild) even when nothing the sidebar displays had
changed since the last poll — 100% wasted work most ticks, all day, every
day the app is open. (Everything else flagged — an O(n²)-shaped grouping
loop, transcript re-reads, potential memory-leak shapes in
pendingLaunchCallbacks/launchPaneHistory/paneNavHistory — checked out fine
at this app's real scale; no action needed on those.)

**Fix**: `computeSidebarFingerprint(sessions, config)` builds a cheap string
from exactly the fields renderSidebar()'s OUTPUT depends on (session
identity/status/model/archived + the Jot badge fields + config.groups/
sidebarMode/archiveSuggestions/hideArchived) — deliberately not a full
JSON.stringify of the whole payload, since most session fields (turns, cwd,
etc.) don't affect a sidebar row and would cause false-positive "changed."
`refresh()` compares this against the previous poll's fingerprint and skips
`renderSidebar()` when unchanged. Every OTHER call site that renders on a
real user action (search, category CRUD, opening a session, drag-reorder,
...) still calls `renderSidebar()` directly and is unaffected by this cache
— it only guards the unconditional 30s timer tick. Sensitivity verified
standalone (7/7: status change, group rename, collapse toggle, new session,
deadline change, archiveSuggestions toggle, and identical-data-stays-
identical all behave correctly).

## 2026-07-02 — Manual "✓ Done" button on the last reply (not a sidebar pill)

**Decision:** Aidin's ask: "jag hoppas fas 3 orkestratorn löser detta men man
kanske också ska stoppa en manuell check på varje svar så att jag med den kan
ange - jag är klar med denna" (a session that ended with a real answer, e.g.
"here's what to tell your colleagues," has nothing left to do but still sits
in "Needs you" until the attention window expires — he wants a manual check
ahead of the Fas 3 orchestrator eventually automating it). First built it as
a "✓ Done" pill on the sidebar ROW. Feedback: "Nej, inte riktigt vad jag
tänkt mig. Jag vill ha den per svar inte per session" — he'd literally said
"per svar" (per reply) in the original ask and I'd read it as "per session."
Moved the button to the reply itself: it now sits under the LAST assistant
bubble in the pane (only that one — it's the only reply whose ack actually
changes the session's status, since status is derived from the last
message's role/age; an older reply already has a newer one after it).
Backend unchanged — same `config.acknowledgedSessions[sessionId] =
lastActivityAt` mechanism (stale-checks itself on new activity, no cleanup
code needed), same recipe as `titleOverrides`. Only the affordance's
LOCATION changed, from `rowEl()` (sidebar) to `wireDoneButtonOnLastReply()`
(pane, alongside `wireEditableUserTurns`) — deliberately always-visible
(unlike `.copy-btn`/`.rewind-btn`'s hover-only opacity) since it's a status
affordance like `.archive-suggest-pill`, not a hover utility.

Before the relocation, review caught a real ordering bug in the backend:
`sessions:get` ran `enrichWithJot` (computes `attentionScore`/
`needsAttention` off `session.status`) BEFORE the ack-downgrade loop, so an
acknowledged session's score/spotlight stayed stuck at full "waiting" weight
even though it displayed as idle. Fixed by moving the downgrade before
`enrichWithJot` — this fix carried over unchanged through the relocation.

## 2026-07-02 — Collapse/expand-all-categories button (the "list-sorting view")

**Decision:** Aidin's follow-up on the (now-working) category drag-reorder:
"needs a dedicated view for list sorting — sounds like a simple collapse/
expand-all button." Built exactly that: a toolbar button that toggles all
categories collapsed↔expanded at once (if all are already collapsed, expand;
else collapse), so you can drop the whole sidebar to just category headers,
see and reorder the list order at a glance, then expand back. Persists via
each group's existing `collapsed` flag — no new state. Deliberately the
lightweight option over a separate modal/settings-page reorder UI (the two
heavier ideas from the discussion), matching Aidin's "simple button" framing.

## 2026-07-02 — Rewind rebuilt as real transcript-forking (the true desktop behavior)

**Decision:** Second round of rewind feedback: "all history still disappears
— in the desktop app only the messages AFTER the rewind point vanish." The
same-pane-with-text-replay approach still dumped everything into a draft
blob; the prior conversation didn't stay as real rendered history. To get the
actual desktop behavior I first had to answer whether it's even buildable on
the CLI.

**Spike (`spike/test-rewind-fork.mjs`) — PASS.** Created a throwaway session
(favorite color blue → changed to red), hand-truncated a fork of its
transcript to before the "red" turn, wrote it as a new `<uuid>.jsonl`, and
`--resume`d it: it answered "blue." So `claude --resume` reads a
hand-authored truncated transcript with NO desktop metadata, and
post-truncation turns are genuinely gone from the model's context. Real
rewind is buildable. (First run was inconclusive — I'd used a "secret code"
probe that Haiku refused as suspicious; swapped to an innocuous favorite-
color fact and it worked. Test-design fix, not a mechanism problem.)

**Built:** `forkTranscriptAtUserMessage(cliSessionId, userMsgIndex)` in
sessions.js writes a truncated fork beside the original (never touches it);
IPC `session:fork`; `rewindToTurn` loads the fork IN THE SAME pane, so the
prior turns render as REAL bubbles (they're in the forked transcript), later
turns are gone, and the clicked message drops into the composer to edit.
Exactly the desktop behavior.

**Two off-by-one bugs caught (one by me pre-review, one by the review) —
both about the rendered-bubble index the button passes NOT matching the
fork's transcript line count:** (1) the fork counted `<task-notification>`
and empty user lines that transcript.js does NOT render as user bubbles —
common in an orchestrator that spawns subagents — so it'd cut at the wrong
message; fixed by mirroring pushUserTurn's exact predicate. (2) On a
tail-truncated view of a very long session, rendered bubbles start at a
non-zero turn while the fork counts from absolute 0; fixed by gating rewind
to only appear when the full transcript is loaded (`!transcriptTruncated`),
and stopping the "show earlier" handler from hardcoding hiddenCount=0.
Truncation logic unit-tested standalone (incl. task-notif/empty/tool_result
exclusion); async safety, file-write safety, and no-metadata handling all
reviewed clean.

**Known limitation:** the fork has no desktop `local_*.json`, so it won't
appear in the sidebar's session list — it's a working branch, resumable in
its pane but not (yet) catalogued.

## 2026-07-02 — Rewind now happens in the SAME pane (Aidin's call on the constraint tradeoff)

**Decision:** Aidin's review: rewind "switches to a new session instead of
continuing in the same session." Surfaced the hard constraint to him —
`--resume` takes the WHOLE transcript, so "same session" AND "drop future
context" can't both hold; it's genuinely either/or. Asked which he wanted
(AskUserQuestion, with the tradeoff spelled out). He chose **"same pane, fork
underneath"**: rewind now replaces the CURRENT pane in place (no new pane
pops up — feels like going back in this conversation), while underneath it's
still a fresh forked session with prior context replayed, so future context
is genuinely dropped, not just hidden. This is the option that keeps rewind's
unique value (the other option — truly same session via --resume — would
have made it a near-duplicate of the existing double-click-edit-resend, since
it couldn't drop context).

**Implementation:** `openFreshDraftInPane`'s 3rd arg went from a bare
`avoidIndex` to an options object: `{ forceIndex }` (rewind — target this
exact pane) or `{ avoidIndex }` (summarize — don't clobber the pane you're
looking at). Rewind passes `forceIndex: sourceIndex`. The forced pane's view
is replaced by a fresh draft; sending starts a new session (freshPane has no
cliSessionId, so sendFromPane won't --resume) with the replayed context in
the prompt. Rewinding a BUSY pane orphans its in-flight launch exactly like
"+/new chat" already does — consistent, not a new failure mode. The replaced
session's transcript stays on disk, reopenable from the sidebar.

## 2026-07-02 — Review feedback: category-drag regression fixed, mouse back/forward wired

Aidin's review of the backlog batch surfaced two concrete issues (plus a
rewind design question handled separately):

1. **Regression — "can't drag a list anymore."** The drag-collapse feature
   (hide session lists to headers during a category drag) broke dragging
   entirely: hiding the `.section-list` elements SYNCHRONOUSLY inside the
   `dragstart` handler reflows the drag source, which Chromium/Electron
   treats as grounds to cancel the drag outright. Classic gotcha. Fixed by
   deferring the collapse to a `requestAnimationFrame` after dragstart
   finishes (dataTransfer.setData/effectAllowed stay synchronous — they must
   — only the visual collapse is deferred), with a guard against the drag
   already having ended by then. Worth noting: the cumulative review had
   reasoned about whether the collapse disturbed the drop-position MATH
   (it didn't) but not whether the reflow ABORTS the drag — a real-hands-on
   failure a static review couldn't catch.
2. **Mouse back/forward buttons** now drive the focused pane's chat history,
   same as the ←/→ header buttons — a document-level `mouseup` listener on
   `e.button === 3` (back) / `4` (forward).

## 2026-07-02 — Cumulative integration review of the whole backlog batch; one glitch fixed

Aidin asked for a review of all the backlog-pass fixes before his own manual
review. Each feature already had an isolated review when built, so this pass
took the CUMULATIVE / integration angle across the two clusters they share
code in: sidebar (category DnD reorder + drag-collapse + back/forward nav +
deadline chip) and workspace (resizable split + rewind + queue-next-prompt +
event routing + version badge).

**Workspace cluster: fully clean** — no cross-feature bugs. Notably confirmed
the inserted `.pane-divider` element (between panes 0/1) breaks nothing,
because every pane lookup is `[data-pane="N"]`-attribute-based, never
child-index/sibling-based; `pane.els` never goes stale because `renderPane`
(the "done"/transcript-reload path) rebuilds only `.pane-scroll`, not the
composer; and `fireQueuedPromptIfAny` runs synchronously after the identity
guard with no intervening await.

**Sidebar cluster: one medium glitch, fixed.** The 30s `refresh()` timer (or
any session event) could call `renderSidebar()` mid category-drag —
`innerHTML=""` destroying the dragged header and un-hiding the collapsed
lists mid-gesture (a jarring layout jump; not corruption — the HTML5 drag
continues on the detached node and the drop still resolves via the persisted
dataTransfer). Fixed: `refresh()` skips the sidebar rebuild while a category
drag is in progress, gated on a `categoryDragStartedAt` TIMESTAMP (not a
bool) so a drag that somehow never ends self-heals after 30s instead of
freezing the sidebar — dragend clears it in every normal case.

## 2026-07-02 — Resizable split panes (the contained half of the split-view ask)

**Decision:** Split the "split view ska kunna drag-and-dropas som i VS Code +
kunna justeras i bredd" backlog item into its two halves and shipped the
tractable one: a draggable divider between the two panes that adjusts their
relative width (module-level `splitRatio`, clamped 0.2–0.8, applied via
`--left-fr`/`--right-fr` grid vars). The other half — full VS Code-style
dockable/rearrangeable panes — is genuinely larger UI work and stays open
for its own focused session. Pointer-capture drag so tracking survives the
cursor leaving the thin divider mid-drag. `splitRatio` is in-memory (survives
split toggles within a session, resets on restart) — persisting to config is
a noted possible follow-up, deliberately not done to keep v1 contained.

Passed an independent review (pane indexing unaffected by inserting the
divider element between panes, pointer-handler cleanup leak-free, single-pane
layout ignores the stale fr vars). Review flagged one cosmetic issue — a
0-width divider column drew a faint double-seam via the base 1px grid gap on
both sides — fixed by making the divider a real 1px column that IS the seam,
with gap:0 on the split grid.

## 2026-07-02 — Deadline-aware attention sorting from Jot

**Decision:** Jot todos carry an optional `deadline` (epoch ms) — now factored
into the sidebar's attention ranking. `jot.js` surfaces each category's
`nearestDeadline` (soonest deadline among its still-open, non-done tasks,
overdue ones included since they're the MOST urgent). `sessions.js` adds a
tiered boost to `attentionScore` via `deadlineBoost()`: overdue = full weight
(default 80, a new configurable `deadline` weight), <24h = 75%, <3d = 45%,
<7d = 20%, beyond a week = 0 (a deadline that far off shouldn't reorder the
board yet). A "⏰ due in Nd / due today / overdue" chip renders on the row in
BOTH simple and advanced views (unlike the advanced-only Jot-counts chip) —
a bearing-down deadline is high-signal and it's what's reordering the row, so
hiding it in the default view would make the sort look arbitrary.

Verified the full pipeline against real Jot data: the boost math is correct
across all tiers (standalone test), and `nearestDeadline` surfaces correctly
(the one real deadline in the board today is 2027, >7 days out, so it
correctly produces no boost and no chip yet — the machinery is dormant until
a near-term deadline exists, which is the intended behavior, not a bug).

## 2026-07-02 — "Rewind to here": fresh session replaying prior context, since --resume can't retract turns

**Decision:** Mirrors the desktop app's rewind icon, but implemented around
a hard constraint: the CLI's `--resume` cannot retract turns from an
existing session. So instead of editing the old session in place, clicking
"⤺" on a past user message opens a FRESH session/pane whose draft replays
the conversation up to (not including) that message, then the message itself
as an editable draft — future context is genuinely dropped, not just
visually hidden. Prior turns are replayed VERBATIM (not LLM-summarized like
Fas 2's carry-over): a rewind is usually to somewhere recent where the raw
exchange is more faithful than a lossy summary, and it keeps the action
instant and free. Capped at the 30 most-recent prior text turns (with an
"N omitted" note) and 500 chars/turn so rewinding deep into a long chat
can't build a pathological draft. Distinct from the existing double-click-
to-edit-and-resend (which just refills the current composer, appending a new
turn to the SAME session — no context dropped).

**Critical bug caught in review, fixed before shipping:** the shared
`openFreshDraftInPane` → `pickDraftTargetPane` helper, when both panes are
full, fell back to `focusedPaneIndex` and overwrote it in place. Since the
rewind button lives INSIDE a pane (which is focused when you click it), this
meant rewinding in a two-pane layout wiped the very conversation you were
rewinding from. (Latent gap the summarize feature shared but rarely hit,
since summarize is triggered from the sidebar with a free pane usually
available.) Fixed by threading an `avoidIndex` through so the fallback picks
the OTHER pane, never the source; verified across 5 pane-layout scenarios
plus the draft-building logic across 3 (excludes future turns + tool noise,
caps correctly keeping most-recent, handles zero-prior-context first
message). The clobber was never real data loss — the session's transcript on
disk is untouched and reopenable — but it was destructive to the pane view
and exactly the wrong pane.

## 2026-07-02 — Drag-and-drop reorder for categories themselves, not just sessions

**Decision:** Categories/lists in the sidebar could never be reordered
relative to each other before — only sessions within a category could be
dragged. Added the same VS Code-style reorder to category headers: a
distinct dataTransfer type (`"text/category-label"`, never
`"text/session-id"`) so it can never be confused with session-row dragging
that already lives on the same header element (dropping a session onto a
category header still appends it there, unchanged). Reuses the exact
zero-layout-impact pseudo-element indicator technique already proven for
session rows, just scoped to `.section` instead of `.row`. Only the header
itself is draggable, not the whole (session-count-dependent, sometimes very
tall) section — a small fixed-size handle is far easier to aim than judging
"top half vs bottom half" of a 30-session category.

**Real bug caught in review:** the session-row's own `dragover`/`drop`
handlers had no guard against a CATEGORY-type drag landing on them — so
dragging a category header over an unrelated session row (in a different
category's list) falsely showed a session-row drop indicator that would
never actually do anything (the row's drop handler already no-ops on a
missing `text/session-id`, so no data corruption, but the UI lied about
having a valid target here). The same gap existed in `wireListDropZone`
(empty list space). Fixed by adding an early `types.includes("text/category-
label")` guard to both.

Splice-based reorder math unit-tested standalone (6/6 scenarios) before
shipping; DOM/event integration passed an independent review.

## 2026-07-02 — Backlog pass: version numbering, pinned card, split-icon fix, queue-next-prompt, chat history nav

Working through the priority-0 Jot backlog. Five shipped this pass, each
boot-tested and independently reviewed:

1. **Version numbering** (`src/lib/version.js`) — same scheme as Crewline
   (major.minor hand-bumped in `package.json`, a trailing number that's
   actually a commit count since that bump so it resets to 0 on every bump
   instead of growing forever). Crewline computes this at Vite build time;
   Helm has no bundler, so it runs once at app startup via `git log -1
   -S... -- package.json` + `git rev-list --count`. Verified end-to-end
   against the real repo (`v0.1.32`) before wiring into the UI. Review
   caught the pickaxe search string being too loose (`"0.1` would also
   match `0.10`, `0.11`, `0.1.5`) — fixed with a trailing-dot anchor,
   re-verified after the fix.
2. **Split-view icon fixed a self-inflicted collision** — it was "⧉", the
   exact same glyph used for the copy button (added a few commits ago in
   the Tier 3 pass, without noticing the reuse). Changed to "◫".
3. **Orchestrator card now genuinely pinned** — it was the first child
   appended INSIDE the scrollable `#sidebarBody`, so it scrolled out of
   view with everything else despite being called "pinned." Moved to a new
   sibling `#sidebarPinned` div above the scroll area.
4. **Queue next prompt** ("flika in" scenario 2 from Aidin's clarification:
   queue a follow-up to run once the current job finishes, distinct from
   scenario 1 — inject info into a run that's already happening — which
   still needs the persistent-process architecture decision). Typing while
   a pane is busy and pressing Enter now queues instead of silently
   discarding the text (a real pre-existing bug: Enter-while-busy called
   the SAME handler as Stop, which never read the textbox at all — so
   typing + Enter while busy used to both lose your text AND kill the run).
   Fires through the exact same `sendFromPane` path once "done" arrives, no
   duplicated send logic.
5. **Back/forward chat navigation** between chats opened in a pane, browser-
   tab style. History lives in a module-level map keyed by pane INDEX, not
   on the pane object (which gets fully replaced on every navigation).
   Review caught two real bugs: `navigateHistory` advanced its position
   pointer before confirming the target session still existed, silently
   desyncing the buttons from what was actually navigable if a session in
   history had been archived/removed — fixed to walk past dead entries
   instead of committing to one blindly. And `paneNavHistory` was cleared on
   split-close but NOT on "New chat" (either the sidebar button or the
   pane-header reset) — an inconsistency, now fixed in both places.

## 2026-07-02 — Fix the last bullet-list spacing gap; "tight" transition out of a list

**Decision:** New feedback on the already-fixed bullet spacing: the
transition INTO a list got a deliberate gap (`.md-li`'s own `margin-top`),
but the transition OUT of one — the line right after the last bullet,
resuming prose or a bold lead-in — got nothing, since a plain `<span>` has
no margin rule at all. It sat flush against the last bullet with only
incidental line-height between them, reading as "tight" next to every other
spaced transition in the same bubble. Fixed with a new `.md-after-list`
class (mirrors `.md-li`'s own 10px) applied when the nearest actual content
line above (skipping blank separators) was a list line.

**Two real bugs caught in review before shipping**, both in the SAME spot as
the earlier bullet-spacing fix: `precededByListLine`'s single-line lookback
missed the common case of TWO OR MORE consecutive blank lines between a list
and the next paragraph — only the first blank got skipped, the rest
re-rendered as ordinary empty lines, reintroducing the doubled-gap problem
the earlier fix existed to solve, this time compounded by the new margin.
Fixed by generalizing to a bidirectional `nearestContentLine(lines, idx,
direction)` walk used by BOTH the blank-line-skip check and the after-list
detection — now correct for any number of consecutive blanks. A second
flagged concern (that a preceding `<br>` might stack with `.md-after-list`'s
`margin-top`, making the gap larger than the into-list case) was
investigated and did NOT reproduce — traced the control flow by hand and
confirmed empirically (6 scenarios via a standalone DOM-trace script) that
no `<br>` is ever emitted immediately before an after-list span, so the two
gaps ARE symmetric as intended.

**Also cleaned up two misplaced Jot cards while triaging in-progress**: a
drag-and-drop comment ("konstiga markeringar") had landed on the unrelated
interject-during-execution task again (second time this exact card has had
stray feedback attached) — rerouted to the DnD task, then the user confirmed
it was itself a misfire and it moved back to review with no code change.
Two other in-progress items (the blocking-input UI, the interject feature)
moved back to open — no new feedback, still genuinely blocked on an
architecture decision, not something actively being worked.

## 2026-07-02 — Second review round (Opus) over the shipped Tier 1-3 fixes: 3 more real issues

Aidin (back on Opus) asked for a verification pass over everything Sonnet
shipped for the 15 review findings, plus a fresh review round. The per-batch
reviews each saw only their own batch; this round deliberately took the
CUMULATIVE / integration angle (the three tiers all touched the same
renderer event handler + main.js lifecycle) and re-read the final combined
state. It confirmed all 15 tier fixes are sound AND surfaced three genuine
issues the isolated reviews structurally couldn't see:

1. **`before-quit` killed children asynchronously — losing the race against
   the app's own exit** (`main.js`). The Tier-1 quit sweep called the async
   `taskkill` form and didn't await, so the app could tear down before the
   kill actually ran — orphaning the very process tree the sweep exists to
   clean up (the Stop-button path was fine; only quit was affected). Notably
   the Tier-1 per-batch review had explicitly dismissed this ("fired
   async/best-effort... not a concern") — a fresh adversarial pass caught
   what a confirm-the-fix pass didn't. Fixed with a synchronous `execFileSync`
   kill on the quit path only.

2. **`fs.readSync`'s return value was ignored in the transcript tail read**
   (`transcript.js`). Node explicitly warns the buffer may not be fully
   filled; a short read would leave `Buffer.alloc`'s zero-fill as NUL bytes
   appended to the last line, which then fails `JSON.parse` and silently
   drops the most recent turn(s). Low-probability (only under a concurrent
   truncation of the file), but the fix is unambiguous: decode only
   `buffer.toString("utf8", 0, bytesRead)`.

3. **"Summarize & carry over" silently drove the judge + usage analytics**
   (`main.js` + `renderer.js`) — the highest-value find, and a textbook
   cross-batch defect. The summarize feature (Fas 2, built BEFORE the
   model-fit judge and usage analytics existed) resumes a session via the
   same `startSession` path, so every summarize spent a real ~$0.015 judge
   call AND injected a synthetic run — hidden carry-over prompt, model forced
   to sonnet-5 — into the exact By-model / Model-fit / Suggestion-accuracy
   views the app is built to surface. No isolated review could see it: it's
   the interaction of a feature from one era with a pipeline from another.
   Fixed with an `internal: true` flag threaded startSession -> IPC ->
   main.js that suppresses the usage log, the completion notification, and
   the judge for Helm's own internal launches (the renderer still gets its
   `done` event, which the summarize callback needs).

Both fresh reviewers otherwise confirmed the shipped work clean: the
pane-routing consolidation integrates correctly across all three batches, no
map leaks, no reentrancy, the atomic archive write / config deep-merge /
judge output-cap all hold against the probed edge cases. Per Aidin's
explicit say-so this one time, all 15 finding tasks moved to done (normally
they'd sit in review for his own check).

## 2026-07-02 — Tier 3 fixes from the full-app review: polish/a11y (closes the review)

**1. config.js deep-merge for nested defaults** — a shallow
`{...DEFAULT_CONFIG, ...parsed}` meant a config.json with a partial
`jot`/`modelFitJudge`/`archiveSuggestions` object silently dropped the other
default sub-keys. Now merges those three (the only fixed-shape nested
defaults — everything else is a free-form map/array where shallow replace
is correct) one level deep.

**2. paths.js skips symlinks in the session-directory walk** — a symlinked
subdirectory reports `isDirectory()` true, so a symlink cycle under the
session-storage tree would re-walk the same target repeatedly until the
existing depth guard finally stopped it. Real subdirectories there are never
symlinks (it's app-managed storage), so skipping them outright has no
downside.

**3. Stop-vs-natural-completion race** — a process finishing naturally in the
small window between a Stop click and the IPC call landing still showed
"⏹ Stopped." even though it completed normally, because the check was
`pane.stopRequested` alone. Now also checks `!evt.summary?.sawResult`
(confirmed in `launcher.js`: only set when the CLI itself emitted a genuine
`result` event) — a stop-click race that turns out to have actually finished
is now correctly treated as a completion, not a stop.

**4. Context-menu keyboard/UX** — three small additions: Escape now closes
the context menu (previously only an outside click did; verified no conflict
with the inline-edit input's own Escape handling, which stops propagation
before it can reach this new document-level listener); the "Move to
category" submenu now flips to the left side when it would overflow past the
right edge of the window (right-clicking a row near the edge used to push it
off-screen with no way to reach it); the copy button under an assistant
reply is now visible on keyboard focus, not just mouse hover (previously
invisible to keyboard/touch entirely).

**Investigated, not changed:** the inline-edit "blur commits the edit"
behavior the review flagged — re-read `makeInlineEditable`'s own doc comment
and found this is already-intentional, already-documented design (Enter/blur
commit, Escape cancels — Escape-to-cancel was already correctly wired, just
not what the review initially assumed was missing). Left as-is rather than
change a working, deliberate behavior. Full keyboard arrow-navigation
through the custom context menu/dropdown was scoped OUT of this pass — a
real accessibility gap, but a larger UI undertaking than "polish," better
addressed as its own piece of work if it matters enough to prioritize.

All 4 fixes passed an independent review — no new bugs found. **This closes
the full-app review**: 15 findings across 3 tiers, all fixed and verified.

## 2026-07-02 — Tier 2 fixes from the full-app review: robustness/degradation

**1. Unbounded transcript read** (`transcript.js`) — a huge .jsonl file was
read whole into memory then doubled via `split("\n")`, blocking the main
process. Now caps the read to the trailing 8MB via a byte-offset `readSync`
(mirrors sessions.js's own 96KB tail-read technique, sized for actually
rendering chat instead of just checking the last message's role), dropping
the resulting partial first line. Caught two of my own mistakes before
shipping: `hiddenCount` could go negative when the tail window happened to
produce fewer turns than `maxTurns` (fixed with a `Math.max` floor), and
review flagged `totalLines` silently changing meaning (whole-file count →
partial-window count) once the cap could kick in — renamed to `linesRead`
since nothing in the codebase consumes the field today, so the honest name
costs nothing.

**2. Judge had no timeout** (`judge.js`) — a hung Haiku call (network stall,
an auth prompt with no TTY to answer) left the child running forever and the
fire-and-forget promise dangling. Added a 30s timeout that kills the child
and resolves `null`, a 1MB output cap, and a `settled` guard so a
timeout-then-close race can't resolve twice.

**3. backgroundTasks — unbounded growth + dropped out-of-order events**
(`renderer.js`) — the only removal path was the manual "Clear finished"
click, and `task_progress`/`task_updated`/`task_done` for a taskId with no
prior `task_started` (this stream has no delivery-order guarantee) were
silently ignored, making that task permanently invisible. Added an
auto-prune for terminal tasks older than an hour, and `getOrCreateBackgroundTask()`
so those three event kinds backfill a placeholder instead of dropping the
event. Caught a real bug myself before the review even ran: `task_started`
unconditionally overwrote whatever was already there, including a
just-backfilled TERMINAL placeholder from an out-of-order `task_done` — a
demonstrably-finished task could get un-finished back to "running" forever.
Fixed by skipping the overwrite when the existing entry is already terminal.

**4. summarize/pendingLaunchCallbacks had no timeout** (`renderer.js`) — if
a summarize launch's "done"/"error" never arrived, `summarizeAndCarryOver`
awaited forever and the pane's status line stuck on "Summarizing…"
permanently. Added a 5-minute timeout that resolves an error and cleans up
the map entry.

**5. Table-cell splitter broke on pipes in inline code/escapes** (`renderer.js`,
`tableCells`) — `line.split("|")` treated every `|` as a column delimiter,
so a cell like `` `Set-Cookie: a|b` `` or an escaped `\|` misaligned the
whole row. Replaced with a char-by-char parser that treats a pipe inside a
backtick span, or escaped as `\|`, as literal content. Unit-tested standalone
(5/5 cases) before shipping.

**Investigated, not changed:** the review also flagged the code-fence
info-string strip (`renderMarkdownInto`) as possibly eating a real content
line when a fenced block has no language tag and its first line is a bare
token. Traced through the actual regex behavior for both the "language tag
present" and "no language tag" cases by hand — in both, only the true
info-string line is stripped, matching CommonMark's own spec (whatever text
follows the opening fence up to the first newline IS the info string, by
definition — there's no way to distinguish "real code" from "info string"
that lands on that exact line, because in well-formed markdown they're the
same line and even CommonMark itself doesn't try). Left as-is rather than
"fix" something that traced out to already be spec-correct.

All fixes passed an independent review; only the `totalLines`/`linesRead`
naming issue survived as a real (if currently inert) finding, fixed above.

## 2026-07-02 — Full-app review (4 parallel Opus reviewers), Tier 1 fixes shipped

**Context:** ran a whole-codebase review (main process/IPC, data/read layer,
renderer state/lifecycle, renderer DOM/CSS/UX — 4 independent reviewers, no
sub-agents), synthesized + personally verified the top findings against the
actual code, then ranked everything into Tier 1 (real bugs) / Tier 2
(robustness/degradation) / Tier 3 (polish/a11y). All 15 findings filed in
Jot at priority -2. Fixing all of them in order per Aidin's explicit ask.

**Tier 1, shipped this batch (6 fixes):**

1. **Stop didn't kill the process tree on Windows** (`main.js`) —
   `child.kill()` only signals the top-level `claude.exe`; its own children
   (model runtime, MCP servers, subagents) survived and kept running/costing
   subscription usage. New `killChildTree()` uses `taskkill /pid <pid> /T /F`
   on win32. **Verified empirically**, not just by reading the code: spawned
   a real 2-level process tree, confirmed plain `kill()` left an orphan
   (before=16, after=17) and `taskkill /T /F` cleaned up fully (after=17,
   back to baseline).
2. **Nothing killed live children on app quit** — added an `app.on("before-
   quit")` sweep over `liveChildren` using the same `killChildTree()`.
3. **Unprotected post-run bookkeeping could strand a pane as "running"
   forever** — `done.then(...)` used to run `appendUsageLog`/Notification/
   judge-kickoff BEFORE sending the `done` IPC event; a throw in any of them
   (corrupt config, disk-full log write) meant the renderer never got
   unblocked. Now `send({kind:"done"})` fires first, and everything after it
   is wrapped in try/catch (+ a `.catch()` on the judge's own promise chain).
4. **Archive write was non-atomic against another app's live file**
   (`sessions.js`) — `writeFileSync` truncates-then-writes; a crash/disk-full
   mid-write could corrupt the desktop app's own session file. Now writes to
   a temp file in the same directory + `renameSync` (atomic same-volume),
   with best-effort cleanup if the rename itself fails. Verified the temp
   name's shape (`.<file>.<hex>.tmp`) is invisible to every directory scan
   that looks for `local_*.json`.
5. **Orphaned launch could bleed into an unrelated new session, and the
   error path leaked forever** (`renderer.js`) — the biggest structural fix.
   A separate `paneLaunchMap` (launchId→index, no identity check) routed
   every launch-scoped event, and its own cleanup only ran on `done`, never
   on `error` — an unbounded leak on every failed launch. Removed entirely;
   ALL launch-scoped events (session/tool_use/assistant/error/done/modelFit)
   now route through the existing `launchPaneHistory` map with the identity
   check (`panes[index] === pane`) already used elsewhere in this codebase.
   `quota` was pulled out of the pane-gated switch too — it's app-wide and
   was being silently dropped whenever the routing lookup failed for
   unrelated reasons.
6. **`pruneStaleLaunchHistory`'s blind time cutoff became a correctness
   risk** once launchPaneHistory became the ONLY routing table (previously
   it only fed the model-fit judge, where losing an entry early was a
   cosmetic miss at worst) — a long xhigh-effort prompt running past the
   10-minute cutoff would have had its entry pruned mid-run, silently
   dropping its remaining events. Fixed: never prune an entry whose pane is
   still attached AND still busy; only the time cutoff applies once a launch
   is actually finished or orphaned.

All 4 fixes passed an independent review pass (main-process integration,
atomic-write correctness, and the full renderer-routing consolidation with
its 4 specific correctness questions) — no new bugs found.

## 2026-07-02 — Drag-and-drop reorder: full rewrite (single source of truth + zero-layout indicator)

**Decision:** After two partial fixes didn't fully resolve "reorder is
sporadic / doesn't land where I drop it," rewrote the interaction rather than
patch it a third time. Two root causes, both now gone:

1. **The indicator was a real block element inserted into the list flow**
   (`row.before(line)`). Even inert (`pointer-events:none`), it took vertical
   space, so every row below shifted and every `getBoundingClientRect()` on
   the next `dragover` was offset — a feedback loop that could flip the
   insertion point with a stationary mouse. Now the indicator is a pure CSS
   class drawing an absolutely-positioned `::before`/`::after` line (`.row`
   is `position:relative`), which takes zero space and never reflows.
2. **Drop recomputed the position from a fresh rect** (`nextRowSessionId`),
   a second measurement independent of what the indicator showed — so once
   layout had shifted, the drop could land somewhere other than the line.
   Now a module-level `dropTarget = {row, before}` is set in `dragover` and
   read verbatim by `drop`. Single source of truth: the drop acts on exactly
   the indicator you saw.

**Edge cases handled:** dropping onto the row you're dragging is a true
no-op (guarded in both `dragover` and `drop`); "after row X" skips a trailing
`.dragging` sibling so dropping just below the dragged item isn't an
off-by-one move; `clearDropIndicators()` is document-wide (required — a
cross-category drag must clear the previous list's marker) and called before
every marker add, so exactly one shows at a time; `dragend` is the catch-all
reset for Escape / drop-outside-any-zone, so no stale `dropTarget` survives
into the next drag.

**Verification:** the pure index-reorder math was unit-tested standalone
(9/9 scenarios incl. adjacent no-ops) and the DOM/event/state lifecycle
passed an independent review across all four drop paths. Removed
`insertion-line` / `nextRowSessionId` / `clearInsertionLines` entirely.
Still needs Aidin's hands-on confirmation that the *feel* is finally right.

## 2026-07-02 — Root-caused the bullet-spacing bug; partial fix for sporadic drag-and-drop; Archive page split into 2 columns

**Bullet spacing, actually fixed this time:** the earlier `.md-li + .md-li`
CSS rule (shipped a few commits ago) never actually did anything — it just
looked like it should. `renderInlineLines` unconditionally inserted a `<br>`
after every line (list or not) and rendered every blank line as an empty
`<span>`, so real assistant output with blank lines between bullets produced
`<div class="md-li">...</div><br><span></span><br><div class="md-li">...`.
A `<br>`/`<span>` sitting between two `.md-li` divs means they are not
adjacent siblings, so `.md-li + .md-li` could never match. Fixed at the
source: blank lines touching a list line are now skipped entirely (they're
pure markdown separation, not content), and a `<br>` is only ever inserted
between two consecutive PLAIN-TEXT lines — never immediately before/after a
list item, since a `display:block` div already forces its own line break.
Verified with a standalone DOM-trace script before shipping (five cases:
blank-separated list, non-blank list, plain multi-line text, blank-separated
paragraphs, heading-then-list) — non-list rendering is byte-for-byte
identical to before, only the list-adjacency case changed.

**Drag-and-drop reorder, partial fix:** "still very sporadic" after the
earlier `pointer-events: none` fix. Real remaining cause: the dragover
handler unconditionally removed and re-inserted the insertion-line indicator
on EVERY dragover event (which fires continuously, far more often than the
mouse crosses a row's midpoint) — inserting that line shifts the list's
layout, which shifts every row's `getBoundingClientRect()` for the NEXT
event, creating a feedback loop that could flip the insertion point even
with a stationary mouse. Fixed by skipping the DOM mutation when the line is
already exactly where it belongs. **Honest caveat:** this fixes
dragover-loop-induced flicker specifically; it does NOT touch the
drop-time midpoint recalculation in `nextRowSessionId`, which could still
occasionally disagree with what was last shown if the mouse moves fast
between the last dragover and the drop. If it's still not fully reliable
after this, the more thorough fix is caching each row's position once at
drag-start instead of re-measuring live throughout the drag.

**Archive page:** the two sections (Archived / Removed from Helm) now sit
side-by-side in the same 2-column grid the Analysis page already uses,
instead of stacked vertically.

## 2026-07-02 — New "Archive" page: see and restore hidden/archived sessions

**Decision:** Added a 4th header tab, "Archive," with two sections —
"Archived sessions" (`isArchived: true`, real desktop-app state; an
"Unarchive" button flips it back via the existing `session:archive` IPC
handler with `archived: false`) and "Removed from Helm" (sessions in
`config.hiddenSessions`; a "Restore" button removes the id from that array).
No new IPC or data source needed — both flags were already tracked, there
was just no UI to see or undo either one before now (archiving/removing were
one-way outside manually editing `config.json`).

**Why:** direct request after shipping manual archiving — "we need a page to
see all hidden + archived sessions to get them back if needed." Both
"hide" actions were one-way by design (a deliberate choice at the time,
documented above), but that only works long-term with an undo path, which
didn't exist until now.

**Bug caught in review:** the two flags (`isArchived`, `hiddenSessions`) are
independent — a session could be both archived AND hidden, which would have
listed it in both sections with two unrelated "get it back" buttons.
Archived sessions are now excluded from the "Removed from Helm" list;
unarchiving is enough to see it again here, even if it's separately still
hidden from Helm's own sidebar.

## 2026-07-02 — Jot-review fix batch: bullet spacing, icon-only copy button, a real DnD drop bug, image lightbox

**Bullet-list spacing:** a side-by-side vs. the desktop app showed the gap
after a heading was right but consecutive bullets read as too tall. Each
list line renders as a standalone sibling `<div class="md-li">` (no `<ul>`
wrapper), so `.md-li + .md-li { margin-top: 4px }` (down from the uniform
10px) tightens only "bullet right after another bullet" while leaving the
gap after a heading/paragraph untouched.

**Copy button:** changed from an always-visible "Copy" text button under
every assistant reply to an icon-only button (⧉ / ✓), invisible until the
row is hovered.

**Real bug in drag-and-drop reordering:** category reordering "worked but
jumped and didn't always land where I dropped it." Root cause: the visual
insertion-line indicator shown between rows is a sibling `<div>` with no
drop handler of its own. Dropping exactly ON the line (the natural thing to
do — it's what "drop here" is pointing at) made the line itself the drop
event's `e.target`; the list container's own drop handler bails via an
`e.target !== el` guard meant for a *different* case (append-on-empty-space),
so the drop was silently swallowed. Fixed with `pointer-events: none` on
`.insertion-line` so drag/drop events pass through to whatever's actually
underneath.

**Image lightbox:** attachment chips now show a real thumbnail (via a new
`toFileUrl()` path→`file://` converter) instead of an emoji; clicking it
opens a full-screen enlarged view. Needed `img-src 'self' file:` added to
the CSP meta tag. Review caught a real bug in `toFileUrl`: it
`encodeURIComponent`'d every path segment including the drive letter,
turning `D:` into `D%3A` — Chromium does not decode that back to a drive
letter, so every thumbnail would have silently failed to load. Fixed by
leaving a bare `<letter>:` segment un-encoded; verified the corrected output
resolves via `new URL(...).pathname` before shipping.

## 2026-07-02 — Confirmed: mid-turn interjection genuinely works (not just between-turns) — architecture change, not built tonight

**Finding:** `spike/test-mid-turn-interject.mjs` sent a first message asking
the model to run `sleep 6 && echo done` via Bash, then wrote a SECOND stdin
message the moment the Bash tool_use event appeared — well before that
turn's `result` event. The final reply was `DONE1\n\nHELM_INTERJECT_SEEN`:
the interjected instruction ("say HELM_INTERJECT_SEEN") was genuinely
picked up and honored WITHIN the same in-progress turn, not queued for a
separate next turn. This is a real answer to the open "flika in med extra
info under körning" Jot task — `2026-07-01`'s spike only proved multi-turn
works BETWEEN completed turns; this is the first confirmation the actual
"interject while running" case works at all.

**Why not built tonight:** using this means switching a pane's session from
"spawn a fresh `-p` process per message" to "hold one persistent
`--input-format stream-json` process per pane for its whole conversation."
That touches Stop (currently: kill the process — would need to become "send
an interrupt within the persistent process" or similar), the model-fit judge
(currently fires from a one-shot process's exit), usage logging, and resume
semantics, all of which are hardened and working well right now per tonight's
and Aidin's own testing. This is real architecture surgery across several
already-verified code paths, not an evening feature — flagging for Aidin's
go-ahead on approach rather than autonomously rewiring the core launch
mechanism.

**Also verified, not previously known:** a long-running Bash tool call (the
6-second sleep) triggered `task_started`/`task_notification` system events —
the same lifecycle previously thought to be Agent/Task-tool-only. Not
investigated further tonight; worth knowing if the Background Tasks panel
should also reflect long individual tool calls, not just subagents.

**Honest note on how long this took:** spent well over half an hour chasing
a phantom "intermittent ENOENT spawning claude.exe" before finding the real
cause — the spike file was originally written via a bash heredoc
(`cat > file << 'EOF'`), which silently collapsed `"D:\\Repo\\Tools\\helm"`
into a single-backslash string. `\R`, `\T`, `\m` are not recognized JS escape
sequences, so the literal cwd string became `"D:RepoToolshelm"` — an
invalid path, which Windows' CreateProcess surfaces as ENOENT on the
executable, not as an invalid-cwd error. This looked exactly like
"environment/sandbox flakiness" for a long time because it was NOT
consistently reproducible with structurally-similar test scripts written
correctly. Lesson: **write files with backslash-heavy Windows path strings
via the Write/Edit tool, never a bash heredoc** — this is now the second
time in this project a heredoc silently mangled backslashes (the first
being a Jot-update script earlier tonight).

## 2026-07-02 — Generalized image-paste to "attach any file," and closed the suggestion-heuristic feedback loop

**Decision (attachments):** The image-paste mechanism generalized cleanly to
plain files — a new 📎 button opens a file picker (`dialog:pickFiles`,
multi-select) and attaches by path exactly like a pasted image
(`[Attached file: <path>]` vs `[Attached image: <path>]`, based on extension).
Renamed `pane.pendingImages` → `pendingAttachments` throughout. No new
mechanism needed — this was always going to work the same way, images just
happened to be the first case.

**Decision (suggestion accuracy):** Closes the open "periodically analyze
whether the right model was suggested" task with a pull-model report instead
of a background job — added a `launchId` field to both the `"run"` and
`"modelFitVerdict"` usage-log entries so they can be joined per-run (not just
matched by model+time proximity), and a new "Suggestion accuracy" block on
the Analysis page comparing judge verdicts for runs where the auto-suggestion
was followed vs. overridden. If overriding scores better, that's a direct
signal `suggest.js`'s heuristic needs work — the report says so plainly
instead of hedging.

**Why a report instead of a cadence/trigger:** "do a periodic analysis" needs
a cadence decision (daily? weekly? after N runs?) that's Aidin's call, not
mine to guess. A report that's always current and one click away sidesteps
needing that decision at all, and the data foundation (`followedSuggestion`)
already existed — this was just never joined into something readable.

Both features (paste generalization, suggestion accuracy) passed independent
code-review agent passes before committing. The suggestion-accuracy review
caught a real bug: `launchId` was `++launchSeq`, an in-memory counter that
resets to 0 on every app restart, while `usage-log.jsonl` persists forever —
a verdict whose write got delayed past a NEW session's reused small integer
(e.g. both sessions' first run being `launchId: 1`) could join to the WRONG
run. Fixed by switching `launchId` to `crypto.randomUUID()` — it was already
used as an opaque Map key everywhere (IPC payload, `liveChildren`,
`paneLaunchMap`, `launchPaneHistory`), never arithmetic, so this needed no
other change.

## 2026-07-02 — Real archiving: manual (context menu) + "orchestrator proposes, you approve" (opt-in sidebar pill)

**Decision:** Two paths, both requiring an explicit click every time:
1. **Manual** — right-click a session -> "Archive session" -> two-step
   confirm (same pattern as "Delete category"; no native `window.confirm()`,
   unreliable in this build) -> writes `isArchived: true` to that session's
   own `local_*.json` in the desktop app's session-metadata folder.
2. **Suggested** — a new, default-OFF setting
   (`config.archiveSuggestions.enabled`). When on, idle sessions with no open
   Jot review/in-progress/open work get a small "Archive?" pill in the
   sidebar row. Clicking it archives immediately — the pill IS the proposal,
   the click IS the approval. Never suggested for the Helm-building
   session itself (idle between long autonomous stretches isn't "done").

Neither path ever archives without a click in the moment. There is no
background timer or heuristic that archives on its own — matches Aidin's
"föreslå och så godkänner jag" (propose, and I approve), read literally: the
proposal is a UI affordance, not an autonomous action needing a separate
approval round-trip.

**Implementation:** `setSessionArchived()` in `src/lib/sessions.js` — scans
the session-metadata dir for the file whose `sessionId` matches, flips
`isArchived`, and writes back with `JSON.stringify(meta)` (no pretty-print)
to match the app's own compact format instead of needlessly reformatting a
file another app owns. New `session:archive` IPC handler + preload bridge.

**Known, NOT-yet-verified risk — flagging per the "verify before theorizing"
lesson from earlier tonight:** this write goes through `%APPDATA%`, and every
time Helm has been rebooted for testing *tonight* it was launched via a
`npm start` spawned from this chat session's own Bash tool. If Claude Code's
own process is MSIX-sandboxed on this machine (a real, previously-confirmed
gotcha — see `feedback_verify_before_theory.md`), a write from a
Claude-spawned Helm instance could land in an invisible sandbox overlay
copy of that `%APPDATA%` path instead of the real file the desktop app reads
— meaning archiving could report success while doing nothing the real app
ever sees. **I did not test the actual write against real session state
tonight, because doing so through a Claude-spawned Helm instance would not
be a trustworthy test** (my own tool round-tripping with itself is exactly
the false-positive pattern that lesson warns about). Boot-tested for crashes
only. **Needs Aidin to verify once**: launch Helm normally (not through a
Claude Code session), archive a real disposable/old session, and confirm it
actually disappears from the *desktop app's own* sidebar — not just
Helm's.

## 2026-07-02 — Image paste: shipped via file-path reference, not base64-in-stream-json

**Decision:** Paste an image into the composer -> it's saved to
`pasted-images/` (repo-local, gitignored) and its absolute path is prepended
to the prompt as `[Attached image: <path>]`. No other change to the
architecture: still the same `-p`/`--resume` CLI-wrapping flow, same
subscription auth, same model-fit judge.

**Why this works:** Claude Code's own `Read` tool already reads image files
given a path — the agent loop naturally opens an attached screenshot the same
way it would open one you mentioned by hand. Verified empirically before
building anything (`spike/test-image-via-path.mjs`): pointed a fresh `claude
-p` call at a real Helm screenshot with unpredictable content (a dropdown
mid-interaction) and asked it to name the highlighted option and list the
others in order. It called `Read` on the exact path and answered correctly
("Auto mode" highlighted, all 5 options in the right order) — not a guessable
answer, so this wasn't the model coincidentally describing something
plausible.

**Why not the earlier `stream-json` base64-block approach:** already tested
2026-07-01 (see the now-superseded entry below) — the CLI's stream-json input
does not accept inline image content blocks; the model reported
`HELM_NO_IMAGE`. The `--file file_id:relative_path` flag hinted at an
upload-and-reference flow, but never needed investigating further once the
much simpler "just save it and mention the path" approach was confirmed to
work with zero new surface area.

**Why not the Agent SDK (`query()`) route, mirroring how Reinmaker does image
paste:** would mean a second, parallel code path with its own auth
verification, skill/CLAUDE.md loading config, and resume semantics — real
migration cost for a problem the file-path trick already solves with the
existing, already-hardened wrapper. Revisit only if some future need (e.g.
truly ephemeral images that must never touch disk) makes the file-path
approach unworkable.

**Implementation:** `src/lib/images.js` (`savePastedImage`,
`prunePastedImages` — 7-day cleanup on app start, since these are throwaway
clipboard pastes that can contain anything on screen), new `image:save` IPC
handler, composer `paste` listener + attachment chips in
`src/renderer/renderer.js`.

## 2026-07-02 — Fas 2 core built: "Summarize & carry over," real archiving deliberately NOT touched

**Decision:** Built the context-flow half of Fas 2 (right-click a session ->
"Summarize & carry over to new chat") — resumes the session once with a hidden
handoff-summary prompt, captures the reply, and pre-fills a fresh session's
composer with it. Verified end-to-end on a throwaway test conversation before
shipping: the summary was genuinely well-structured and even pulled in
ambient repo context (git branch, uncommitted files) beyond the literal
chat history.

**Deliberately did NOT build:** an in-Helm "Archive" action. Real archiving
means flipping `isArchived` in the desktop app's own `local_*.json` session
file — writing to another app's live state, which is exactly the kind of
action flagged as needing explicit confirmation, not something to do
autonomously while Aidin is away. Helm's existing "Remove from Helm"
(hides via config.json only) remains the only session-hiding mechanism until
real archiving is explicitly requested and scoped carefully.

**Why this order:** the context-flow half directly unblocks Aidin's stated
goal ("archive more aggressively once I don't lose the thread") without
touching anything outside Helm's own repo — pure upside, no destructive
risk. Real archiving is a separate, smaller, but riskier follow-up.

## 2026-07-02 — Model-fit judge: Haiku, non-bare, cost reduced ~78% by stripping tools/MCP

**Decision:** After every completed prompt, fire a separate cheap `claude -p`
call (Haiku, effort low) that judges whether the model/effort choice was
`too_weak` / `appropriate` / `too_strong`, using `--json-schema` for a
structured verdict. Fire-and-forget — never delays the real response, and
skipped if the run was stopped early (nothing meaningful to judge).

**Cost investigation (measured, not assumed):**
- Naive non-bare Haiku call: **$0.068/call** (~32k cache-creation tokens).
- `--bare` would cut this further but was rejected outright: it hard-codes
  `ANTHROPIC_API_KEY`-only auth, bypassing the subscription entirely — not
  worth it for a background feature.
- `--system-prompt` (replacing the default system prompt, still non-bare):
  $0.068 → $0.053 (~22% cut). CLAUDE.md/default-prompt bulk wasn't the main
  cost.
- Adding `--allowed-tools ""` + `--mcp-config '{"mcpServers":{}}'
  --strict-mcp-config` (the judge needs zero tools — it only emits JSON): **
  $0.068 → $0.015, a 78% cut.** The bulk of the cost was tool/MCP-server
  schema definitions (Aidin has several MCP servers configured) being sent on
  every non-bare invocation regardless of system prompt size — not CLAUDE.md.

**Why this matters beyond this feature:** any future "small utility call"
(judge, classifier, summarizer) that doesn't need tools should use this same
recipe (`--system-prompt` + empty `--allowed-tools` + empty
`--strict-mcp-config`) to stay cheap without giving up subscription auth.

**Toggle:** `config.json`'s `modelFitJudge.enabled` (default `true`, per
Aidin's explicit request "efter varje färdig prompt"). Set `false` to disable
if the recurring cost isn't worth it later.

Working name: **Helm** — a personal orchestrator harness over Claude Code
sessions. Placeholder name; cheap to rename before there is git history.

## 2026-07-01 — Stop = kill the child process; interject mid-run deferred

**Decision:** "Stop" kills the in-flight `claude -p` child process directly (no
architecture change needed — the existing one-shot-per-send model already
holds a process handle). "Interject extra info while a turn is running" is
NOT implemented yet.

**What was verified:** `--input-format stream-json` gives the CLI a real
persistent multi-turn mode — spiked in `spike/test-stream-input.mjs`: sent a
first user message, waited for its `result`, then sent a second message on the
SAME process and got a second `result`. Confirms `--resume`-per-send isn't the
only option; a pane COULD hold one long-lived process across a whole
conversation instead of respawning per message.

**Why deferred anyway:** the spike only proves a message can be sent *between*
turns, not injected *while* the model is mid-generation/mid-tool-call, which is
what "interject" actually means. Building UI for unverified behavior risks
shipping something that silently does nothing or breaks. Needs a follow-up
spike that sends a second message before the first `result` arrives and checks
whether the CLI queues it, ignores it, or errors.

## 2026-07-01 — Image paste: tested, not supported this way — deferred

**Superseded 2026-07-02** — see "Image paste: shipped via file-path
reference" above. This entry is kept for the record of what was tried and
ruled out first.

**Decision:** Do not implement paste-image-into-prompt yet.

**What was tested:** sent a `stream-json` input message with a Messages-API-
style content block (`{type:"image", source:{type:"base64",...}}`) alongside a
text block asking the model to confirm it saw an image. Response: it did NOT
see the image (`HELM_NO_IMAGE`). So the CLI's stream-json input does not
accept inline base64 image blocks in that shape.

**What's still open:** `claude --help` lists a `--file file_id:relative_path`
flag ("File resources to download at startup") — suggesting attachments go
through an upload-and-reference flow (a `file_id`, likely from an Anthropic
Files API), not a raw paste. Needs research into that flow before building;
not attempted here to avoid guessing at an unverified upload API on autonomous
unattended time. [[project-helm]]

## 2026-07-01 — Build a custom harness rather than live within the desktop app

**Decision:** Build a dedicated app that programmatically starts, roots,
resumes, and drives Claude Code sessions, with its own overview/orchestration UI.

**Why:** The desktop app has hard limits we kept hitting: it can't choose a
session's working directory (rooting), a session's cwd is immutable after
creation, and the only in-app way to root a spawned session (`spawn_task` with
`cwd`) forces a git worktree — which conflicts with Aidin's "work on main"
default. A harness lets *us* control cwd (real dir, on main, no worktree),
model/effort per task, and context injection.

**Alternatives considered:**
- *Headless service + Session Radar as its UI* — fastest to value, reuses the
  web dashboard. Rejected in favor of a polished dedicated app (Aidin's call);
  he already ships Electron apps (Loom, Jot).
- *Extend the Reinmaker/TG Studio wrapper* — shares a codebase but mixes a
  personal tool into a work product. Rejected: this is explicitly private.

## 2026-07-01 — Form factor: standalone Electron app

**Decision:** New standalone Electron + (likely React/TS) desktop app, same
pattern as Loom and Jot.

**Why:** Aidin wants a dedicated, polished UI and does not want to start
sessions via VS Code / CLI. Standalone keeps the personal tool separate from
work tools.

## 2026-07-01 — Private project, personal git

**Decision:** Lives at `D:\Repo\Tools\helm`. When a remote is created it goes
on Aidin's *personal* GitHub (not The Gang). No remote/push until he asks.

## 2026-07-01 — Bootstrap build happens in the current session, on main

**Decision:** The initial build is done directly (not delegated to a spawned
session), in `D:\Repo\Tools\helm` on `main`.

**Why:** Bootstrap exception to the "orchestrator is overseer, not worker"
principle — you cannot delegate through a harness that does not exist yet, the
only current handoff tool forces a worktree, and this session holds all the
design context. Session Radar was built the same way without issue. Once Helm
exists, the overseer/worker split becomes the operating default (but not
dogmatically — small direct edits by the orchestrator are fine).

## 2026-07-01 — Reuse Session Radar's read layer

**Decision:** Port/reuse Session Radar's `lib/sessions.js` (session metadata +
transcript-tail status) and `lib/jot.js` (Jot matching + work scoring) as
Helm's read layer for the overview.

**Why:** Already built and verified; avoids duplicating the undocumented
session-file parsing. Session Radar's overview UI is effectively Helm's v0
dashboard.

## Open architectural question (pending Agent SDK verification)

**Do we manage our own SDK sessions, mirror/control the desktop app's sessions,
or both?** SDK-created sessions are likely independent from the desktop app's.
Leaning: Helm fully manages its own SDK sessions (root on main, model/effort,
context injection, streaming) AND surfaces the desktop app's sessions read-only
in the overview so nothing is lost, with gradual migration of coding work into
Helm. To be finalized once SDK capabilities are confirmed.

## 2026-07-01 — Phase 0 spike: PASS (wrap the real `claude` CLI)

Ran `spike/run-spike.mjs` spawning the real `claude -p ... --output-format
stream-json --verbose --model claude-sonnet-5` in the session-radar repo dir.
Results:
- **Subscription auth works with zero extra config** — no API key needed; the
  spawned subprocess inherited the logged-in subscription. (The one unconfirmed
  cost risk is now cleared for the current machine.)
- **Rooting works** — it ran in the target repo dir on main, no worktree; it
  even looked for that project's memory/files.
- **Streaming works** — newline-delimited JSON events: `system` (init,
  thinking_tokens, post_turn_summary), `rate_limit_event`, `user`
  (tool_result), `assistant`, `result` (with cost_usd, num_turns). Session id
  captured from the stream.
- **Bonus — quota data source found (point 13):** the stream emits
  `rate_limit_event` with `{ status, resetsAt, rateLimitType: "seven_day",
  utilization, isUsingOverage }`. Point 13 (token/quota view) has a real,
  first-party source — no guessing. (At spike time utilization was 0.89 of the
  seven-day limit.)
- Note: headless `-p` runs the full agent (it executed tool calls and answered
  conversationally rather than echoing the literal token). Expected; the wrapper
  drives real agent turns, not a constrained completion.

Decision: proceed to Phase 1 on the CLI-wrapping approach. Design the wrapper to
parse `rate_limit_event` for the quota view and `result` for per-turn cost.

## 2026-07-02 — Correction: the Phase 0 spike's "PASS" never actually checked prompt fidelity, and it was silently broken

**What happened:** after shipping several features, Aidin reported real prompts
got "cut to the first word." Root cause: `spawn("claude", args, { shell: true
})` on Windows does NOT quote array arguments before handing them to `cmd.exe`
— it just concatenates them with spaces. Any prompt containing a space (i.e.
every real prompt) was silently split into multiple shell tokens, so only the
first word ever reached `-p`. Verified directly: a 5-word prompt sent through
the old `shell:true` spawn produced a response proving the model never saw
anything past word one; the identical prompt sent via a directly-resolved
`claude.exe` (no shell) came back byte-for-byte correct.

**This means the original Phase 0 "SPIKE PASS" was invalid on this specific
point.** Its own test prompt ("Respond with exactly this token...") almost
certainly hit the same bug — the model's reply was conversational rather than
the literal token, which I should have treated as a red flag instead of
counting the run as a pass because a `result` event arrived with exit code 0.
The auth/rooting/streaming conclusions from that spike still hold (they don't
depend on prompt content), but the prompt-fidelity assumption was wrong from
the start and went unnoticed through several feature batches because no test
prompt used since then happened to get manually diffed against the reply.

**Fix:** `launcher.js` now resolves the actual `claude.exe` path once (via
`where claude`, preferring a `.exe` over a `.cmd` shim) and spawns it directly
— no shell — so Node's own correct Windows argv escaping applies. `shell` only
falls back to `true` if no real binary could be resolved.

**Lesson:** "the process exited 0 and said something plausible" is not
verification that it received the actual input. A real check needs the
model to echo back something that could ONLY come from the full prompt (as
the later re-test did), not just any coherent-sounding reply.

## 2026-07-06 — The orchestration model: a tiered captain / first mate / second mate / crew hierarchy

**Decision (Aidin, settled in conversation):** Helm's mental model is an
explicit four-tier hierarchy — captain (Aidin) -> one cross-project **first
mate** (orchestrator rooted in the meta-home) -> per-project **second mates**
(orchestrators rooted in a project) -> **crew** (agents / Autopilot runs in
worktrees). Full model + operating rules in `docs/orchestration-model.md`.

**Why this, and why it changes the earlier framing:**
The prior "ephemeral sessions, not a durable fleet" reorientation (2026-07-03,
in PLAN.md) was reacting to a real problem (megasession bloat) but
over-corrected into near-pure-ephemeral, which quietly discarded something
valuable: the persistent coordinator Aidin actually wants (the "Helm chat"
concept came from exactly this instinct). Aidin re-surfaced it as the
captain/first-mate analogy, and crucially added that the first mate is
**cross-project**, not per-project — with per-project **second mates** below it.
That extra tier is what resolves the tension: ephemeral applies *downward*
(crew always, second mates per-assignment), while the first mate is a durable
*role* kept thin (only cross-project priority, memory in files, refreshed on
saturation) so it does not bloat even while long-lived. Ephemeral-vs-durable
was a false binary; the answer is *by tier*.

**Two operating rules that fell out of it:**
- One active first mate at a time (a single unfragmented cross-project view),
  backed by a succession of refreshed sessions — not eternal, not per-project.
  Sole exception: firewalled life-domains (work vs personal).
- Direct access to any tier is always allowed (the hierarchy is the default,
  not a gate); file-backed continuity (Jot/DECISIONS.md) is what keeps the
  first mate's picture current when the captain goes direct.

**Alternatives considered and rejected:**
- *Pure ephemeral* (the 2026-07-03 framing taken literally): loses the
  first-mate continuity Aidin wants; a fresh officer every time who only ever
  reads the logbook, never holds the voyage.
- *Durable orchestrator per project*: still goes long-lived and bloats (this
  session is proof), and gives no cross-project overview — the level was set
  too low.
- *Unbounded recursive agent fan-out* (rejected earlier, 2026-07 quota
  incident): burned quota with no ceiling. The tiered model is explicitly
  bounded — a known small set of tiers with explicit dispatch, not recursion.

**What it maps to in code:** cwd = tier (why orchestrator detection is
cwd-based). The second-mate -> crew machinery largely exists (Autopilot /
`goalOrchestrator.js`, agent dispatch). The missing piece is the first-mate
tier: **session/run-spawns-run + structured report-back**. Phased plan in
`docs/orchestration-model.md`; PLAN.md's reorientation section updated to
"ephemeral by tier" rather than pure-ephemeral.

**Evidence check (2026-07-06, same day) - the first-mate tier is NOT settled.**
A research pass (`docs/research-orchestration-2026-07-06.md`) strongly supports
the **second mate -> crew** layer (2-level coordinator->workers on independent
parallel projects) but is skeptical of the **first mate as a standing 3rd
agent tier**: effective agent hierarchies cap at ~2 levels (Claude Code's Agent
Teams disallows nesting outright), and a cross-project coordinator only earns
its coordination tax on *genuine* cross-project work, not as a routine relay.
Token cost is real (~4-15x a single agent; multi-agent wins largely by spending
more tokens, ~80% of Anthropic's benchmark variance). **Likely refinement:** the
first mate is on-demand (invoked for real cross-project synthesis) or is Aidin
himself (captain as integrator via Dashboard + Jot), not an always-on relay;
build the well-supported second-mate->crew layer first with model-tiering +
ephemeral workers + a 2-level depth cap. To confirm with Aidin before building
the first-mate tier. The tiered vocabulary + operating rules above still stand.

**Refinements (2026-07-06, same-day discussion) - resolves the evidence check:**
- **First mate = bookend + on-demand, dormant between**, not a standing relay:
  active at day-start ("what matters today?" -> spins up second mates) and
  day-end (summary), or ad hoc for real cross-project synthesis; you talk to
  second mates directly during the day. This IS what the research prescribed, so
  the skepticism is honored, not overridden. **Two named first mates** (work,
  private) is the norm (the firewalled-domains case), cheap because a dormant
  session bills no tokens.
- **Model per tier is by JUDGMENT, not hierarchy level** (Aidin's correction to
  my naive "higher tier = cheaper"): first mate -> Sonnet (pure delegate/
  prioritize/summarize; not Haiku - day-prioritization is real judgment); second
  mate -> Opus (it validates/reviews/bugfixes - the judgment tier); crew -> by
  task complexity (Point 9's per-prompt suggestion). Explains the earlier
  "orchestrator = Opus": that role was second-mate work (validate + build).
- **Feedback pipe** for first-mate refresh: gauge threshold -> attention notice
  at a sensible moment (idle / day boundary, never mid-task) -> one-click ->
  automatic summarize-to-files + fresh same-named session. Phased plan steps
  5-6 in `docs/orchestration-model.md` (refresh pipe + tree/fleet view).

## Phase 2 built + hardened (2026-07-14)

Batch-reconciled after a long build+review flurry (44 commits since the last
doc touch - the docs-staleness pill was correct).

**Phase 2 (tiered orchestration) is BUILT** - the "awaiting Aidin's go" plan
above shipped.
The build order was deliberate: **guardrails FIRST** (Slice 0: per-fleet token/
cost budget ceiling + a kill switch + width/depth caps), before any tier, so the
tree can never run away and burn quota - the exact failure the model was meant to
avoid.
Then the tiers, one slice at a time, each **feature -> adversarial review in a
fresh context -> fix** (this caught ~16 real bugs before they shipped): lazy
proposed/created second mates (Slice 1), second-mate-dispatches-crew depth-capped
(Slice 2), report-up (Slice 3), per-session turn lock + async relay (Slice 4),
resumable runs (Slice 5), and the top-down "fortsätt" cascade (Slice 6).

**Durability = a first-class requirement, met via worktree reuse.**
A run that stops on quota/escalation or is cut off by an app restart keeps its
worktree + branch + notes.md; `goal:resume` re-attaches `runGoal` to that
existing worktree (never a fresh one) and is gated resumable-once + kill/budget/
width-cap.
"fortsätt" on a first mate cascades (`helm_resume_fleet`) to every resumable run
its tree owns.
Alternative rejected: re-run from scratch (loses the partial work the whole
pause-not-abort design exists to keep).

**First mate stays LEAN (no user MCP); second mates + regular sessions keep it.**
A first-mate session is launched `--strict-mcp-config` with ONLY the helm_*
dispatch tools - not the machine's ~20 MCP servers - so it's a pure orchestrator.
Reaffirmed with Aidin 2026-07-14 (he chose "keep lean" when asked).
Alternatives weighed + declined: full MCP in first mates (tool bloat in the
orchestrator's context), and a curated MCP subset (more machinery than it's
worth right now).

**Second-mate MCP parity fix (2026-07-14).**
A second mate passes `--mcp-config` (to add the helm_* crew tools), and just
passing `--mcp-config` makes Claude Code stop AUTO-ALLOWING the user's own MCP
tools - so in a headless `-p` turn they stall on an unanswerable permission
prompt ("works in Claude Desktop, not in Helm").
Fix: pre-approve the user's already-configured servers (read `mcpServers` keys
from `~/.claude.json` -> `mcp__<key>` in the second mate's `allowedTools`).
This RESTORES the auto-allow a regular (no --mcp-config) session already has - it
grants nothing the user hasn't set up; it is not new access.
Alternative deferred: per-call permission prompting (least-privilege, but needs a
real interactive-permission feature since Helm runs headless -p with no prompt
channel; the CLI has no --permission-prompt-tool in this version).

**Cross-instance safety for resume (data-loss guard).**
`liveGoalRuns` is per-process but the goal-run history is a single shared file,
so a second Helm instance could resume a run the first is driving -> two runs on
one worktree -> git corruption.
A live run now stamps `livePid` + a 20s heartbeat; another instance treats a
FRESH foreign heartbeat as owned-elsewhere (refuses resume, keeps it "running")
and a STALE one as a dead process's leftover (resumable). Clean quit releases it.

**Smaller hardening decisions (2026-07-14):**
- Budget fails CLOSED on a CORRUPT budget.json (reads as killed) - a damaged file
  must not silently un-kill a stopped fleet; a merely MISSING file still reads as
  not-configured/not-killed.
- `deriveSecondMates`: crew dispatched BY a second mate attaches to that second
  mate, not to a phantom node hashed from its id (which broke fleet attribution +
  report-up parent resolution).
- Retire ARCHIVES the outgoing mate's own session (its context lives on in the
  handoff), so it doesn't resurface as a stray "archive finished session" nudge.
- A first mate awaiting its own dispatched crew (live, reported, OR errored) reads
  a calm crew state, never the alarm "needs input" - the action lives on the crew
  (their own attention rows), not as input to the mate.

**Holistic flow review (3 fresh-context agents + hands-on).**
Root finding: the plumbing was solid but the BACK HALF of the daily loop (what the
captain can do when work returns) had thin/missing affordances.
Closed: one-click Resume on paused/interrupted runs, a Direct-run report rollup
(captain-launched runs no longer vanish), a "Work on this" goal->session launch,
first-mate proposals surfaced near the queue, Focus as a first-class sub-nav tab,
a working crew-row "Done" that clears the row + can clean the worktree, and a copy
pass (standardize "Autopilot run", drop implementation leaks, no em dashes).

## Handoffs go to HANDOFF.md (overwrite), not DECISIONS.md (2026-07-14)

**Decision:** A session handoff (the "where things stand + what's next"
continuity note) is written to `HANDOFF.md` in the project, OVERWRITTEN each
time (latest-only), and a fresh session reads it FIRST. `DECISIONS.md` holds
ONLY durable rationale, appended; a handoff should distill any genuinely new
decision into a short DECISIONS.md entry separately.

**Context:** archive-with-handoff appended the handoff INTO DECISIONS.md, so the
durable-rationale doc bloated with transient session narrative - Crewline's hit
1119 lines, a whole captured handoff among the real decisions. A fresh session
reads DECISIONS.md on demand, so the bloat also made that read heavier over time.

**Alternatives considered + declined:**
- *Keep appending, periodically compact DECISIONS.md.* Rejected as the primary
  fix: it fights the symptom (compaction risks losing the "why") instead of the
  cause (mixing transient continuity into durable rationale).
- *Per-call permission-style prompting / smarter capture.* Overkill; the split is
  the simple correct model.

**Why:** handoffs are inherently latest-only (superseded by the next), so an
overwrite file never grows; durable decisions are append-only and worth keeping,
so they stay in DECISIONS.md. Clean separation = both files stay right-sized.
Implemented: `context:saveHandoff` (atomic overwrite), archiveWithHandoff writes
there, HANDOFF.md is first in the carry-over "read these" directive, and each
project's CLAUDE.md points a fresh session at HANDOFF.md first.

## 2026-07-26 - Non-rooted sessions file handoffs by TOPIC, not by path (663ab4b6)

**Decision:** a session with no project repo files its handoff into a Helm-owned,
topic-keyed store at `<meta-home>/.helm/handoffs/<slug>.md` - one latest-only
markdown file per subject (training, kombucha, job-search).
The topic is proposed by a cheap Haiku classifier that is shown the topics
already on file, then resolved deterministically by `resolveHandoffCategory`,
which reuses an existing topic whenever the proposal matches it word-wise.

**Context:** the whole handoff mechanism was anchored to `cwd`.
Writing went to `<cwd>/HANDOFF.md` and reading came from `<cwd>`, so a non-rooted
second mate (Aidin's training/kost session is the reported case) had two broken
outcomes: with an empty cwd the "save handoff" action was not even offered and
the knowledge was silently dropped on retire; with a meta-home cwd every such
session would overwrite ONE shared HANDOFF.md.
Verified before building: there was no HANDOFF.md in the meta-home at all, i.e.
no non-rooted session had ever produced a durable handoff.

**Alternatives considered + declined:**
- *Reuse the mate record's `pendingHandoff` (mates.js).* Declined: it is consumed
  once, so it is a message to the next instance rather than a durable document
  you can reopen later. The repo case gives you a readable file; the non-rooted
  case should not be weaker.
- *Key by session title slug.* Declined: titles get renamed, which would silently
  fork a topic's history into two files.
- *Ask for the category every time.* Declined as the default: it adds a prompt to
  a flow whose whole point is that it happens automatically at retire/archive.
  The chosen topic is instead shown in the toast, and `saveHandoff` takes an
  explicit `category` so an override is possible.

**Why topic-first with a deterministic resolver:** the model proposes but does not
decide. `resolveHandoffCategory` enforces the match-an-existing-topic rule in
plain code, so near-duplicates (training / training-log) collapse into one file
instead of scattering, and a junk or unusable proposal can never create a stray
or path-escaping file (slugs are ASCII kebab-case, separators stripped).
Live-checked across five real subjects: Swedish "Träning och kost" and "CV och
ansökningar" both reused the existing English topics, while a tax-return session
correctly opened a new `finances` topic.

## 2026-07-27 - Session-status FSM increment 5: `launching`, and the hybrid made explicit (Epic f3d096fa)

**Decision:** close out the FSM epic with the two things the design named as
remaining, and nothing more.
`launching` becomes a real state, and `stateSource` ("tracked" | "derived") makes
the design's hybrid caveat a readable field rather than an assumption.

**Why `launching` needed its own state.**
Increment 1 folded it into `working` because sessions:get had no pre-first-output
signal to key it on.
That was honest at the time but left the epic's worst case open: a session Helm
has just spawned has an empty transcript, so `deriveStatus` reads it as `idle` -
"idle while working" at the exact moment Helm knows the truth for certain,
because it did the spawning.
So `liveSessions` now tracks in-flight launches and the projection checks
`isLaunching` first, before the archive/active/waiting branches and before the
needs-you promotion (a session that has not spoken cannot be awaiting you).

**Keyed by launchId, not session id.**
A fresh launch has no session id until the CLI reports one - which is precisely
the window this state covers.
Keying on the session id would mean the state could only start existing after the
gap it was built to cover had already closed.
`bindLaunch` attaches the id when it arrives; `bindLaunch` on an
already-cleared launch is deliberately a no-op, so a late event cannot resurrect
a finished launch.

**`stateSource` is exposed, not inferred.**
For a Helm-launched session with a turn in flight, "working" is something Helm
observed; for a foreign Desktop session it is a guess from last-role-plus-age.
Both are useful, but a surface (or a future bug report) should be able to tell
them apart instead of treating the heuristic as truth everywhere.
Ownership alone is deliberately NOT enough to read "tracked": an owned session
with nothing in flight still got its status from the file heuristic, so it reads
`derived`.

**Alternative rejected: persist the state machine.**
Same reason as increment 4 - a persisted transition machine needs a
reconcile-from-truth step that re-derives this anyway, which makes the transition
layer vestigial for Helm's poll-per-read model.
Recompute stays stateless and drift-free.

**What the testing actually caught (worth recording, because it is the recurring
failure mode).**
The unit test on the pure projection passed immediately - it always does, because
it tests the layer I had just finished reasoning about.
The E2E through real IPC then reported 0 of 75 sessions as Helm-owned.
That was not an ownership bug: the E2E harness hands the app a throwaway config
so tests can't pollute the dev repo's, so `helmSessions` is empty and every row
is legitimately foreign.
But it means a test that only inspects the live board can never observe the
tracked half at all, and would have passed while ownership was completely broken
- and my first version of that assertion was a tautology that could not fail.
The test now seeds its own config with one known session marked as Helm-launched,
so both halves of the hybrid are exercised through the real IPC.

## 2026-07-27 - Docs drift as an ACTIVE nudge, on both dashboards (task 0831417b)

**Decision:** the docs-drift signal becomes a board-level nudge listing the
projects whose PLAN/DECISIONS have fallen behind, with jump-in - and it lives on
the CLASSIC dashboard as well as being a widget.

**Why the pane-header pill wasn't enough.**
The pill only tells you once you've already opened the project, which is exactly
backwards for drift on a project you've stopped thinking about.
The whole failure mode being addressed is docs going stale on work that has moved
on, so the signal has to reach you where you decide what to look at next.

**Why the classic dashboard too, not just a widget.**
Building it as a widget alone looked right - widgets are the newer surface - until
the E2E showed the real config has `dashboardWidgets.enabled: false`.
A widget-only nudge would have been invisible on the board actually in use.
An attention signal that never fires is worse than no signal, because you come to
trust the quiet.
Both surfaces share one `driftLineEl` row builder, so they cannot drift apart.

**Jump-in only, deliberately.**
The ticket floated dispatching a doc-reconcile turn.
Rejected for now: rewriting a project's DECISIONS.md unsupervised is a much
bigger promise than pointing at it, and getting it wrong quietly corrupts the
durable record the nudge exists to protect.
It points; you decide.

**Seeded once onto an existing layout, then yours.**
A widget added only to the DEFAULT layout is invisible to anyone who has already
arranged their board, and an attention signal you have to find in the Add-widget
menu is a weak one.
So `seedNewWidgets` appends it once, gated on a per-type `seeded` flag rather than
on "is it in the layout" - otherwise removing the widget would just bring it back,
which would make "remove" a suggestion rather than a decision.

**Cached for 60s.** Staleness costs two git calls per repo and the dashboard
refreshes on a poll tick; drift measured in commits does not move second to
second. The classic section additionally carries a fingerprint so a tick doesn't
rebuild it.

**Quiet when clean, but never silently quiet on failure.**
(CORRECTED 2026-07-27, see the ship-review section below: as first committed this was
an aspiration, not the behaviour. The classic section returned null on failure,
which on that surface is indistinguishable from all-clear, and a missing sessions
dir or missing git arrived as a confident empty list. Now true.)
The classic section returns null when nothing has drifted (no empty module on a
clean board), while the widget - which you placed on purpose - says "Docs are
current". A read that FAILED says so explicitly in both, rather than rendering the
all-clear: a nudge that can't look must not claim there is nothing to see.

**What it found immediately.** On the real board: `meta-snack-asteroid-wars` 252
commits behind, `loom` 15. The 252 is worth acting on - that is a project whose
durable record has been left behind entirely.

**Testing note.** The renderer stubs go through injected `fetchStale` / `save`
parameters rather than reassigning `window.helm.*`: the bridge is contextBridge-
exposed and therefore NOT writable, so the first version's stubs silently did
nothing and the test was quietly asserting against live machine data instead of
the empty and error states it claimed to cover.

### Ship-review of increment 5 (same day) - what the independent pass caught

An independent reviewer in a fresh context found four real defects in the commit
above.
Recording them because three of the four are instructive about the testing, not
just the code.

**1. A shipped regression.**
The Fleet rows string-compared `lifecycleState === "working"`, so the new
`launching` state fell through to the idle else-branch: a session Helm had just
spawned printed "idle".
That is the precise display this epic exists to remove, reintroduced by the
increment meant to close it.
Fixed by routing both readers through a named `isWorkingLifecycle` mirror, plus a
source-level assertion that fails if any site goes back to comparing the string -
the renderer is a classic script and cannot import the real helper, so the mirror
is the best available and the assertion is what keeps it honest.

**2. An empty if-block.**
The "first real output ends the launching window" guard had no body: the clear was
destroyed when I stripped an earlier over-broad edit with a line filter.
The consequence was subtle and worse than it looks - the window lasted the whole
turn, which made `launching` co-extensive with `isLive` and therefore a pure
relabel of a state already resolved correctly.
The reviewer concluded from this that the state gained no coverage at all.
That was right about the code as committed; after the fix a real launch measurably
goes `launching -> working -> waiting`, so the window is genuinely distinct.

**3 and 4** were a never-bound (inert) launching entry in `fireRoutine` plus a
leak on synchronous launch failure, and a comment in `sessions.js` that claimed
resumed Desktop sessions become Helm-owned when they do not.

**The lesson, which is the same one as increment 5's own notes.**
The unit test was green.
The IPC E2E was green.
Neither could catch #1, because both tested layers I had reasoned about, and
neither had ever WATCHED A LAUNCH.
`test-launching-observed.mjs` now spawns a real session and samples the board
through its first turn.
It costs a real turn, which is why it isn't in the fast suite - but a state you
have never seen appear is a state you have not tested, and that is what the
notVerified field on the review record was trying to say before the reviewer
proved it.

### Ship-review of the docs-drift nudge (same day) - eight findings, seven fixed

An independent reviewer in a fresh context went at the commit above.
Three findings were serious enough to change the design, not just the code.

**1. The nudge blocked the whole app once a minute (the worst one).**
The handler called the SYNCHRONOUS sweep straight from the Electron main process:
four git spawns per repo (not two, as my comment claimed), measured at ~1.1s for 13
projects, growing with the number of distinct session cwds - which only ever grows.
While that ran, every window's IPC, session polling and stream handling stalled.
Fixed properly rather than papered over: `staleProjectsAsync` runs the repos in
parallel with `execFile`, and the handler is stale-while-revalidate - past the TTL
it kicks off a background refresh and returns last-known rows immediately.
Measured after: 203ms wall and 13 event-loop ticks during the sweep, versus 574ms
and ZERO ticks for the sync version. A limit was considered and rejected: capping
the project count would silently drop a drifting project, which is the one failure
this signal must not have.

**2. A failed check rendered as "everything is current".**
This is the exact failure the commit message called worse than no signal, and it
was the shipped behaviour.
Three separate paths: `readAllSessions` reports a missing sessions dir in an
`error` FIELD rather than throwing; `docsStaleness` swallows a missing git per
repo and returns not-stale; and on the classic board "clean" is rendered as the
ABSENCE of the section, so returning null on failure was indistinguishable from
all-clear.
Now the sweep reports `unchecked`/`considered`, `docsStalenessAsync` returns
`checked` so "couldn't look" is distinct from "looked, it's fine", and both
surfaces say so explicitly. My own E2E had asserted the wrong behaviour
(`brokeIsNull === true`), locking it in - that assertion is now inverted.

**3. Jump in did nothing at all from the Dashboard.**
It called `openSessionInPane` without `navigateToPage("chat")` first, and that
function writes into the hidden `#chatPage` and focuses a hidden composer - both
no-ops while chat is hidden. So the one interactive affordance of the feature
silently did nothing on the surface the commit went out of its way to support.
Every other jump-in in the app navigates first; this one didn't.
My test had only COUNTED the buttons, never clicked one - it now clicks and asserts
the page actually changed.

**Also fixed:** the section head was hand-rolled instead of using the shared
`dashBoardHead`, so the title matched no CSS rule and read as a different visual
language beside its neighbours; the fingerprint omitted `sessionId`, so a project
whose commit count hadn't moved kept a Jump-in target that could have been archived
out from under it; the jump target didn't exclude archived or Helm-hidden sessions,
so it could re-open a session you had explicitly removed from Helm; `path.resolve`
sat outside its try, so one corrupt cwd could take the entire list with it (and for
an attention signal, that means every drifting project silently vanishing).

**One inherited blind spot fixed, one flagged.**
Fixed: an uncommitted doc edit meant "reconciling right now" unconditionally, so an
edit abandoned months ago silenced that project permanently. Now it only counts as
active reconciling if the file was touched within ~36 hours.
Flagged, not fixed: a session rooted in a SUBDIRECTORY of a repo contributes a
candidate with no docs, so that repo never appears. No live instance on this
machine, and walking up to the git root would change which project a session is
attributed to - worth doing deliberately, not as a review afterthought.

## 2026-07-27 - The gauntlet could never go green (three bugs in the review pipe itself)

Found by actually running it: filing the two review records above and then running
their declared checks through the app, rather than trusting that the pipe worked
because its unit tests passed.
All three bugs made the gauntlet - the part of the review flow whose whole purpose
is to be the half the author cannot talk around - useless.

**1. Checks ran in the wrong directory.**
The runner defaulted to `check.cwd || metaHome`, so every repo check
(`node scripts/e2e/...`) ran in the Dropbox meta-home and exited 1.
A red gauntlet that is red for that reason is worse than no gauntlet: it looks like
a real failure and it can never be made green.
Now `check.cwd || rec.projectPath`, and if neither resolves it REFUSES with a
stated reason instead of guessing - a check run in the wrong place fails for the
wrong reason, and silence about that is the problem.

**2. A check that launches the app attached to the wrong app.**
An E2E check spawned from inside a harness-launched Helm inherited the same fixed
CDP port (9333), so the child attached to its parent's renderer and never settled.
The harness now honours `HELM_E2E_PORT`, and the runner hands each check a distinct
port. Default stays 9333 so an interactive run is still predictable to attach to.

**3. A multi-check gauntlet could never reach "passing".**
Staleness compared each run against the record's `updatedAt` - but STAMPING a run is
itself a write, so the second stamp moved the baseline past the first run and run 1
read as stale, forever, for any record with more than one check.
Split into `contentUpdatedAt` (moved by a real edit) versus `updatedAt` (any write),
with `isRunStamp` passed as an explicit ARGUMENT by `recordCheckRun`.
Deliberately not a field on the record: if preserving the baseline were data-driven,
an ordinary edit that spreads the previous record would carry the old baseline
forward too, and a green tick would keep vouching for changed work - the exact
failure the staleness rule exists to prevent. Both directions are now tested.

**And the gauntlet had no repo test at all.**
Its coverage lived in a scratch file that was never committed - the same miss as
`test-repo-scripts.mjs` earlier this session, and the same shape as the bug in #1:
something verified once, by hand, and then assumed.
`test-review-records.mjs` now covers unrun/passing/failing/stale, the legacy
fallback for records written before `contentUpdatedAt`, and the refusals.

## 2026-07-27 - Jot writes were lost when Dropbox held the file

**Found by hitting it**, not by testing: a board update from Helm returned
`Failed to write Jot data: EPERM ... rename` and the change was simply gone.

**Why it slipped through.** `mutateJotFile` already had a retry loop, so it looked
covered - but the loop only handled the concurrent-EDIT case (mtime/size changed
between read and write, `continue`). A failed atomic RENAME went straight to the
catch and returned on the first attempt. The Jot data dir is always in Dropbox
(`JOT_DATA_DIR` -> `D:\Dropbox\jot`), so the sync client holding the file
mid-rename is the normal operating condition, not an edge case.

**Fix:** treat `EPERM`/`EBUSY`/`EACCES` as transient, back off (60/120/180ms) and
retry within the existing attempt budget. A lock that never clears still FAILS -
and now says the likely cause ("the file stayed locked ... Dropbox may be syncing
it") instead of the raw errno, which reads like a bug in Helm.

**A blocking sleep, deliberately.** `mutateJotFile` is synchronous (called straight
from IPC handlers), so the backoff blocks the main process. That is the opposite of
the call made for the docs-drift sweep the same day, and the difference is
FREQUENCY, not blocking: the sweep ran on every dashboard tick, this path is a rare
failure bounded to a few hundred milliseconds, and the alternative is silently
dropping a write the user asked for. Frequency is what makes blocking unacceptable.

**Aidin's standing rule in action** (2026-07-27): every bug, idea, miss or gap gets
closed as soon as it's found, especially in Helm, and written down - because the
essential parts are destined for Reinmaker, and an undocumented finding can only be
re-discovered, not ported.

**Also worth noting:** the new test found a second defect the fix had introduced -
the permanent-lock path returned the raw errno rather than the diagnosable message.
The test was asserting the right thing and the code was wrong, which is the correct
way round for once.

## 2026-07-27 - Intent before the work, and criticality drives what evidence is required (bd5d7b4b)

Two changes that belong together: they are the supply and the demand side of moving
Aidin's attention upstream so he can stop reading diffs.

### Acceptance criteria as `AC:` lines on the Jot task

**The gap, in one example.** The "Jump in" button shipped doing nothing visible, and
the test that covered it COUNTED the buttons.
It was green because it asserted that the code did what its author wrote - not that
the user lands in the session.
One line written in advance ("clicking Jump in lands me in that project's session")
would have forced the click.

**So test steps written at HANDOFF describe the implementation; the same sentence
written when the task is TAKEN constrains it.**
Same words, opposite direction, and only one of them can catch a wrong-intent bug.
Two of the four review findings today were intent holes of exactly this shape, not
test holes.

**Where they live: in the Jot task's own description.**
Rejected a new field on `todos.json` (Jot is a shipped public app; Helm must not
bolt private schema onto its data) and a separate file under the meta-home (then
Aidin cannot see or CORRECT a criterion before the work starts, which is the whole
point). Parsed strictly as a trailer, the way a git trailer is - not prose.

**Coverage is by EXPLICIT LINK (`step.ac`), never by counting.**
Counting is gameable: five vague steps would "cover" five criteria while checking
none of them. `reviewRecordProblems` refuses a record with an uncovered criterion,
and also refuses a step claiming to cover a criterion that does not exist.

**The record snapshots the criteria rather than reading them live.**
A record is a snapshot of a claim, so a task edited afterwards must not retroactively
change what was claimed. The cost is drift, which is surfaced (`acceptanceDrift`,
shown on the card) rather than silently adopted or silently ignored.

### The criticality gradient

Aidin: "störst effort borde ligga på systemkritiska moment. security issues borde
t.ex aldrig slinka igenom, medans en front end bugg är mer acceptabelt."

So `criticality` is REQUIRED on every record, with no default - a missing tier is the
author declining to say how much it costs to be wrong, which is precisely the
judgement the gradient exists to force. It changes what evidence is required:

- `critical` (security, auth, data loss, money, irreversible/outward-facing):
  needs runnable checks AND `independentReview {by, summary, findings}`. The author's
  own passing tests are explicitly not evidence at this tier.
- `core` (state or behaviour other work depends on): needs at least one runnable check.
- `cosmetic` (visual/front-end): no check required; a bug here is recoverable.

**The gate earned its keep immediately.** Marking the review pipe itself `critical`
was REFUSED, because nothing independent had reviewed it - I wrote the summary, the
test steps, the checks, ran the gauntlet AND fixed the gauntlet. That is the exact
failure mode the ticket names, caught by the rule rather than by luck.

### Two smaller corrections that came out of building it

**"incomplete" is now a distinct verdict from "unrecorded".** Both used to read as
"unrecorded", which hid the more alarming case: a record exists, so somebody claimed
this was reviewed, but the claim is inadmissible. Nobody-wrote-one and
somebody-wrote-a-bad-one need different reactions.

**Queue ordering is now stated, not inherited.** A critical item that claims to be
reviewed but isn't admissible sorts to the TOP, alongside judgment items - even
though fixing it is my job, not his. Sorting it below a batch of cheap cosmetic
stamps buried exactly the alarm the gradient exists to raise.

## 2026-07-27 - The review pipe could report unverified work as verified (independent review, 11 findings)

Marking the pipe `critical` under the new gradient refused its own record, because
nothing independent had reviewed it - I had written the summary, the test steps, the
checks, run the gauntlet AND fixed the gauntlet.
So an independent reviewer went at it with one standard: **can this thing report
something as verified when it isn't?**
It found 11 issues, and one was fatal to the premise.

### The fatal one: the gauntlet was forgeable, and so was the whole claim

`writeReviewRecord` - the function holding every refusal in this file - **is not on
any production path.**
Records are authored by an agent writing JSON directly. And `gauntletStatus` trusted
an `ok: true` FIELD without ever looking at the exit code.
So this, written by hand, read as "Checks passing (1/1), ready to stamp":

    checks:    [{ label: "auth e2e (34 assertions)", cmd: "exit 0" }]
    checkRuns: [{ label: "auth e2e (34 assertions)", ok: true }]

No command was ever executed.
The gauntlet's entire selling point - the half the author cannot talk around - did not
hold: the author wrote the checks, the labels AND the outcomes, in one file they
control.

**Fix, in two parts.**
1. A check run now carries an HMAC signed by the process that spawned the command.
`gauntletStatus` checks provenance BEFORE outcome, derives pass/fail from `exitCode`
(never from `ok`), and requires a numeric `ranAt`.
An unsigned, edited, or transplanted run counts as `unverified` - a new bucket,
separate from stale, so "nobody ran this" cannot hide inside "this is a bit out of
date".
2. Validation moved from advisory to enforced on READ: `buildReviewQueue` re-validates
every record, so a hand-written inadmissible one renders as `incomplete` with its
reasons rather than as a confident card.

**Stated limit, because this file is the one that has to be honest.**
The key lives at `<meta-home>/.helm/run-key`, so an agent with filesystem access can
read it and forge a signature.
This is tamper-EVIDENT, not tamper-proof.
What it actually buys is the line between "the app ran this and stamped it" and "the
author wrote down an outcome they believed" - and the second is the failure that keeps
happening.
A hard guarantee needs the runner outside the author's reach (CI); that is not built.

### The other nine

- Duplicate check labels scored 2/2 passing while one check exited 7.
Runs are keyed by label, so the second stamp overwrote the first and the failure
vanished. Now refused at the record level, and scored as unverified if it slips through.
- `runChecks` said "All checks passed" while persisting nothing.
`recordCheckRun` goes through validation, so after criticality became mandatory 9 of
11 live records could not be stamped at all - a regression I introduced an hour
earlier by adding a required field without backfilling.
The return value was discarded. Now the handler reports `stored`, and the toast says
the outcome could not be stored rather than claiming success. All 11 records backfilled.
- Duplicate acceptance `index` values let one linked step cover several criteria.
Indices are now re-derived by position: the author does not get to choose the numbering
the coverage check keys on.
- The per-check dots used `updatedAt` while the header used `contentUpdatedAt`, so
every check but the last read "stale" under a green header. The un-migrated half of my
own earlier fix.
- The check LABEL was shown and the command hidden in a tooltip.
A label reading "auth e2e (34 assertions)" over `cmd: "exit 0"` looked authoritative.
The command is now rendered next to the label - the label is author prose, the command
is the fact.
- The subnav badge omitted `incomplete` - the case my own code comment calls "the more
alarming" raised no badge at all. Under-flagging an attention signal, which is the
failure mode Aidin explicitly rejects.
- `mutateJotFile`'s size+mtime guard missed same-size concurrent edits.
Measured: 250 of 400 same-size writes were invisible, because a drag-reorder is a pure
permutation and Windows' ~15.6ms clock tick is coarser than the read-write window.
Helm renamed over the user's edit and reported success. Now a content hash.
- Two of my own tests were defective.
One "concurrency guard" test appended two spaces to the competing write, changing the
file SIZE - so it only ever exercised the easy case and never the failing one.
Another assertion (`raced.ok === false || after.todos.length >= before + 1`) could not
fail: both the guarded and the clobbered outcome satisfy the disjunction.
A third asserted that an unsigned `ok: true` run should read as passing - locking in
the forgery.
- The check subprocess port was derived per-invocation, so two concurrent "Run checks"
handed their children the same port, reintroducing the wrong-app-attach bug across
invocations. Now a monotonic cursor.

### What remains open, deliberately

**Tier gaming is an honour system.**
Nothing correlates the declared criticality with the diff, the touched paths, or the
commits.
A security change labelled `cosmetic` needs no check and no independent pass and
renders under "Ready to stamp".
Since the gradient is what "I stop reading diffs" rests on, this is the largest
remaining hole, and I have no honest fix that doesn't involve inspecting the diff -
which is the thing we are trying to stop doing.
Recorded on the record's own `notVerified` so it is visible where the trust is given.

### The five red-team tasks, worked (2026-07-27, later)

All five filed tasks done. What is worth remembering is which fixes were structural
and which were only presentational, because the presentational ones were the ones
that had actually shipped broken.

**Structural.** A pass is now bound to two things it was not bound to before: the
command as DECLARED in `rec.checks` (runs were matched by label alone, so a run
stamped for `exit 0` could score a check whose displayed command was a real e2e
script) and the commit it ran against (staleness only consulted the record's own
`contentUpdatedAt`, so the ordinary send-back / fix / return-to-review lap left the
pre-fix green vouching for post-fix code).

Both are covered by the signature, so neither can be edited afterwards to make an old
pass look current. Changing the signature payload correctly invalidated every
previously-signed run on the board - all of them read `unverified` until the checks
were genuinely re-run. That was the mechanism working, and it is the first time a
change to this system produced a visible, correct mass-invalidation.

**Presentational, and more dangerous than it sounds.** `independentReview` was
rendered nowhere, so the certificate gating the critical tier was invisible - a record
could claim "reviewed by a fresh-context agent, 0 findings" with nothing on screen to
interrogate. The criticality chips were coloured backwards: `critical` shared the amber
of a `notVerified` gap while `cosmetic` was green, so the highest-stakes tier read as a
caveat and the tier that requires no evidence at all read as a pass. And the per-check
state was re-derived in the renderer from `run.ok`, a field the author writes, so a
forged run drew a green dot on the line a reader studies.

**The detection half.** Two things cannot be gated from inside Helm, so they are now
detected instead. Subtasks in review were filtered out of the queue entirely
(`!t.parentId`) - invisible, no record needed, no badge; the convention here is epics
with subtasks, so that hole opens itself. And nothing requires a record for `done` at
all: agents write `todos.json` directly and the Jot app can drag a card straight
across. `signedOffWithoutRecord` lists what reached done in the last fortnight with no
record, in its own band. It found four real items on the first run.

**Cosmetic no longer buys silence.** It was the likeliest path to false trust and it
was the system's normal shape, not a trick: no checks, no criteria, no gauntlet box
rendered at all, filed under "Ready to stamp", one click to done. The tier now costs a
written `whyNotCritical` - a tier you must argue for is much harder to under-declare
than one you tick, and the argument is something Aidin can disagree with. Absences are
rendered as caveats, because an absence otherwise renders as nothing.

**One keypress no longer signs off.** `Mark done` confirmed only on an outright
`failing` gauntlet; unverified, unrun, stale, drifted, below-the-bar and
no-checks-at-all all went through on a single click. Each now names its own reason. And
`customConfirm` focused OK, so click-then-Enter confirmed - destructive confirms now
focus Cancel. `Run checks`, which spawns arbitrary shell from a JSON file in the
meta-home, lists every command in full before running anything.

**What is still open, and it is the same thing as before.** Tier gaming remains an
honour system: nothing correlates the declared criticality with the diff. The signing
oracle is narrowed but not closed - `recordCheckRun` is still an exported function that
accepts an exit code, so the honest claim is that a forgery now has to lie about a
specific declared command at a specific commit, not that it is impossible. A real
guarantee needs the runner outside the author's reach, which is CI, which is a project
rather than a task.

### The verification pass on the verification pass (2026-07-27, evening)

An independent agent checked the previous round's fix claims with mutation testing -
copying the lib and tests to a temp tree, disabling a guard, and seeing whether the
suite noticed. That is the strongest technique used on this codebase so far and it
should be reused: most mutations WERE caught (signature verification, head comparison,
the staleness baseline, the whyNotCritical gate, the undeclared-label refusal,
passForcingReason), which is the first real evidence that the suite has teeth. One was
not, and that assertion was worthless.

**The worst finding was one line from working.** `passForcingReason` detected a
pass-forcing command and then nothing consumed the detection: `state` came from the
exit code alone, so `node test.mjs || exit 0` - genuinely run, correctly signed -
read "Checks passing (1/1)", banded as a stamp, counted zero in `tally.unconfirmed`,
raised no badge, and signed off on one click. Detection without consequence is worse
than no detection, because the code reads as though the case is handled. There is now
an `unusable` state that blocks `passing` and names itself everywhere the reader looks.

**Two of my own tests asserted the hole was correct**, using `exit 0` as their fixture
command. A test written against a convenient fixture will happily enshrine the very
behaviour the feature exists to prevent.

**A scripted string-replacement put a fix in the wrong function** - the `onCancel`
guard landed in `showImageLightbox`, where the variable does not exist, producing a
live ReferenceError on Escape while `customConfirm` never got the guard at all. That
is the third time today. The rule that follows: apply behavioural patches with an
editor that fails on a bad match, not with a regex over the whole file.

**Coarse commit pinning is a real cost, recorded rather than hidden.** Pinning a pass
to a HEAD sha means ANY commit invalidates every check - including a commit that only
touches DECISIONS.md. It is safe (a false red) but it will nag, and during an active
session it makes the whole board perpetually stale. Filed as a task rather than
softened here, because the fix (compare the files a check plausibly depends on, or at
least ignore commits touching only docs) is a design decision, and quietly widening
the rule would put us back where we started.

**What is still open after all of this.** Tier gaming remains an honour system: nothing
correlates the declared criticality with the diff. The signing oracle is narrowed to
"a forgery must lie about a specific declared command at a specific commit", not
closed. Both are on the relevant records' own `notVerified`, which is where a reader
gives trust and therefore where the limits belong.

## 2026-08-03 - The fix that named the auto run is the fix that hid it

Aidin, twice, on the same feature: the auto-captain started, the board moved to
in-progress, the card got its stripe, the work landed in review - and the Auto widget
stayed empty.
The second report came after the dashboard-liveness fixes had shipped, which ruled out
the obvious explanation and pointed at the widget's own filter.

**What was actually wrong.** The Auto widget selected its rows with
`sm.isSessionNode && sm.startedBy === "auto"`, and both halves were false for a real
auto run.
`isSessionNode` is only set on a SYNTHETIC node the renderer derives from the session
list; the dispatch now registers the run as a real second mate before starting it, so
the renderer skipped the synthetic branch entirely.
And `startedBy` only ever exists on the SESSION - a registered second mate has no such
field at all.
So the change that made an auto run carry its project's name instead of the prompt's
first line is the same change that made it invisible, and the filter meant to find it
could not match on either half.
It fell out of both columns: not in Auto, and not in Direct either, since that filter
was written the same way.

**The decision.** Ask the property, not the proxy. Two named predicates now single-source
the question - `isLiveWorkNode` (a session is bound to this node, however the node came
to exist) and `isAutoStartedNode` - and `augmentSecondMatesWithSessions` carries
`startedBy` across from the bound session so both kinds of node can answer it.
All three call sites go through them.
Direct now EXCLUDES auto runs rather than listing them twice: a column titled "work you
drive yourself" must not contain work nobody started.
The Auto widget reuses the captain's card by Aidin's own request, so the card takes an
`as: "auto"` mode - same layout, honest wording, and no "+ Session" button in the one
column whose whole point is that nothing there was started by hand.

**Alternative rejected:** stop registering the second mate, so the synthetic node (and
its `startedBy`) comes back.
That would restore the widget by undoing the naming fix and by giving up the binding
that lets a later relay or jump-in resume the SAME session.
Reverting a good fix to satisfy a bad filter is the wrong direction.

**Why this keeps happening.** This is the "fixed one instance, believed the class was
closed" failure at one remove: nothing was wrong with the auto-captain, and nothing was
wrong with the registration. What broke was an unstated assumption in a THIRD place -
that a piece of direct work is always a synthetic node - held by a filter written before
the second kind of node existed.
`isSessionNode` was never a fact about the work; it was a fact about where the renderer
happened to learn of it. A predicate that names the real question cannot rot that way.

**Evidence.** `scripts/e2e/test-auto-widget-visibility.mjs` executes the real predicates
and the real augmentation against a registered auto run copied from Aidin's own
`second-mates.json`, and keeps the OLD filter in the test as a witness that must find
nothing - without it the test would pass on either implementation.
Mutation-verified: removing the `startedBy` carry-over turns three checks red.
`test-widget-dashboard-fixes.mjs` then measures the same claim on the rendered widget in
a launched app, with a seeded auto run, and asserts it is NOT also listed under Captain.

## 2026-08-03 - Autonomous runs left branches nobody could see; the root cause was a missing .gitignore line

Aidin found three leftover branches by hand.
One of them pointed at work that had been merged in July.
Two were from goal runs whose entire output was the orchestrator's own notes.

**The cleanup already existed.** `goal:cleanupRun` removes a run's worktree and deletes its
branch, gated on "fully merged" so no commit can be lost, and `runGoal` already auto-cleans
a run that ends with ZERO commits.
Both are correct.
Neither fired.

**Why the zero-commit auto-clean never fired.** `.helm-goal/` - the orchestrator's own
notes.md, plan.md and phase.json - was not gitignored.
So a research-only iteration committed its own working notes, the run ended with
commitCount 1 instead of 0, and it therefore looked like a run that had produced something
worth keeping.
That is the whole reason two of the three branches existed.
Ignoring the folder is the root-cause fix: a notes-only run now genuinely ends with zero
commits and removes itself.
It also stops 50-250 lines of an agent's scratch notes landing on master the moment such a
branch is merged, and - a bonus, since `git clean -fd` does not touch ignored files - the
notes now SURVIVE the reset after a failed iteration instead of being discarded.

**Why the per-run cleanup never fired.** It is a button on a report row.
Nothing swept the runs he never pressed, and a run whose record aged out of the 200-record
history was visible NOWHERE - not on the Goal page, not in any report.
So a sweep now runs unprompted at startup (and on demand), covering the residual cases the
root-cause fix cannot: interrupted runs, aged-out records, and runs that DID produce commits
he simply never cleaned up.

**The decision that makes it safe to run unattended.** The sweep acts only where the action
provably cannot lose anything, and the bias is explicit: under-cleaning is recoverable by
hand, over-cleaning is not.
A branch is deleted only when every commit on it is already on the primary branch and it is
not checked out; a worktree is removed only when it holds no uncommitted work.
Anything uncertain - unmerged, dirty, unreadable, or a run still using it - is KEPT and
reported with its reason on the Autopilot page, because a sweep that reported only its
successes would read as "everything is tidy" while an unmerged branch sat there forever.
Blast radius is capped by branch NAME: only `helm/` and `maestro/` prefixes are ever
considered, so a branch Aidin made is never a candidate however merged or stale it looks.
That limit is what makes it safe in a work repo with other contributors - and it does reach
work repos, since it sweeps wherever a goal run has run.

**Alternative rejected:** sweep on the run records alone.
That is what left the third branch invisible - its record was gone while the branch
remained. The sweep therefore reads the REPO as the source of truth and treats a missing
record as "orphaned", not as "nothing to do".

**Two things the tests caught that reasoning had not.**
A finished worktree always looks dirty: the dependency junction shows up as an untracked
`node_modules/`, and `.helm-goal/` is untracked in any repo that has not ignored it.
Keyed on the plain uncommitted-changes check, the sweep would have kept every worktree
forever and cleaned nothing - silently, looking like it worked.
Hence `hasUncommittedWork`, the cleanup-side twin of goalOrchestrator's own
`producedRealChanges`, and a new `removeWorktree({ ignoreBookkeeping: true })` that narrows
what counts as work WITHOUT becoming a second name for `force` - it still refuses a worktree
holding real changes, so the sweep can never discard anything.
Second: the first version of the UI test passed while the line still read "no sweep has run
yet" with a report sitting right there, because it read the DOM before the report arrived.
The placeholder now says "checking" - a placeholder that states the opposite of the truth is
a lie the user cannot distinguish from the truth.

**Evidence.** `test-worktree-sweep.mjs` asserts every branch of the decision table
(mutation-verified: disabling the merged gate or the dirty gate each turns three checks red).
`test-worktree-sweep-live.mjs` runs it against real git with real worktrees INCLUDING a
node_modules junction, and asserts the junction's shared target still has its contents
afterwards - the exact damage a plain `git worktree remove` did to this repo, and cascaded
into Jot's build output, the same day.
`test-housekeeping-line.mjs` measures the line on the rendered page in a launched app and
that sweeping twice removes nothing new.
