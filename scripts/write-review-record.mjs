/**
 * Write a review record for a task, from anywhere, with no app running.
 *
 * ## Why this exists
 *
 * Until now there was exactly ONE place in Helm that wrote a review record: the
 * auto-captain's finish path in main.js, and only for a run that produced commits.
 * No IPC handler wrote one, no MCP tool wrote one. So a session that had just done
 * a piece of work could not leave evidence behind even if it wanted to.
 *
 * The result, measured on the real board on 2026-08-31: 33 tasks in review, ZERO
 * with a record. Every row on the review page was a task nobody could judge, and
 * the app's only answer to that was a button to acknowledge it away.
 *
 * Nothing downstream works without this. Sorting the page (c22655c6) sorts an empty
 * list; making the text readable helps nobody when there is no text.
 *
 * ## Using it
 *
 *   node scripts/write-review-record.mjs record.json
 *   cat record.json | node scripts/write-review-record.mjs
 *   node scripts/write-review-record.mjs --template > record.json
 *
 * Refusals are the point, not an obstacle: this runs the SAME admissibility check
 * the app runs, so it cannot create a record the review page would then reject. A
 * refusal prints what is missing and changes nothing on disk.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveMetaHome } from "../src/lib/metaHome.js";
import { writeReviewRecord, readReviewRecord } from "../src/lib/reviewRecords.js";

const TEMPLATE = {
  taskId: "the Jot task id this is about",
  title: "what the task was called",
  verdict: "stamp",
  criticality: "cosmetic",
  whyNotCritical: "one sentence on why being wrong here is cheap - required unless critical",
  intent: { text: "what was actually asked for, in the asker's terms", source: "captain" },
  summary: "one line, in plain words, on what changed",
  projectPath: "D:/Repo/Tools/<repo>",
  evidence: ["what was run and what it said"],
  notVerified: ["what was NOT checked - the useful half"],
  testSteps: [{ step: "what to do", expect: "what should happen" }],
  checks: [{ label: "suite", cmd: "npm test" }],
};

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*| \* ?/gm, ""));
  process.exit(0);
}

if (args.includes("--template")) {
  console.log(JSON.stringify(TEMPLATE, null, 2));
  process.exit(0);
}

/** Read the record from a named file, or from stdin when piped. */
async function readInput() {
  const file = args.find((a) => !a.startsWith("-"));
  if (file) {
    return fs.readFileSync(path.resolve(file), "utf8");
  }
  if (process.stdin.isTTY) {
    console.error("Nothing to read. Pass a JSON file, or pipe one in.");
    console.error("  node scripts/write-review-record.mjs --template > record.json");
    process.exit(2);
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await readInput();
let record;
try {
  record = JSON.parse(raw);
} catch (err) {
  console.error(`That is not valid JSON: ${err.message}`);
  process.exit(2);
}

const metaHome = resolveMetaHome({ allowOverride: true });
const existing = readReviewRecord(metaHome, record.taskId);

const result = writeReviewRecord(metaHome, record);

if (!result.ok) {
  // The refusal IS the feature. A record that cannot be judged is worse than none:
  // it puts a row on the page that looks reviewed and is not.
  console.error("\nRefused, and nothing was written.\n");
  console.error(`  ${result.error}\n`);
  console.error("Run with --template to see the shape a record needs.");
  process.exit(1);
}

const where = path.join(metaHome, ".helm", "reviews", `${record.taskId}.json`);
console.log(existing ? "\nUpdated an existing record.\n" : "\nWrote a new record.\n");
console.log(`  task     ${record.taskId}`);
console.log(`  verdict  ${record.verdict} (${record.criticality})`);
console.log(`  file     ${where}`);
console.log("");
console.log("It will appear on the Review page the next time that page is built.");
if (Array.isArray(record.checks) && record.checks.length > 0) {
  console.log(`Its ${record.checks.length} declared check(s) have NOT been run - "Run checks" on the card does that.`);
}
