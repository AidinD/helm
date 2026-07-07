// Unit test: projectBoardSummary maps project paths -> their Jot category board
// state (open/in-progress counts + lowest active priority for urgency), used by
// the Fleet retire nudge (trigger layer 3). Writes a temp todos.json.
//
// Run:  node scripts/e2e/test-jot-board-summary.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectBoardSummary } from "../../src/lib/jot.js";

const tmp = path.join(os.tmpdir(), "jot-board-test-" + Date.now());
fs.mkdirSync(tmp, { recursive: true });
const jotPath = path.join(tmp, "todos.json");
fs.writeFileSync(
  jotPath,
  JSON.stringify({
    categories: [
      { id: "c1", name: "Crewline", repoPath: "D:/Repo/tgs-crewline" },
      { id: "c2", name: "Jot", repoPath: "D:/Repo/jot" },
    ],
    todos: [
      { id: "t1", categoryId: "c1", status: "open", priority: -5 }, // urgent (negative)
      { id: "t2", categoryId: "c1", status: "open", priority: 2 },
      { id: "t3", categoryId: "c1", status: "done", priority: 0 },
      { id: "t4", categoryId: "c2", status: "done", priority: 0 },
      { id: "t5", categoryId: "c2", status: "review", priority: 0 },
    ],
  }),
  "utf8"
);

function log(...a) {
  console.log("[jot-board-summary-test]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const s = projectBoardSummary(["D:/Repo/tgs-crewline", "D:/Repo/jot/some/sub", "D:/Repo/unknown"], { path: jotPath });

assert(s["D:/Repo/tgs-crewline"].matched === true, "a project path matches its category by repoPath");
assert(s["D:/Repo/tgs-crewline"].open === 2, "open count reflects the category's open todos (got " + s["D:/Repo/tgs-crewline"].open + ")");
assert(s["D:/Repo/tgs-crewline"].minActivePriority === -5, "minActivePriority is the lowest (most urgent) active priority");
assert(s["D:/Repo/jot/some/sub"].matched === true, "a SUBFOLDER of a repoPath matches that category");
assert(s["D:/Repo/jot/some/sub"].open === 0 && s["D:/Repo/jot/some/sub"].minActivePriority === null, "a category with only done/review work reports no active work + null urgency");
assert(s["D:/Repo/unknown"].matched === false, "an unmatched path is neutral (matched:false), not an error");

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
log(exitCode === 0 ? "VERIFY OK: board summary maps paths, counts active work, surfaces urgency." : "VERIFY FAILED.");
process.exit(exitCode);
