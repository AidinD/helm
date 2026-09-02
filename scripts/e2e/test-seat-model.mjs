/**
 * One seat, one model - whichever door you come in through.
 *
 * ## What was wrong
 *
 * Measured in a second mate's own transcript on 2026-08-18: 426 turns on Sonnet 5, 12 on
 * Opus, in a seat whose manual opened by telling it "You run on the capable model (Opus)".
 * The sentence is gone now. The mechanism underneath it was the odder half:
 *
 *   - jumping in launched the seat with whatever the composer's picker happened to say
 *   - relaying to the SAME seat launched it with a `"claude-opus-4-8"` written into the call
 *
 * The twelve Opus turns were the relays. Not a setting anybody chose - two code paths that
 * had never been compared.
 *
 * ## the captain's decision, 2026-09-02
 *
 * "ta bort hårdkodningen ... dess default inställning i pickern bör vara opus men den ska gå
 * efter pickerns val om jag ändrar."
 *
 * So: a default per tier, and the picker wins. What this check adds on top of that is the
 * part that makes "the picker wins" true over TIME - a seat's recorded model beats the tier
 * default, or changing the model would hold only until the next relay put it back.
 *
 * Run: node scripts/e2e/test-seat-model.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL_BY_TIER, defaultModelForTier, modelForSeat } from "../../src/lib/tierModels.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, "..", "..", ...p), "utf8");
const mainSrc = read("src", "main.js");
const rendererSrc = read("src", "renderer", "renderer.js");

// --- the defaults themselves ------------------------------------------------------------
{
  ok(defaultModelForTier("second-mate") === "claude-opus-4-8", "a project seat starts on Opus - it is the judgment tier");
  ok(defaultModelForTier("first-mate") === "claude-sonnet-5", "the delegate-and-summarize tier starts on Sonnet");
  // Null, not another tier's answer: a tier nobody has decided for must fall through to the
  // app's own default rather than silently inherit one.
  ok(defaultModelForTier("crew") === null, "a tier with no decision returns null rather than borrowing one");
  ok(defaultModelForTier(undefined) === null, "and so does a missing tier, without throwing");
}

// --- the picker wins, and keeps winning -----------------------------------------------------
{
  ok(modelForSeat("second-mate", null) === "claude-opus-4-8", "a seat that has never run gets the tier default");
  ok(
    modelForSeat("second-mate", "claude-sonnet-5") === "claude-sonnet-5",
    "a seat whose session already ran on Sonnet keeps Sonnet - the choice is not reverted by the next relay"
  );
  ok(modelForSeat("second-mate", "claude-haiku-4-5-20251001") === "claude-haiku-4-5-20251001", "including a deliberately cheap choice");
  ok(modelForSeat("second-mate", "") === "claude-opus-4-8", "an empty recorded model is no opinion, not a choice");
}

// --- the hardcoding is gone from the relay ----------------------------------------------------
{
  // The literal itself, in the file that had it. Not a general ban: the tier table names the
  // same string, and that is the one place it should appear.
  ok(!/model: "claude-opus-4-8"/.test(mainSrc), "no launch in main.js names a model literally any more");
  ok(/model: seatModel/.test(mainSrc), "the relay launches on the seat's resolved model");
  ok(/modelForSeat\("second-mate", recordedModelFor\(resumeSessionId\)\)/.test(mainSrc), "resolved from the session it is about to resume, not from a constant");
  // The record and the launch must not disagree - a record naming a different model from the
  // one that ran is how this was misreported for two days in the first place.
  const launchAt = mainSrc.indexOf("const seatModel = modelForSeat(");
  const recordAt = mainSrc.indexOf("model: seatModel,");
  ok(launchAt > 0 && recordAt > launchAt, "and the session record is written from that same value");
  ok((mainSrc.match(/model: seatModel/g) || []).length === 2, "exactly the launch and the record, resolved once");
}

// --- the picker default still says Opus, and the two files agree ---------------------------------
{
  // The renderer is a classic script and cannot import the table, so the value is written out
  // there too. That is a drift risk, so it is pinned rather than hoped for.
  const jumpIn = /paneOverrides: \{ modelDefault: "([^"]+)", secondMateId/.exec(rendererSrc);
  ok(!!jumpIn, "jumping into a project seat still sets a picker default");
  ok(!!jumpIn && jumpIn[1] === DEFAULT_MODEL_BY_TIER["second-mate"], `and it is the same value the tier table names (${jumpIn && jumpIn[1]})`);
  const firstMate = /modelDefault: "([^"]+)", mateId/.exec(rendererSrc);
  ok(!!firstMate && firstMate[1] === DEFAULT_MODEL_BY_TIER["first-mate"], `the first-mate seat's picker default agrees too (${firstMate && firstMate[1]})`);
  // A default, not a lock: the picker has to be able to override it or the whole decision is
  // the opposite of what was asked for.
  ok(/pane\.modelDefault \|\| "auto"/.test(rendererSrc), "the picker shows the default but is still a picker");
}

console.log("");
console.log(exit === 0 ? "VERIFY OK: one seat, one model - defaulted by tier, overridden by the picker, and not put back by a relay." : "VERIFY FAILED.");
process.exit(exit);
