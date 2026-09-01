/**
 * A crew run must not be the only thing that read its own work.
 *
 * ## The gap
 *
 * The loop ends when the agent's own structured output says goalReached. That is the builder
 * marking its own homework, and this project knows what that produces: 22 of 23 crew reports
 * said done without having reached the goal (2026-08-18).
 *
 * An outside signal exists - verifyCommand - and it is opt-in. Measured on the real store
 * 2026-09-01: 56 runs, 108 review records, and not one carries the check a declared verify
 * gate writes. Three places that would show it show nothing. An optional control with no
 * observed use is a setting, not a control.
 *
 * ## What is checked here
 *
 * The seam, without spending a token: the reviewer is injected, so every case below drives
 * real git and a fake model.
 *
 * Two properties carry the weight. The reviewer must be a DIFFERENT model from the builder,
 * because "a second opinion from the same model" is not one. And a review that could not run
 * must never look like a review that found nothing - those are opposite facts, and rendering
 * them the same is how an absent check reads as a passed one.
 *
 * Run: node scripts/e2e/test-crew-review.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { reviewCrewRun, independentModel } from "../../src/lib/crewReview.js";
import { REVIEWER_MODELS } from "../../src/lib/reviewerModel.js";

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

// --- independence is enforced, not hoped for -------------------------------------
{
  const weakest = REVIEWER_MODELS[REVIEWER_MODELS.length - 1].value;
  const strongest = REVIEWER_MODELS[0].value;

  const different = independentModel(weakest, "some-other-model");
  ok(different.model === weakest, "a recommendation the builder did not use is kept as it is");
  ok(different.steppedUp === false, "and nothing is reported as stepped up");

  const collided = independentModel(weakest, weakest);
  ok(collided.model !== weakest, "when the recommendation IS the builder, it changes", collided.model);
  ok(collided.steppedUp === true, "and says it stepped up rather than doing it quietly");
  // Up, not down. The tier was chosen from the change's risk; answering that risk with
  // something cheaper because of a name collision is the wrong trade in the one direction
  // that matters.
  const rank = (m) => REVIEWER_MODELS.findIndex((x) => x.value === m);
  ok(rank(collided.model) < rank(weakest), "and it stepped UP, not down", `${weakest} -> ${collided.model}`);

  const atTop = independentModel(strongest, strongest);
  ok(atTop.model === strongest && atTop.steppedUp === false, "at the top with nothing stronger, it says so instead of pretending");
}

// --- a real run's diff, read by a fake model ---------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-crewreview-"));
const git = (...args) => execFileSync("git", ["-C", tmp, ...args], { encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "p@p");
git("config", "user.name", "p");
fs.writeFileSync(path.join(tmp, "rate.js"), "export const charge = (o) => o.hours;\n", "utf8");
git("add", "-A");
git("commit", "-q", "-m", "baseline");
const baseCommit = git("rev-parse", "HEAD").trim();
fs.writeFileSync(path.join(tmp, "rate.js"), "export const charge = (o) => o.hours * o.rate;\n", "utf8");
git("add", "-A");
git("commit", "-q", "-m", "charge by the rate as well as the hours");

/** A model that answers with one anchored finding. */
const answering = async (opts) => ({
  ok: true,
  model: opts.model,
  costUsd: 0.01,
  value: {
    findings: [{ file: "rate.js", snippet: "o.hours * o.rate", severity: "medium", why: "o.rate can be absent, giving NaN" }],
  },
});

{
  const seen = [];
  const result = await reviewCrewRun({
    worktreePath: tmp,
    baseCommit,
    goal: "Charge by the rate",
    builderModel: null,
    ask: async (opts) => {
      seen.push(opts);
      return answering(opts);
    },
  });
  ok(result.reviewed === true, "a run with commits gets read", result.why || "");
  ok(result.findings.length === 1, "and the finding comes back", `${result.findings.length}`);
  ok(result.findings[0].line.includes("o.rate"), "anchored to the line the run actually changed", result.findings[0].line?.trim());
  ok(result.changedLines > 0, "with the size of the change reported", String(result.changedLines));
  // The prompt has to contain the diff, or the model is being asked about nothing.
  ok(/o\.hours \* o\.rate/.test(seen[0]?.prompt || ""), "the diff really reached the model");
  ok(/Charge by the rate/.test(seen[0]?.prompt || ""), "and so did what the run was for");
}

// --- the builder does not review itself ---------------------------------------------
{
  let usedModel = null;
  const builder = REVIEWER_MODELS[REVIEWER_MODELS.length - 1].value;
  await reviewCrewRun({
    worktreePath: tmp,
    baseCommit,
    goal: "x",
    builderModel: builder,
    ask: async (opts) => {
      usedModel = opts.model;
      return answering(opts);
    },
  });
  ok(usedModel !== null && usedModel !== builder, "the reviewer is never the model that built", `builder ${builder}, reviewer ${usedModel}`);
}

// --- "could not look" is not "found nothing" -------------------------------------------
// The property that matters most. An absent check that renders like a passed one is the
// exact shape of every reliability finding in this repo.
{
  const refused = await reviewCrewRun({
    worktreePath: tmp,
    baseCommit,
    goal: "x",
    ask: async () => ({ ok: false, reason: "the model was unreachable" }),
  });
  ok(refused.reviewed === false, "a reviewer that could not answer is NOT reported as reviewed");
  ok(/unreachable/.test(refused.why || ""), "and the reason is carried, not swallowed", refused.why);
  ok(refused.findings.length === 0, "with no findings invented to fill the gap");

  const gone = await reviewCrewRun({
    worktreePath: path.join(tmp, "not-here"),
    baseCommit,
    goal: "x",
    ask: async () => {
      throw new Error("should never be asked");
    },
  });
  ok(gone.reviewed === false && typeof gone.why === "string", "a missing worktree reports why rather than throwing", gone.why);

  const nothingToRead = await reviewCrewRun({
    worktreePath: tmp,
    baseCommit: git("rev-parse", "HEAD").trim(),
    goal: "x",
    ask: async () => {
      throw new Error("should never be asked");
    },
  });
  ok(nothingToRead.reviewed === false, "a run with no diff is not sent to a model at all");
  ok(/no diff/.test(nothingToRead.why || ""), "and says that is why", nothingToRead.why);
}

// --- an empty answer is a real answer, and distinct from all of the above ---------------
{
  const clean = await reviewCrewRun({
    worktreePath: tmp,
    baseCommit,
    goal: "x",
    ask: async (opts) => ({ ok: true, model: opts.model, costUsd: 0.01, value: { findings: [], nothingStandsOut: "Small and self-contained." } }),
  });
  ok(clean.reviewed === true, "a reviewer that looked and found nothing IS reported as reviewed");
  ok(clean.findings.length === 0 && clean.nothingStandsOut === "Small and self-contained.", "with its sentence carried", clean.nothingStandsOut);
}

// --- and the run wires it in before anything is cleaned up -------------------------------
{
  const src = fs.readFileSync(new URL("../../src/lib/goalOrchestrator.js", import.meta.url), "utf8");
  const reviewAt = src.indexOf("review = await reviewer(");
  const cleanupAt = src.indexOf("removeWorktree(projectPath, worktreePath");
  ok(reviewAt > 0 && cleanupAt > 0, "both the review and the cleanup are in the run");
  // The order IS the feature. Reviewing after cleanup finds a clean tree, sees nothing, and
  // stops correctly having reviewed nothing.
  ok(reviewAt < cleanupAt, "and the review happens BEFORE the worktree can be removed");
  ok(/review,/.test(src), "the run returns what the reviewer said");

  // The join, which is the part that broke last time. Earlier today a feature shipped with
  // every piece working and the caller missing, so it existed everywhere except where
  // somebody would meet it. A reviewer nothing passes in is exactly that shape.
  const main = fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
  ok(/reviewer:/.test(main), "main.js actually passes a reviewer into the run");
  ok(/reviewCrewRun\(/.test(main), "and it is the real one, not a placeholder");
  // On by default. An optional check is what the measurement says does not get used.
  ok(
    /crewReview\?\.enabled === false/.test(main),
    "and it is off only when explicitly switched off, rather than on only when switched on"
  );
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: a finished run is read by a model that did not write it, before cleanup, and a review that could not run says so.");
