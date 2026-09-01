/**
 * A renderer display key must not reach durable state, and must not reach the shared picture.
 *
 * ## What a display key is, and why it kept being written down
 *
 * The renderer names a captain's own project session `sess_<id>`. That is a way of labelling
 * a node on screen, not an identity, and it kept arriving as a run's `dispatchedBy` and being
 * written to the run history.
 *
 * The fix on 2026-08-17 taught the READ side to route them. That cleared the symptom and made
 * two id namespaces permanent: every new reader has to know the exception, and the count kept
 * growing. Measured 2026-08-18 and unchanged on 2026-09-01 - eleven runs in the installed
 * store keyed that way, and fleet-state.json carrying all eleven into the picture other mates
 * read.
 *
 * ## Where the translation belongs
 *
 * At the single writer, not at the three places that build a record. Three copies of one
 * translation drift, and the copy that drifts is the one still writing the wrong key. Putting
 * it at the writer also means an old record normalises as it is touched, so the count can
 * only shrink.
 *
 * Run: node scripts/e2e/test-display-keys-never-persist.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

// Its own store. The seam is read at import time, so it is set before the import below.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-displaykeys-"));
const historyPath = path.join(tmp, "goal-run-history.json");
process.env.HELM_GOAL_RUN_HISTORY_PATH = historyPath;
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");

const { upsertGoalRunRecord, loadGoalRunHistory } = await import("../../src/lib/goalRunHistory.js");
const { secondMateId, DIRECT_FIRST_MATE, isDisplaySecondMateId } = await import("../../src/lib/secondMates.js");
const { buildFleetState } = await import("../../src/lib/fleetState.js").catch(() => ({}));

const PROJECT = "D:/Repo/Some/project";
const DISPLAY_KEY = "sess_3436226e-1111-4000-8000-000000000000";
const EXPECTED = secondMateId(DIRECT_FIRST_MATE, PROJECT);

// --- a display key is translated on the way in ------------------------------------
{
  upsertGoalRunRecord({ goalRunId: "run-1", projectPath: PROJECT, dispatchedBy: DISPLAY_KEY, status: "done" });
  const stored = loadGoalRunHistory().find((r) => r.goalRunId === "run-1");
  ok(!!stored, "the record was written");
  ok(!isDisplaySecondMateId(stored.dispatchedBy), "and it is NOT keyed by the display key", stored.dispatchedBy);
  ok(stored.dispatchedBy === EXPECTED, "it is keyed by the durable identity the key stood for", stored.dispatchedBy);
}

// --- a real identity is left exactly alone -----------------------------------------
// The control. A translation that rewrote everything would pass the case above while
// destroying every correctly-keyed run in the file.
{
  const real = "sm_b1a895998008";
  upsertGoalRunRecord({ goalRunId: "run-2", projectPath: PROJECT, dispatchedBy: real, status: "done" });
  const stored = loadGoalRunHistory().find((r) => r.goalRunId === "run-2");
  ok(stored.dispatchedBy === real, "a second-mate id passes through untouched", stored.dispatchedBy);

  upsertGoalRunRecord({ goalRunId: "run-3", projectPath: PROJECT, dispatchedBy: "auto", status: "done" });
  ok(loadGoalRunHistory().find((r) => r.goalRunId === "run-3").dispatchedBy === "auto", "and so does the auto-captain's own id");

  upsertGoalRunRecord({ goalRunId: "run-4", projectPath: PROJECT, status: "done" });
  ok(loadGoalRunHistory().find((r) => r.goalRunId === "run-4").dispatchedBy === undefined, "a record with no dispatcher gains none");
}

// --- an unresolvable key is KEPT, not invented away ----------------------------------
// Resolving needs the project to know which node a session belongs to. Without one, writing
// a node at a guessed path would be worse than recording the key.
{
  upsertGoalRunRecord({ goalRunId: "run-5", dispatchedBy: DISPLAY_KEY, status: "done" });
  const stored = loadGoalRunHistory().find((r) => r.goalRunId === "run-5");
  ok(stored.dispatchedBy === DISPLAY_KEY, "with no project to resolve against, the key is kept rather than guessed at", stored.dispatchedBy);
}

// --- touching an old record cleans it, so the count can only shrink --------------------
{
  // A row written before the writer normalised - put there the way history already holds
  // eleven of them.
  const raw = JSON.parse(fs.readFileSync(historyPath, "utf8"));
  raw.push({ goalRunId: "legacy", projectPath: PROJECT, dispatchedBy: DISPLAY_KEY, status: "running" });
  fs.writeFileSync(historyPath, JSON.stringify(raw), "utf8");
  ok(loadGoalRunHistory().find((r) => r.goalRunId === "legacy").dispatchedBy === DISPLAY_KEY, "the legacy row starts out display-keyed");

  upsertGoalRunRecord({ goalRunId: "legacy", projectPath: PROJECT, dispatchedBy: DISPLAY_KEY, status: "done" });
  const after = loadGoalRunHistory().find((r) => r.goalRunId === "legacy");
  ok(after.dispatchedBy === EXPECTED, "and is normalised as it is touched", after.dispatchedBy);
}

// --- and the picture other mates read carries none either ------------------------------
{
  const src = fs.readFileSync(new URL("../../src/lib/fleetState.js", import.meta.url), "utf8");
  ok(/resolveSecondMateId\(r\.dispatchedBy/.test(src), "fleet-state translates the dispatcher on the way out");
  // Not just "it calls the function" - it must not also emit the raw one anywhere.
  ok(!/mate: r\.dispatchedBy,/.test(src), "and no longer writes the raw key as `mate`");
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: a display key is translated at the writer, a real identity is untouched, and an unresolvable one is kept rather than invented.");
