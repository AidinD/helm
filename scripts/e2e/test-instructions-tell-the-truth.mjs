/**
 * Every claim Helm's instruction files make about Helm, pinned to the thing that makes it true.
 *
 * ## Why a file like this exists
 *
 * An instruction file is written in the mechanism's voice - "this is refused", "the report
 * records" - and an agent reads it as fact, every turn. Nothing checked any of it.
 *
 * The proof is what it cost. `second-mate-instructions.md` opened by telling the model "You
 * run on the capable model (Opus)". No launch path sets a model for that tier, and over 438
 * turns 426 ran Sonnet 5 on low effort. The model read an untruth about itself as ground
 * truth, continuously, and the same sentence had spread into a tool description a first mate
 * reads before dispatching.
 *
 * ## The rule this file implements
 *
 * For each claim about system behaviour: does the mechanism exist? If yes, this is the check
 * that fails when it stops. If no, the sentence goes, or the mechanism gets built. There is
 * no third outcome, and "it is mostly true" is the third outcome.
 *
 * The checks are deliberately shallow - a claim is pinned to the code that implements it, not
 * to its behaviour, which the mechanism's own check owns. What this catches is the sentence
 * outliving the code, which is the failure that has actually happened.
 *
 * Run: node scripts/e2e/test-instructions-tell-the-truth.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

const secondMate = read("src/lib/second-mate-instructions.md");
const firstMate = read("src/lib/first-mate-instructions.md");
const assistant = read("src/lib/assistant-instructions.md");
const dispatchServer = read("src/mcp/helmDispatchServer.js");
const tierGuard = read("src/lib/tierGuard.js");
const records = read("src/lib/reviewRecords.js");
const personas = read("src/lib/personas.js");
const orchestrator = read("src/lib/goalOrchestrator.js");
const main = read("src/main.js");

/**
 * A claim is only pinned if it is still MADE. Otherwise a rewrite quietly turns this whole
 * file into a list of assertions about mechanisms nobody claims any more - all green, all
 * measuring nothing.
 */
const flat = (text) => String(text).replace(/\s+/g, " ");
const claim = (doc, docName, phrase, label, holds, detail = "") => {
  // Whitespace-collapsed on both sides. Markdown wraps, so an exact substring of a sentence
  // that spans a line break matches nothing - which showed up here as five claims reported
  // as "no longer made" against files that still made every one of them. A check that fails
  // against correct content is the same bug as one that passes against broken content, and
  // it is the one that gets the check deleted.
  if (!flat(doc).includes(flat(phrase))) {
    ok(false, `${docName} no longer says "${phrase.slice(0, 48)}..." - re-point or delete this check`);
    return;
  }
  ok(holds, label, detail);
};

console.log("-- second-mate-instructions.md --");

claim(
  secondMate,
  "the manual",
  "after a few file changes in a single turn, further writes are refused",
  "the write budget it describes is real",
  /SECOND_MATE_TURN_WRITE_BUDGET\s*=\s*\d+/.test(tierGuard) && /writesThisTurn >= budget/.test(tierGuard)
);

claim(
  secondMate,
  "the manual",
  "requires a `model`, and it requires one because nothing used to ask",
  "helm_dispatch really refuses a dispatch with no model",
  /required: \["project", "goal", "model"\]/.test(dispatchServer) && /`model` is required/.test(dispatchServer)
);

claim(
  secondMate,
  "the manual",
  "A `core` or `critical` record with no intent is refused at write time",
  "the record gate really refuses one",
  /must carry the intent/.test(records)
);

claim(
  secondMate,
  "the manual",
  "they can Read, Grep and Glob, and nothing else",
  "the advisory seats really have those three tools and no others",
  /ADVISORY_TOOLS = Object\.freeze\(\["Read", "Grep", "Glob"\]\)/.test(personas)
);

claim(
  secondMate,
  "the manual",
  "the review card says so and the reviewer is told to judge against the current wording",
  "intent drift is really computed and rendered",
  /export function intentDrift/.test(read("src/lib/intent.js")) && /intentDrift\?\.drifted/.test(read("src/lib/reviewHtml.js"))
);

// The claim that was FALSE, checked as an absence. A regression here is somebody
// reintroducing the sentence, not the mechanism disappearing.
{
  const saysItRunsOnOpus = /You run on the capable model \(Opus\)|this Opus tier|worth the Opus cost/.test(secondMate);
  ok(
    !saysItRunsOnOpus,
    "it no longer tells the model which model it is - nothing sets one for this tier",
    saysItRunsOnOpus ? "the claim is back" : ""
  );
  const launchSetsAModel = /launchTier = TIER_SECOND_MATE[\s\S]{0,400}?model:\s*"claude/.test(main);
  ok(
    !launchSetsAModel,
    "and no launch path has quietly started setting one - if it does, the sentence can come back with a check"
  );
}

console.log("");
console.log("-- first-mate-instructions.md --");

claim(
  firstMate,
  "the manual",
  "file-writing tools are not in your toolset",
  "the write tools really are removed from the schema, not just un-approved",
  /disallowedTools = FIRST_MATE_DISALLOWED_TOOLS/.test(main) && /--disallowedTools/.test(read("src/lib/launcher.js"))
);

claim(
  firstMate,
  "the manual",
  "a shell command that writes is refused before it runs, on every turn",
  "the tier guard really refuses one",
  /tier === TIER_FIRST_MATE/.test(tierGuard) && /shellNotReadOnlyReason/.test(tierGuard)
);

console.log("");
console.log("-- the tool descriptions a mate reads --");

claim(
  dispatchServer,
  "helm_dispatch",
  "never pushes/merges",
  "a crew run really cannot push - enforced 2026-09-01, described before that",
  /TIER_CREW/.test(tierGuard) && /shellLeavesWorktree/.test(tierGuard) && /guard: tierGuardLaunchConfig\(TIER_CREW/.test(main),
  "this was the load-bearing false one: it justified bypassPermissions"
);

claim(
  dispatchServer,
  "helm_dispatch",
  "depth capped at 2",
  "the depth cap really exists",
  /exceedsDepth|depth/.test(read("src/lib/dispatchCaps.js"))
);

{
  const stillClaimsOpusSession = /its Opus session spins up/.test(dispatchServer);
  ok(!stillClaimsOpusSession, "and it no longer promises a first mate that the seat will be an Opus one");
}


// --- assistant-instructions.md ---------------------------------------------------------
//
// Added 2026-09-02, and the gap is worth naming: this manual has existed since the seat did
// and NOTHING here read it. It is the same file class as the two above - a document the model
// reads as fact every turn - and it now makes specific, checkable claims about seats it can
// consult by name. A renamed seat would turn it into a page of instructions pointing at
// nothing, silently, which is the exact failure the second-mate manual already paid for.
console.log("");
{
  // The artifact exemption is only reachable if the mate knows the directory's name, and the
  // name has to be the one the guard actually matches - a manual naming a different folder
  // would be an instruction that quietly costs budget every time it is followed.
  claim(
    secondMate,
    "second-mate-instructions.md",
    "A design artifact costs no budget",
    "and the guard really exempts a directory rather than a judgement about the file",
    /export function isArtifactPath/.test(tierGuard)
  );
  claim(
    secondMate,
    "second-mate-instructions.md",
    "`.helm-artifacts/`",
    "and it names the SAME directory the guard matches on",
    /ARTIFACT_DIR = "\.helm-artifacts"/.test(tierGuard)
  );
  claim(
    secondMate,
    "second-mate-instructions.md",
    "a shell redirect into that folder is counted",
    "and the exemption really is tools-only, so that sentence is not a courtesy",
    /isMutatingTool && !isShell && isArtifactPath/.test(tierGuard)
  );
}

console.log("-- assistant-instructions.md --");
{
  const seatKeys = [...personas.matchAll(/key:\s*"([a-z-]+)"/g)].map((m) => m[1]);
  ok(seatKeys.length >= 5, `personas.js publishes ${seatKeys.length} seats to check the manual against`);

  // Every seat the manual names by its LABEL must exist. Labels rather than keys, because the
  // manual is written for a reader and names them the way a person would.
  const labels = [...personas.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
  for (const label of ["Mediator", "Architect", "Red team", "Researcher", "Teacher"]) {
    claim(
      assistant,
      "assistant-instructions.md",
      `**${label}**`,
      `it names ${label}, and personas.js publishes a seat with that label`,
      labels.includes(label),
      labels.join(", ")
    );
  }

  claim(
    assistant,
    "assistant-instructions.md",
    "A consult is one level deep",
    "and the guard refuses a consult from inside a consult, rather than the manual merely asking",
    /consultedSeatFanOutDenial\(agentType\)/.test(tierGuard)
  );

  claim(
    assistant,
    "assistant-instructions.md",
    "the guard fires inside a consulted seat exactly as it fires on you",
    "and the hook really does read the sub-agent field, so that is a mechanism and not a hope",
    /agent_type/.test(read("src/hooks/tierGuardHook.mjs"))
  );

  claim(
    assistant,
    "assistant-instructions.md",
    "You can consult five read-only advisory seats",
    "and the assistant launch actually passes the seats, or the whole section is unreachable",
    /agents = personaAgents\(\);/.test(main)
  );

  claim(
    assistant,
    "assistant-instructions.md",
    "an allow list pinned to reading",
    "and the seats' tool list really is that, frozen",
    /ADVISORY_TOOLS = Object\.freeze\(\["Read", "Grep", "Glob"\]\)/.test(personas)
  );

  // The oldest claim in this file, never pinned until now: the seat does not build, and the
  // guard is what makes it true rather than the sentence.
  claim(
    assistant,
    "assistant-instructions.md",
    "The tier guard enforces this rather than trusting you with it",
    "and the tier really has a deny-everything-that-writes policy of its own",
    /tier === TIER_ASSISTANT/.test(tierGuard)
  );
}

console.log("");
console.log("-- what the crew run itself is told --");

claim(
  orchestrator,
  "the iteration launcher",
  // A fragment that sits on ONE line: this is a // comment block, so collapsing whitespace
  // still leaves the marker between wrapped lines and a longer phrase matches nothing.
  "Bypassing is SAFE precisely because",
  "the isolation that argument rests on is now enforced rather than asserted",
  /guardSettings/.test(orchestrator) && /args\.push\("--settings"/.test(orchestrator)
);

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} claim(s) are no longer backed by anything`);
  process.exit(1);
}
console.log("VERIFY OK: every claim these files make about Helm is pinned to the code that makes it true.");
