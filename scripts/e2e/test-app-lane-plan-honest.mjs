// The app lane's exclusion list cannot quietly become a way to be green.
//
// scripts/ci-app-lane-plan.mjs decides which app checks CI runs and names the eight it does
// not. That file is the one place in this repo where "do not run this" is written down, which
// makes it the one place where a green tick could be bought by adding a name - so the
// properties below are asserted rather than trusted:
//
//   1. RUN and EXCLUDED partition the lane exactly. Nothing is in both, nothing is in
//      neither, and the printed total is the real total - so an exclusion is subtracted from
//      the claim rather than hidden inside it.
//   2. An exclusion is never printed as something that ran.
//   3. Every exclusion carries a reason AND a condition for removing it. A list of bare names
//      is how this rots: nobody can tell whether an entry is still true.
//   4. A name that no longer matches a file is a HARD ERROR, not a warning. This is the
//      failure mode that turns the list into fiction, and it is checked by breaking the list
//      and watching the script refuse - the guard is proved, not read.
//
// Pure check: reads and runs a script, never launches the app.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const PLAN = path.join(repo, "scripts", "ci-app-lane-plan.mjs");
const E2E = path.join(repo, "scripts", "e2e");

let failures = 0;
function check(condition, what) {
  if (condition) {
    console.log(`PASS  ${what}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${what}`);
  }
}

function runPlan(scriptPath) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], { encoding: "utf8", windowsHide: true });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout || "", stderr: err.stderr || "" };
  }
}

assert.ok(fs.existsSync(PLAN), `the lane plan exists at ${PLAN}`);

const plan = runPlan(PLAN);
check(plan.code === 0, `the plan runs clean on this tree (exit ${plan.code})${plan.code === 0 ? "" : `: ${plan.stderr.trim()}`}`);

const lines = plan.stdout.split("\n");
const ran = lines.filter((l) => l.startsWith("RUN ")).map((l) => l.slice(4).trim());
const note = lines.filter((l) => l.startsWith("NOTE")).map((l) => l.replace(/^NOTE ?/, ""));

// The lane, discovered independently of the plan - the same rule the repo's own runner uses.
// A second implementation is normally the thing to avoid; here it is the point, because the
// plan's total is only worth anything if something else counted it.
const lane = fs
  .readdirSync(E2E)
  .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
  .filter((f) => /^\s*(?:import\s|const\s*\{[^}]*\}\s*=\s*await\s+import\()[^\n]*harness\.mjs/m.test(fs.readFileSync(path.join(E2E, f), "utf8")));

const src = fs.readFileSync(PLAN, "utf8");
const excluded = [...src.matchAll(/^\s*"(test-[a-z0-9-]+\.mjs)":\s*\{/gm)].map((m) => m[1]);

check(excluded.length > 0, `the exclusion list is readable from the source (${excluded.length} entries)`);

// 1. A partition, both ways.
const overlap = ran.filter((f) => excluded.includes(f));
check(overlap.length === 0, `nothing is both run and excluded${overlap.length ? `: ${overlap.join(", ")}` : ""}`);

const missing = lane.filter((f) => !ran.includes(f) && !excluded.includes(f));
check(
  missing.length === 0,
  `every app check is either run or excluded by name - none falls through silently${missing.length ? `: ${missing.join(", ")}` : ""}`
);

check(
  ran.length + excluded.length === lane.length,
  `run + excluded equals the lane (${ran.length} + ${excluded.length} = ${ran.length + excluded.length}, lane is ${lane.length})`
);

// 2. The printed claim states the real total and subtracts, rather than reporting the smaller
// number as if it were everything.
const totalLine = note.find((l) => /checks launch the real app/.test(l)) || "";
check(
  totalLine.includes(String(lane.length)) && totalLine.includes(String(ran.length)),
  `the printed claim names BOTH the lane's real size and how many ran (${JSON.stringify(totalLine.trim())})`
);
check(
  note.some((l) => /neither passed nor failed/i.test(l)),
  "and says outright that an excluded check is neither passed nor failed"
);
check(
  !note.some((l) => /\bpass(ed)?\b/i.test(l) && /excluded/i.test(l) && !/neither/i.test(l)),
  "no line describes an excluded check as having passed"
);

// 3. A reason and a way out, for every single one.
for (const name of excluded) {
  const printed = note.findIndex((l) => l.trim() === `- ${name}`);
  const body = printed === -1 ? [] : note.slice(printed + 1, printed + 3).map((l) => l.trim());
  check(printed !== -1, `${name} is printed in the report rather than only living in the source`);
  check(
    body.some((l) => l.length > 25 && !l.startsWith("remove from this list when:")),
    `${name} says WHY it cannot run, in a sentence`
  );
  check(
    body.some((l) => l.startsWith("remove from this list when:") && l.length > 40),
    `${name} says what would have to be true to run it again - an exclusion with no way out is permanent by accident`
  );
}

// 4. Break the list and watch it refuse. A phantom name is the failure that matters: the file
// gets renamed or deleted, the exclusion stays, and the lane silently stops covering something
// while the report keeps explaining why it does not.
const mutantPath = path.join(repo, "scripts", `ci-app-lane-plan.__mutant-${crypto.randomBytes(4).toString("hex")}.mjs`);
const before = crypto.createHash("sha256").update(src).digest("hex");
try {
  const anchor = `"${excluded[0]}": {`;
  assert.equal(src.split(anchor).length - 1, 1, `the anchor ${JSON.stringify(anchor)} appears exactly once, so the mutation lands where intended`);
  // Written as a sibling in the same directory on purpose: the plan resolves the e2e directory
  // relative to its own location, so a copy anywhere else would be testing path resolution
  // rather than the guard.
  fs.writeFileSync(mutantPath, src.replace(anchor, `"test-this-file-does-not-exist.mjs": {`));
  const mutant = runPlan(mutantPath);
  check(mutant.code !== 0, `a stale exclusion name makes the plan REFUSE rather than warn (exit ${mutant.code})`);
  check(
    /test-this-file-does-not-exist\.mjs/.test(`${mutant.stderr}${mutant.stdout}`),
    "and it names the offending entry, so the fix is obvious without reading the script"
  );
  check(
    !/^RUN /m.test(mutant.stdout),
    "and it emits no list at all when it refuses - a partial list is how a broken plan still runs something"
  );
} finally {
  if (fs.existsSync(mutantPath)) {
    fs.unlinkSync(mutantPath);
  }
  const after = crypto.createHash("sha256").update(fs.readFileSync(PLAN, "utf8")).digest("hex");
  assert.equal(after, before, "the real plan file is byte-identical to how this check found it");
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log(`VERIFY OK - the lane is ${lane.length} checks, ${ran.length} run and ${excluded.length} excluded with a reason and a way out`);
