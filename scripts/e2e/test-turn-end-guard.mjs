/**
 * A first mate that did the project's work itself instead of delegating it.
 *
 * ## The gap
 *
 * The tier guard stops a first mate WRITING to a project, and that was always the smaller
 * half. Haddock's signature was not the writes: 82 Bash calls from the coordinator's seat
 * with ZERO delegations, and 180,000 tokens across nine turns. Under the write guard alone
 * that run would have read its way through the whole project for just as long, only unable
 * to save the result. The damage was made quieter, not smaller.
 *
 * The guard keys on the ABSENCE of dispatch metadata, which is what makes it survive any
 * renaming or restructuring of the tiers: "work that is not registered anywhere" stays
 * detectable in a way that "a first mate may not run Bash" does not.
 *
 * ## What this check is for
 *
 * A threshold is a claim about the world. This one came from 597 real turns in Helm's own
 * usage log, and the assertions below pin both directions of it - the shapes that must be
 * flagged and the shapes that must stay silent - because the failure mode of an attention
 * signal is not missing one, it is firing so often that the real one is skipped.
 *
 * Run: node scripts/e2e/test-turn-end-guard.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeTurnEnd, ACTION_TOOLS, DELEGATION_TOOLS, UNDELEGATED_ACTION_LIMIT, DELEGATING_SEATS } from "../../src/lib/turnEndGuard.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const mainSrc = fs.readFileSync(path.join(here, "..", "..", "src", "main.js"), "utf8");
const rendererSrc = fs.readFileSync(path.join(here, "..", "..", "src", "renderer", "renderer.js"), "utf8");

const times = (tool, n) => Array.from({ length: n }, () => tool);

// --- Haddock, the run this exists for ------------------------------------------------------
{
  const verdict = judgeTurnEnd({ seat: "first-mate", toolsUsed: [...times("Bash", 82), ...times("Read", 40)] });
  ok(!!verdict, "82 Bash calls from a first mate with no delegation is flagged");
  ok(!!verdict && verdict.actionCalls === 82, "counting the action calls and not the reads");
  ok(!!verdict && /82 Bash/.test(verdict.reason), "and the finding names what was actually run, not just a total");
  ok(!!verdict && !/\bRead\b/.test(verdict.reason), "reads are not held against it - a coordinator has to read to decide what to delegate");
}

// --- the shapes that must stay silent ---------------------------------------------------------
{
  ok(
    judgeTurnEnd({ seat: "first-mate", toolsUsed: [...times("Bash", 82), "mcp__helm-dispatch__helm_dispatch"] }) === null,
    "the same turn WITH a dispatch is silent - handing out the work and then checking something is working"
  );
  ok(judgeTurnEnd({ seat: "first-mate", toolsUsed: times("Bash", 9) }) === null, `nine action calls is under the limit of ${UNDELEGATED_ACTION_LIMIT}`);
  ok(judgeTurnEnd({ seat: "first-mate", toolsUsed: times("Read", 200) }) === null, "reading two hundred files is not doing the work");
  ok(judgeTurnEnd({ seat: "first-mate", toolsUsed: [] }) === null, "a turn that used no tools at all is silent");
  // Crew is the tier that is MEANT to do the work; the captain is a person.
  ok(judgeTurnEnd({ seat: "crew", toolsUsed: times("Bash", 200) }) === null, "crew doing two hundred things is crew working, not a finding");
  ok(judgeTurnEnd({ seat: "captain", toolsUsed: times("Bash", 200) }) === null, "and the captain's own seat is never judged");
  ok(judgeTurnEnd({ seat: "second-mate", toolsUsed: times("Bash", 200) }) === null, "nor is a second mate, which owns a project and has not been shown to need this rule");
  ok(judgeTurnEnd({}) === null, "and a call with nothing in it does not throw");
}

// --- the boundary, exactly -----------------------------------------------------------------------
{
  ok(judgeTurnEnd({ seat: "first-mate", toolsUsed: times("Edit", UNDELEGATED_ACTION_LIMIT - 1) }) === null, "one below the limit is silent");
  ok(!!judgeTurnEnd({ seat: "first-mate", toolsUsed: times("Edit", UNDELEGATED_ACTION_LIMIT) }), "the limit itself flags");
  // Mixed, because the real shape is never one tool.
  const mixed = judgeTurnEnd({ seat: "first-mate", toolsUsed: [...times("Bash", 6), ...times("Edit", 3), ...times("Write", 2), ...times("Grep", 50)] });
  ok(!!mixed && mixed.actionCalls === 11, "action calls add up across tools");
  ok(!!mixed && mixed.tools[0] === "6 Bash", "and the breakdown is worst first");
}

// --- creating a seat is not delegating ------------------------------------------------------------
{
  // The exact behaviour being looked for: make a mate, then do everything yourself.
  const verdict = judgeTurnEnd({ seat: "first-mate", toolsUsed: ["mcp__helm-dispatch__helm_create_second_mate", ...times("Bash", 30)] });
  ok(!!verdict, "creating a second mate and then doing all the work yourself is still flagged");
  ok(!DELEGATION_TOOLS.test("mcp__helm-dispatch__helm_create_second_mate"), "because making a seat is setup, not delegation");
  for (const tool of ["mcp__helm-dispatch__helm_dispatch", "mcp__helm-dispatch__helm_relay_to_second_mate", "mcp__helm-dispatch__helm_resume_crew"]) {
    ok(DELEGATION_TOOLS.test(tool), `${tool.split("__").pop()} does count as delegating`);
  }
}

// --- the thresholds are claims, and they carry their evidence ---------------------------------------
{
  const libSrc = fs.readFileSync(path.join(here, "..", "..", "src", "lib", "turnEndGuard.js"), "utf8");
  ok(/597 real turns/.test(libSrc), "the limit states the measurement it came from");
  ok(/action calls per turn:\s+0 → 174/.test(libSrc), "including the distribution, so it can be argued with");
  ok(/OVER-estimate/.test(libSrc), "and says where the measurement is looser than the rule it justifies");
  ok(DELEGATING_SEATS.size >= 1 && !DELEGATING_SEATS.has("crew"), "crew is not a delegating seat");
  ok(!ACTION_TOOLS.has("Read") && !ACTION_TOOLS.has("Grep"), "orientation tools are not action tools");
}

// --- it is actually wired, and it never blocks -------------------------------------------------------
{
  ok(/judgeTurnEnd\(\{ seat: firstMateId \? "first-mate" : "captain", toolsUsed: meta\.toolsUsed \}\)/.test(mainSrc), "main.js judges the turn with the seat it ran in");
  ok(/kind: "turnEndGuard", verdict/.test(mainSrc), "and sends the verdict to the renderer");
  ok(/type: "turnEndUndelegated"/.test(mainSrc), "and logs it, because a signal nobody can count is a signal nobody can tune");
  ok(/evt\.kind === "turnEndGuard"[\s\S]{0,200}showNotice/.test(rendererSrc), "the renderer shows it");
  // The guard runs after the turn is over. If it could refuse anything it would be a second
  // place that can stop work, and the tier guard is where prevention belongs.
  ok(
    !/judgeTurnEnd[\s\S]{0,400}\b(kill|abort|throw new Error|child\.kill)\b/.test(mainSrc),
    "and nothing near it kills, aborts or throws - this reports, it does not prevent"
  );
}

console.log("");
console.log(exit === 0 ? "VERIFY OK: a coordinator that became the worker says so, and everything else stays quiet." : "VERIFY FAILED.");
process.exit(exit);
