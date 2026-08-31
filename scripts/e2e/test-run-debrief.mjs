/**
 * A run that did not reach its goal has to say why in words somebody can act on.
 *
 * The case this was written from, 2026-08-30. A crew run stopped and reported:
 *
 *   two_consecutive_failures
 *   Iteration timed out after 900000ms
 *
 * Both true, neither usable. The sentence that mattered - both iterations died the
 * same way, so retrying will hit the same wall - took half an hour of reading
 * transcripts to reconstruct, from information the run record already held.
 *
 * Also pinned here: a dispatched run leaves a review record on its card. Until this
 * landed, the auto-captain was the only writer in the app, and 33 of 33 tasks sitting
 * in review had no record at all.
 */
import fs from "node:fs";
import { buildRunDebrief } from "../../src/lib/runDebrief.js";

let failures = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    failures += 1;
  }
};

const ELEVEN_STEPS = Array.from({ length: 11 }, (_, i) => `## Step ${i + 1} - something`).join("\n");

// --- the run that caused this ------------------------------------------------------
{
  const d = buildRunDebrief({
    result: {
      stoppedReason: "two_consecutive_failures",
      commitCount: 5,
      branchName: "helm/goal-4a6fd7b4",
      iterations: [
        { iteration: 1, ok: true, result: { success: true }, plan: ELEVEN_STEPS },
        { iteration: 6, ok: false, error: "Iteration timed out after 900000ms" },
        { iteration: 7, ok: false, error: "Iteration timed out after 900000ms" },
      ],
    },
  });

  ok(/timed out after 900000ms/.test(d.blocked), "the underlying error reaches the reader, not just the rule that fired");
  ok(/same way/.test(d.blocked), "and it says the failures were the SAME failure", d.blocked?.slice(0, 60));
  ok(/same wall/.test(d.blocked), "which is the actionable half: retrying as-is will not help");
  ok(/5 commits on branch helm\/goal-4a6fd7b4/.test(d.where), "where the work is, in findable terms", d.where);
  ok(/11 steps/.test(d.remaining), "how big the plan was", d.remaining?.slice(0, 50));
  ok(d.lines.length === 3, "three answers, ready to put in front of a person", `lines=${d.lines.length}`);
}

// --- a process that died vs a model that reported failure ---------------------------
// They need different responses, so they must never collapse into "it failed".
{
  const died = buildRunDebrief({
    result: { stoppedReason: "two_consecutive_failures", commitCount: 0, iterations: [{ ok: false, error: "spawn ENOENT" }] },
  });
  const said = buildRunDebrief({
    result: {
      stoppedReason: "two_consecutive_failures",
      commitCount: 0,
      iterations: [{ ok: true, result: { success: false, summary: "the migration script has no rollback" } }],
    },
  });
  ok(/process itself died/.test(died.blocked), "a dead process is named as one", died.blocked?.slice(0, 55));
  ok(/spawn ENOENT/.test(died.blocked), "with its error");
  ok(/did not succeed/.test(said.blocked), "a reported failure is named differently", said.blocked?.slice(0, 55));
  ok(/no rollback/.test(said.blocked), "and carries what the attempt actually said");
  ok(died.blocked !== said.blocked, "the two are not the same sentence");
}

// --- what it must NOT say ----------------------------------------------------------
{
  const d = buildRunDebrief({
    result: {
      stoppedReason: "max_iterations_reached",
      commitCount: 3,
      branchName: "b",
      iterations: [{ ok: true, result: { success: true }, plan: ELEVEN_STEPS }],
    },
  });
  // Which steps remain lives only in the agent's own notes. Inferring it from the
  // commit count would be a guess dressed as a fact - the exact failure this exists
  // to end - so the count is stated and the naming is not.
  ok(!/Step 4|Step 9|steps 4/i.test(d.remaining || ""), "it does not name which steps are left", d.remaining?.slice(0, 60));
  ok(/notes\.md/.test(d.remaining || ""), "it points at where that answer actually lives");
}

// --- a run that succeeded gets no debrief ------------------------------------------
{
  const d = buildRunDebrief({ result: { stoppedReason: "goal_reached", commitCount: 3, branchName: "b", iterations: [] } });
  ok(d.lines.length === 0, "a run that reached its goal is not explained away", `lines=${d.lines.length}`);
  ok(d.blocked === null, "and nothing claims it was blocked");
}

// --- degenerate input must not throw ------------------------------------------------
{
  let threw = null;
  try {
    buildRunDebrief({});
    buildRunDebrief({ result: {} });
    buildRunDebrief({ result: { stoppedReason: "cancelled", iterations: null } });
  } catch (err) {
    threw = err;
  }
  ok(threw === null, "a half-written result does not take down the report path", threw ? String(threw.message) : "");
}

// --- wired in ----------------------------------------------------------------------
{
  const main = fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
  ok(/const debrief = buildRunDebrief\(\{ result \}\)/.test(main), "the dispatch report builds one");
  ok(/\.\.\.debrief\.lines/.test(main), "and puts it in front of the reader, not only in a field");

  ok(/writeDispatchedReviewRecord\(\{ request, result, report \}\)/.test(main), "a finished dispatched run writes a review record");
  const fn = main.slice(main.indexOf("function writeDispatchedReviewRecord("));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  ok(/buildAutoReviewRecord\(/.test(body), "using the SAME builder as the auto path, not a second record shape");
  ok(/if \(!taskId \|\| commits <= 0\)/.test(body), "only when there is a card to write on and something to review");
  ok(/catch \(err\)/.test(body), "best-effort: it cannot take the dispatch path down with it");

  const mcp = fs.readFileSync(new URL("../../src/mcp/helmDispatchServer.js", import.meta.url), "utf8");
  ok(/taskId: \{/.test(mcp), "helm_dispatch accepts the task id a record needs");
  ok(/taskId: typeof args\.taskId === "string"/.test(mcp), "and carries it onto the request");
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: a run that did not finish says why, where the work is, and how much of the plan was paid for.");
