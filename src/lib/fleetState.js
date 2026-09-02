import path from "node:path";
import { resolveSecondMateId } from "./secondMates.js";
import { annotateGoalRunRecord } from "./goalRunHistory.js";

// Fleet-aware focus survey (e07a2c5d). The two first mates are independent
// sessions with no shared context, and helm_collect_reports is scoped to a
// mate's OWN dispatches - so mate B can't see what mate A already has in flight
// and may propose overlapping focus. This assembles a compact, cross-mate view
// of the fleet (the active mates + every mate's dispatched work) that the app
// snapshots to disk and the helm_fleet_state MCP tool serves, so a surveying
// first mate can see what's already underway and propose COMPLEMENTARY work.
//
// Pure + compact by design (it lands in a mate's context): the active mates and
// a bounded list of recent dispatched runs across ALL mates, not full history.

const MAX_DISPATCHED = 40;

function basename(p) {
  return path.basename(p || "") || p || "";
}

/**
 * Builds the compact fleet state from the active mates + the global goal-run
 * history. Each dispatched run is reduced to what a coordinator needs to avoid
 * overlap: which mate dispatched it, the project, status, and whether it awaits
 * the captain. Newest first, bounded to MAX_DISPATCHED.
 */
export function assembleFleetState(mates, runHistory, now) {
  const dispatched = (runHistory || [])
    .filter((r) => r && r.dispatchedBy && r.projectPath)
    .map((r) => {
      const commits = typeof r.commitCount === "number" ? r.commitCount : 0;
      // ONE rule for what a run's outcome was, not a second spelling of it.
      //
      // This file used to read the STORED `status` and re-derive `needsCaptain` from its own
      // formula. Both were wrong in the same direction: measured 2026-09-02, 48 of 56
      // records say `status: "done"` and 34 of those did not finish - so the cross-mate
      // picture other mates read has been calling failed work done. And the local formula
      // (`error`, or `done` with commits) is a third copy of a rule `runOutcome.js` owns.
      //
      // Fixing only one half would have been worse than fixing neither: feeding the truthful
      // status into the old formula turns a `failed` run WITH commits into
      // needsCaptain:false, which suppresses a real attention signal. So both come from the
      // annotation, which derives them through `classifyRunOutcome`.
      //
      // The annotation is applied here if the caller has not already applied it, so a caller
      // passing raw records cannot silently get a different answer than one going through
      // `loadGoalRunHistory`. There is deliberately no fallback formula: a fallback IS the
      // second spelling.
      const annotated = r.outcome ? r : annotateGoalRunRecord(r);
      // Liveness is a different question from outcome, and the annotation cannot answer it:
      // it reads a record still marked "running" as interrupted, which is right for a corpse
      // and wrong for a run genuinely in flight. Whether a process is alive is decided by pid
      // elsewhere, so "running" wins here rather than being reclassified.
      const status = r.status === "running" ? "running" : annotated.outcome.status;
      // CAREFUL: `runOutcome`'s `needsCaptain` is a MESSAGE, not a flag - it is null when the
      // run simply worked, and prose when something has to be explained or decided. This
      // file's field of the same name is a boolean. Two concepts, one name, different types,
      // and wiring them straight through puts prose into a field every reader treats as
      // yes/no. Found by a test rather than by reading, which is the only reason it is not
      // in the shipped picture.
      //
      // They also answer different questions, and the difference is load-bearing. A run that
      // reached its goal with commits needs no explanation, so the message is null - but it
      // does need a human to review and merge it, and that is exactly what a surveying mate
      // must not overlook. So the flag is "there is a message" OR "finished work is sitting
      // there unreviewed", which is what the old local formula was reaching for.
      const captainMessage = annotated.outcome.needsCaptain;
      // An escalation is never suppressed, whatever else is true. It is the one state that
      // exists specifically to say a human has to look.
      const needsCaptain =
        !!r.escalation ||
        (r.status === "running"
          ? false
          : Boolean(captainMessage) || (annotated.outcome.status === "done" && commits > 0));
      return {
        // Translated on the way out, not passed through. History still holds rows written
        // before the writer normalised, and this file is the picture OTHER mates read - so a
        // display key here would keep spreading through readers that never saw the run.
        mate: resolveSecondMateId(r.dispatchedBy, r.projectPath) || r.dispatchedBy,
        project: basename(r.projectPath),
        status,
        commits,
        needsCaptain,
        branch: r.branchName || null,
        updatedAt: r.updatedAt || r.startedAt || null,
      };
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_DISPATCHED);

  return {
    updatedAt: now,
    mates: (mates || []).map((m) => ({ mateId: m.mateId, name: m.name, slot: m.slot ?? null })),
    dispatched,
    // Small rollups a surveying mate can use directly.
    liveByProject: rollup(dispatched.filter((d) => d.status === "running")),
    needsCaptainByProject: rollup(dispatched.filter((d) => d.needsCaptain)),
  };
}

function rollup(runs) {
  const byProject = {};
  for (const r of runs) {
    byProject[r.project] = (byProject[r.project] || 0) + 1;
  }
  return byProject;
}
