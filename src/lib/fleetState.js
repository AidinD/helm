import path from "node:path";
import { resolveSecondMateId } from "./secondMates.js";

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
      const status = r.status === "running" ? "running" : r.status || "unknown";
      const needsCaptain = !!r.escalation || status === "error" || (status === "done" && commits > 0);
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
