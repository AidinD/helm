// The CI workflows have an ordering rule, and breaking it is invisible until CI runs.
//
// THE TRAP, which bit twice in one day in two different workflows.
// Helm declares `keel` as `file:../keel`. On a runner there is no sibling directory beside the
// repo, so the workflows check keel out straight into node_modules instead. Any `npm install`
// after that point reads the manifest, finds the target missing, and PRUNES what was checked
// out - replacing it with a dangling symlink that actions/checkout then cannot even write into
// ("ENOENT: mkdir node_modules\keel").
//
// It cost the app lane two runs while it was being built, and then cost the pure lane 53 red
// checks the moment an eslint install was added to it - by somebody who had written the
// comment about it in the other file an hour earlier. A rule that lives only in a comment is a
// reminder; this makes it a control.
//
// WHY IT CANNOT BE CAUGHT LOCALLY ANY OTHER WAY. A developer machine HAS the sibling, so npm
// prunes nothing and every local run is green no matter what order the steps are in. The
// failure exists only where the sibling is absent, which is precisely where nobody is watching.
// Reading the YAML is the only way to know before pushing.
//
// This is a text check on a config file, so it is deliberately narrow: it asserts the ORDER of
// named steps, not that the workflow works. What the workflow does is CI's business.
//
// WHERE THAT NARROWNESS BITES, stated because a mutation found it rather than left implied: a
// step disabled at RUNTIME - `if: false`, or a condition that turns out never to hold - still
// reads as present here and the check stays green. Order is visible in the text; whether a step
// executes is not. Nothing in this file should be read as "the workflow will do this", only as
// "the steps are written in an order that cannot delete the sibling".
//
// Run:  node scripts/pure-checks/test-workflow-step-order.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS = path.join(repo, ".github", "workflows");

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

const files = fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
ok(files.length > 0, `there are workflows to check (${files.length})`);

for (const file of files) {
  const text = fs.readFileSync(path.join(WORKFLOWS, file), "utf8");
  // Steps in order, by the line that names them. Comments are stripped first: every one of
  // these workflows EXPLAINS this trap in prose, and a scan that reads a comment would find
  // "npm install" in the explanation and fail the file for describing the rule it follows.
  const body = text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  const lines = body.split("\n");
  const stepAt = (pattern) => lines.findIndex((l) => pattern.test(l));
  // EVERY install, not the first. The earlier version looked only at the earliest one, and a
  // mutation walked straight past it - which is also the shape of the real bug: the workflow
  // installed nothing, somebody ADDED an install step, and they added it in the obvious place,
  // after the checkout. A rule about "the install" cannot see a second one.
  const allInstalls = lines.reduce((acc, l, i) => (/^\s+run:.*\bnpm (install|ci)\b/.test(l) ? [...acc, i] : acc), []);
  const installsNpm = allInstalls.length > 0 ? allInstalls[0] : -1;
  const checksOutKeel = stepAt(/^\s+repository:\s*\S+\/keel\s*$/);

  if (checksOutKeel === -1) {
    ok(true, `${file}: does not place keel by hand, so the pruning rule does not apply`);
    continue;
  }

  if (installsNpm === -1) {
    ok(true, `${file}: checks keel out and never runs npm, so nothing can prune it`);
    continue;
  }

  const afterCheckout = allInstalls.filter((i) => i > checksOutKeel);
  ok(
    afterCheckout.length === 0,
    `${file}: EVERY npm install runs before keel is checked out (${allInstalls.length} install(s) at ${allInstalls
      .map((i) => i + 1)
      .join(", ")}, keel at ${checksOutKeel + 1})` +
      (afterCheckout.length === 0
        ? ""
        : ` - the one(s) at ${afterCheckout.map((i) => i + 1).join(", ")} would delete it, and every check that touches a durable store dies`)
  );

  // And the link npm leaves behind has to be cleared, or actions/checkout cannot write there.
  const clearsLink = stepAt(/^\s+run:.*rm -rf node_modules\/keel/) !== -1 || /rm -rf node_modules\/keel/.test(body);
  ok(
    clearsLink,
    `${file}: clears the dangling link npm leaves at node_modules/keel before checking keel out - without it the checkout fails with ENOENT`
  );
  const clearAt = lines.findIndex((l) => /rm -rf node_modules\/keel/.test(l));
  if (clearsLink && clearAt !== -1) {
    ok(
      installsNpm < clearAt && clearAt < checksOutKeel,
      `${file}: and it clears BETWEEN the install and the checkout (install ${installsNpm + 1}, clear ${clearAt + 1}, keel ${checksOutKeel + 1})`
    );
  }
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log(`VERIFY OK - ${files.length} workflow(s), and none of them installs over the sibling it placed by hand`);
