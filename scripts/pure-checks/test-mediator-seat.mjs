// The Mediator seat: a read on a conversation, not a profile store.
//
// The seat answers a narrow request - "here is a thread, how will my reply land,
// give me a better wording" - and the whole design risk sits in two places, so
// those are what this file pins rather than the prose:
//
//  1. IT MUST NOT INVENT A PERSON. "Save profiles so I can just say 'this is
//     about <name>'" is a people store, and one already exists as an MCP surface
//     (`tend_*`) that Helm attaches BY NAME to the assistant seat and to no
//     other tier. A seat rooted in a project therefore has no people store at
//     all, and an advisory seat's tool list (Read/Grep/Glob) could not reach one
//     if it were attached. So the correct behaviour is to SAY there is no
//     history and answer from the pasted text - which has to be written into the
//     prompt as an instruction, because a model with no history will otherwise
//     produce a plausible one and it reads exactly like knowledge.
//
//  2. IT MUST NOT COLLAPSE INTO THE SEATS THAT ALREADY EXIST. Two seats that
//     both "look at something and advise" are one seat with two names - the
//     lesson Architect and Red team already paid for (test-persona-boundaries).
//     So this one names the other four and hands their work back to them, and a
//     regression that removes those exclusions is a regression this file fails
//     on rather than one nobody notices.
//
// It is also SEAT-ONLY: an entry in the temperament catalog that is not a
// temperament. A first-mate persona colours a session that runs for hours; this
// is one question with one answer. The flag is asserted here because the picker
// filter that reads it is the follow-up, and a flag with no test is a comment.
//
// Run:  node scripts/e2e/test-mediator-seat.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PERSONAS, ADVISORY_TOOLS, personaAgents, personaAgentDefinition, matePersonas, getPersona, personaOverlay } from "../../src/lib/personas.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEY = "mediator";
const agents = personaAgents();
const seat = agents[KEY];
const entry = getPersona(KEY);

// --- it is published where the claim says it is published --------------------
ok(Boolean(entry), "the catalog has a mediator entry");
ok(Boolean(seat), "and personaAgents() publishes it as a consultable seat, keyed by its own key");
ok(personaAgentDefinition(KEY) !== null, "personaAgentDefinition resolves it too, so nothing depends on the map alone");
const overlay = entry?.overlay || "";
ok(overlay.startsWith("PERSONA: Mediator"), "its overlay names the seat it is, like every other entry");
ok(seat?.prompt?.includes(overlay), "and the seat prompt embeds that overlay rather than a second copy of the text");
ok(personaOverlay(KEY) === overlay, "the overlay lookup still answers for it - an old mate record naming it keeps working");

// --- seat-only: in the seat map, out of the temperament picker ---------------
ok(entry?.seatOnly === true, "it declares itself seat-only rather than being excluded by a list somewhere else");
const mateKeys = matePersonas().map((p) => p.key);
ok(!mateKeys.includes(KEY), `matePersonas() leaves it out, so the picker has a filter to read (${mateKeys.join(", ")})`);
ok(mateKeys.length === PERSONAS.length - 1, "and drops exactly the seat-only entry, not a whole class of them");
ok(
  PERSONAS.filter((p) => !p.seatOnly).every((p) => Boolean(agents[p.key])),
  "while every real temperament is still published as a seat - seat-only narrows the picker, never the seat map"
);

// --- the containment every seat runs under still applies to this one ---------
const WRITE_OR_RUN = /^(Edit|MultiEdit|Write|NotebookEdit|Task|Agent|Bash|PowerShell|Shell|WebFetch|KillShell|BashOutput)\b/i;
ok(Array.isArray(seat?.tools) && seat.tools.length > 0, `it declares an explicit tool list (${seat?.tools?.join(", ")})`);
ok(seat.tools.every((t) => ADVISORY_TOOLS.includes(t)), `and stays inside the measured ceiling ${ADVISORY_TOOLS.join("/")}`);
ok(!seat.tools.some((t) => WRITE_OR_RUN.test(t)), "granting nothing that can write or execute - it hands back a draft, it does not send one");
// The people store is an MCP server, and this list has no MCP entry at all. Worth
// asserting rather than assuming: adding one here would be the quiet way to give a
// read-only seat a live data source nobody re-measured.
ok(!seat.tools.some((t) => /^mcp__/i.test(t)), "and no MCP server, so the people store is genuinely out of reach rather than sometimes present");

// --- the no-invented-history instruction, which is the whole point ----------
ok(/YOU HOLD NO PROFILES/.test(overlay), "it is told it holds no profiles, in the imperative - not left to discover it");
ok(/remember nobody between consults/i.test(overlay), "and that nothing carries from one consult to the next");
ok(
  /I have no history on this person/i.test(overlay),
  "it is given the actual sentence to say when it was told nothing about the person, rather than a principle to apply"
);
ok(/NEVER infer a personality/.test(overlay), "and is forbidden from inferring a person from a name, a title or a few lines");
ok(
  /answer from the conversation alone/i.test(overlay),
  "the missing history is not a refusal either: a pasted conversation on its own is a complete input"
);
ok(/paste what your people store has/i.test(overlay), "and a caller who does have the store is told to paste it in - the seat never fetches");

// --- what it returns, concretely --------------------------------------------
// "Tips" is not a deliverable. Three named parts are, and a caller can tell when
// one is missing.
for (const part of ["READ:", "LANDING:", "REPLY:"]) {
  ok(overlay.includes(part), `its output shape names the ${part.replace(":", "")} part explicitly`);
}
ok(/ANSWER IN THESE THREE PARTS, always/.test(overlay), "and the shape is mandatory, not a suggestion it can drift out of");
ok(/ready to send/i.test(overlay), "the REPLY part is a usable message, not advice about writing one");
ok(/never the position/i.test(overlay), "and rewrites the delivery without quietly conceding the caller's point");
ok(/quote the specific line/i.test(overlay), "it must quote what it is reacting to, so its read is checkable against the text");

// --- it has a spine ---------------------------------------------------------
ok(/DO NOT FLATTER/.test(overlay), "it is told not to flatter");
ok(
  /If the direct version was CORRECT, say so/.test(overlay),
  "and is required to say when the blunt draft was right - a seat that softens everything is a worse version of no seat"
);
ok(/agreeing with the caller because agreeing is pleasant/i.test(overlay), "with the specific failure named, not just 'be honest'");
ok(/do not offer reassurance/i.test(overlay), "and no reassurance, which is neither checkable nor what was asked for");

// --- distinguishable from the seats that already exist ----------------------
// Architect and Red team each name the other for the thing they refuse to do.
// This seat has four neighbours, so it names all four.
for (const other of ["Architect", "Red team", "Researcher", "Teacher"]) {
  ok(new RegExp(other).test(overlay), `it names the ${other} seat and hands that seat's work back to it`);
}
ok(/never the work/i.test(overlay), "declaring the split plainly: people and wording here, the work elsewhere");
ok(
  !/PERSONA: Mediator/.test(agents.architect.prompt) && !/PERSONA: Mediator/.test(agents["red-team"].prompt),
  "and the existing seats did not absorb it - each prompt still carries only its own stance"
);
// The pair boundary this catalog already paid for must survive a fifth entry.
ok(/that is the Red team seat/i.test(agents.architect.prompt), "the Architect/Red team boundary is intact after the addition");
ok(/that is the Architect seat/i.test(agents["red-team"].prompt), "in both directions");

// --- discoverable by the tier that can actually call it ---------------------
// An injected capability nothing mentions is an unused capability, and the tier
// that has Task is the second mate.
const manual = fs.readFileSync(path.join(repo, "src", "lib", "second-mate-instructions.md"), "utf8");
ok(manual.includes("`mediator`"), "the second-mate manual names the seat");
ok(/holds no profiles/i.test(manual), "and warns the caller it has no history, so a consult arrives with the context it needs");

// --- what the calling model reads to choose it ------------------------------
ok(seat.description.length > 60, `the description says enough to choose it on (${seat.description.length} chars)`);
ok(/read-only/i.test(seat.description), "and states up front that it cannot edit or run anything");
ok(/consult/i.test(seat.description), "and says when to reach for it");
ok(/conversation/i.test(seat.description), "naming the input it needs, which is the thing a caller has to remember to paste");

console.log(
  exit === 0
    ? "VERIFY OK: the Mediator seat is published read-only, states its missing history instead of inventing one, returns a fixed three-part answer, keeps its spine, and hands the other four seats' work back to them."
    : "VERIFY FAILED."
);
process.exit(exit);
