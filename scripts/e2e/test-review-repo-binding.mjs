// A board's OWN folder binding decides its review repo, not a name guess.
//
// Task 75a01d5d: "Review - verkar bara göra ordentliga reviews för helm". The gauntlet
// itself is project-agnostic (it runs off the record's projectPath); the gate was the
// DISPLAY filter. A review row is shown by default only when it is repo-rooted, and
// row.repoPath was set by a fuzzy match of the category NAME against the basenames of git
// folders Helm had happened to see. Helm is the one project that reliably resolved (it is
// the meta-home and never a session cwd, so it was backfilled from records); every other
// board fell through to null and was filtered out of the default view.
//
// Jot already stores an explicit Category.repoPath, but reviewTasks threw it away. This
// checks that the authoritative binding now reaches the review row, so a non-helm board
// with a bound folder is repo-rooted without depending on the guess.
//
// Run:  node scripts/e2e/test-review-repo-binding.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewTasks } from "../../src/lib/jot.js";
import { buildReviewQueue } from "../../src/lib/reviewRecords.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-repobind-"));
const todosPath = path.join(tmp, "todos.json");

// A board bound to a folder whose basename does NOT match its name (Skiff -> the folder
// nw-skiff), a board with no binding at all, and helm for contrast. The bound path is a
// real absolute-looking Windows path stored the way Jot stores it.
const BOUND = "D:\\Repo\\nw-skiff";
fs.writeFileSync(
  todosPath,
  JSON.stringify({
    categories: [
      { id: "cat-crew", name: "Skiff", repoPath: BOUND, domain: "work" },
      { id: "cat-none", name: "Loose board", domain: "private" },
    ],
    todos: [
      { id: "task-crew-0001", text: "A Skiff fix", status: "review", categoryId: "cat-crew" },
      { id: "task-none-0001", text: "An unbound task", status: "review", categoryId: "cat-none" },
    ],
    tags: [],
  }),
  "utf8"
);

try {
  const rt = reviewTasks({ path: todosPath });
  ok(rt.ok, `reviewTasks read the board (${rt.error || "ok"})`);
  const crewTask = rt.tasks.find((t) => t.id === "task-crew-0001");
  const noneTask = rt.tasks.find((t) => t.id === "task-none-0001");
  ok(!!crewTask && !!noneTask, "both review tasks are returned");
  ok(crewTask.categoryRepoPath === BOUND, `the bound board's explicit repoPath is threaded onto the task (${JSON.stringify(crewTask.categoryRepoPath)})`);
  ok(noneTask.categoryRepoPath === null, `an unbound board threads null, not a guess (${JSON.stringify(noneTask.categoryRepoPath)})`);

  // buildReviewQueue must carry it onto the row (no records -> no git touched).
  const rows = buildReviewQueue(rt.tasks, [], null);
  const crewRow = rows.find((r) => r.taskId === "task-crew-0001");
  const noneRow = rows.find((r) => r.taskId === "task-none-0001");
  ok(crewRow?.categoryRepoPath === BOUND, `the review row carries the binding (${JSON.stringify(crewRow?.categoryRepoPath)})`);
  ok(noneRow?.categoryRepoPath === null, "an unbound row carries null");

  // The payload builder must PREFER the explicit binding over the fuzzy guess. Checked at
  // the source because repoRootedCategories reads live sessions/records this unit cannot
  // stage - the one-liner is the whole contract.
  const mainSrc = fs.readFileSync(fileURLToPath(new URL("../../src/main.js", import.meta.url)), "utf8");
  ok(
    /row\.repoPath\s*=\s*row\.categoryRepoPath\s*\|\|\s*roots\.repoFor\(row\.category\)/.test(mainSrc),
    "buildReviewsPayload prefers the explicit Category.repoPath, falling back to the name guess"
  );
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: a board's explicit Category.repoPath reaches the review row, so a non-helm board with a bound folder is repo-rooted without the name guess."
    : "VERIFY FAILED."
);
process.exit(exit);
