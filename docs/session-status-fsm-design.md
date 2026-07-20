# Session status as an FSM - design sketch

Status: DESIGN SKETCH for review (no code). Jot Epic f3d096fa.
Written 2026-07-18 right after the live-turn-override fix (commit 7494b97) - which was the third layer stacked on the status heuristic and is what prompted this.

## The problem this solves

A session's `status` is today DERIVED, not TRACKED. It's reconstructed by guessing from the transcript file, then patched by several layers that each mutate the same field:

1. **`deriveStatus`** (src/lib/sessions.js): a pure transcript heuristic - `active` if the last message is the user's and recent, `waiting` if the assistant's and within the attention window, else `idle`. It has no way to see a live turn.
2. **acknowledged-downgrade** (main.js sessions:get): `waiting` -> `idle` if the user manually marked it done and no newer activity.
3. **live-turn override** (main.js, commit 7494b97): force `active` when Helm knows a turn is running now (the `liveSessions` registry) - the fix for "idle while working".
4. **`orchestratorTag`** (Fas-3 Haiku classifier + the expects-input heuristic): a parallel advisory signal (`waiting_for_input` / `stuck` / `done_not_archived` / ...) the renderer folds into needs-you suppression and archive suggestions.

Four things touching one field is the smell (CLAUDE.md "proper fixes over patches-on-patches"). Each new status nuance has meant another override. The root: for sessions Helm LAUNCHED, status should be tracked authoritatively from events - not inferred from a file and then corrected.

## The core idea

An authoritative `SessionStateMachine` owns the status of every **Helm-owned** session (one Helm launched, so it sees the real events). A **foreign** session (a Desktop-app session Helm didn't launch) has no event stream, so it keeps `deriveStatus` as the fallback. This is a hybrid by necessity, and that's fine - the FSM is authoritative where we have ground truth, the heuristic covers where we don't.

## States

- `launching` - a turn was started, no output yet.
- `working` - a turn is live (assistant/tool output flowing). (Today's forced-`active`.)
- `waiting` - the turn ended AND it's awaiting the user (assistant asked a question / left an open loop).
- `wrapped` - the turn ended and finished cleanly, nothing awaited. (Today's `orchestratorTag.done_not_archived`.)
- `idle` - parked: acknowledged, or wrapped-and-aged, or an old foreign session.
- `archived` - removed from the active board.

`waiting` vs `wrapped` is the distinction the whole needs-you system already tries to make (the false-positive-bias revert + the expects-input heuristic). Making it a first-class state is the point: "does this need me?" becomes "is it in `waiting`?", not a pile of derived predicates.

## Transitions (event-driven, for owned sessions)

- `startSession` -> `launching`; first assistant/tool event -> `working`.
- turn `done` -> `waiting` OR `wrapped`, decided by the signal we already compute: the expects-input heuristic on the last message (SV/EN), refined by the Haiku classifier when it's ambiguous. (This is exactly what `expectsUserInputHeuristic` + `classifySessionStatus` produce today - they become the transition function instead of a side-channel tag.)
- user sends a prompt / relay fires -> `working`.
- user acknowledges ("I'm done with this"), or a `wrapped` session ages past the attention window -> `idle`.
- new activity on an `idle`/`wrapped` session -> back to `waiting`/`working`.
- archive -> `archived`; restore -> recomputed.

The `liveSessions` registry (commit 7494b97) is already the `working` signal. The launch/done hooks in main.js are already where these transitions would fire. So the wiring points exist - the FSM consolidates them.

## Foreign sessions (the fallback)

A session with no Helm launch record maps to a state via `deriveStatus` as today: `active`/`waiting`/`idle`/`archived` -> the same FSM states (there's no `launching`/`wrapped` distinction without events, which is acceptable - we can't know). The renderer reads one thing (the state) regardless of source; only the resolution differs underneath.

## Migration (fold the layers in, don't add a fifth)

1. Introduce the FSM as the state source for owned sessions, computed in one place (a `resolveSessionState(session, { liveSessions, acknowledged, lastMessage, classifierTag })` that returns exactly one state).
2. Move the three current overrides INTO it as transitions: live-turn -> `working`; acknowledged -> `idle`; the expects-input/classifier verdict -> `waiting` vs `wrapped`.
3. Keep `deriveStatus` ONLY as the foreign-session branch inside `resolveSessionState`.
4. The renderer stops reading `status` + `orchestratorTag` as separate signals and reads the single state (needs-you = `waiting`; archive-suggestion = `wrapped`/`idle`; working badge = `working`). This is where the "four things touching one field" collapses to one.
5. Delete the now-redundant ad-hoc predicates once every surface reads the state.

## Progress

- Increment 1 (done, commit 13c3baf): `sessionLifecycleState()` + `session.lifecycleState`, additive, unit-tested. Zero behaviour change.
- Increment 2 (done): the needs-you QUEUE (`dashboardInMotionRows`) reads `lifecycleState === "waiting"`.
- Increment 3 (done): ALL remaining needs-you surfaces migrated - the fleet-card badge (`wrapped` -> "done") + accent, and the OS attention toast (+ its `previouslyWaiting` transition set). `classifierSaysSessionDone` is now unused and was deleted. Every needs-you surface reads the one `lifecycleState` field; behaviour-preserving (E2E green - queue + badge + accent, all three states).
- Remaining reader migration: the archive-suggestion pill still reads its own `classifierSaysDone` local + `status` - move it onto `isArchiveSuggestState(lifecycleState)`.
- Then the override consolidation (design decision 3, PENDING the captain): whether the state is a recompute/projection (current) or a persisted machine with guarded transitions + a reconcile-from-truth step (the captain's lean). If persisted: move the acked-downgrade + live-turn override OUT of sessions:get INTO the transition function, and add `launching`. This is the part that changes HOW the field is computed - the reader migration above holds either way.

## What this buys

- One place decides status; a new nuance is a transition, not another mutation of a shared field.
- `needs-you` becomes a state (`waiting`), not a derived guess - which is what the whole false-positive-bias + expects-input work was circling.
- The class of "status out of sync" bugs (task 5939d671 was one instance) closes structurally for owned sessions, instead of one patch at a time.

## Open questions for the captain

- Is `wrapped` worth being its own state, or is it just "`idle` with an archive suggestion"? (It maps to today's `done_not_archived`; making it first-class is cleaner but adds a state.)
- Scope of the first cut: owned sessions only (biggest win, contained), leaving foreign sessions entirely on `deriveStatus`? I'd recommend yes - prove the FSM on the sessions we control before touching the heuristic.
- Persist the state, or recompute each `sessions:get` from the inputs (liveSessions + acknowledged + last message + classifier tag)? Recompute is simpler and stateless (no drift); the inputs are all already in memory. I lean recompute.
