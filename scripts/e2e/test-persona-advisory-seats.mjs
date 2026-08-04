// The advisory seats a working session can consult - and the ceiling they run under.
//
// the captain, 2026-08-04: "jag skulle vilja att en 2nd mate ska kunna invoka en agent
// med en persona. Så 2nd mate ska själv kunna be en architect granska jobb. Men om
// vi flyttar dem behöver vi nog också härda och förbättra personas. Vi vill kanske
// inte att de ska kunna ändra kod t.ex."
//
// The hardening is the interesting half, because the obvious spelling of it does
// not work. Measured against the real CLI the same day:
//
//   - A session with Edit, Write, NotebookEdit, Task AND Bash all DENIED still
//     rewrote a file, using the built-in PowerShell tool that no deny list had
//     named. A deny list only closes the doors someone remembered.
//   - A seat granted `Bash(git log:*)` - meaning "read history, change nothing" -
//     ran `echo "CHANGED" > seed.txt`. The tool list decides which tools exist;
//     granting any form of Bash grants the shell.
//   - A seat given only Read/Grep/Glob could not touch the file and said so.
//
// So this file asserts the ONE property that measurement showed holds: the seats
// name only read tools, and no shell in any spelling. The live re-check against
// the CLI is test-persona-agent-containment.mjs.
//
// Run:  node scripts/e2e/test-persona-advisory-seats.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PERSONAS, ADVISORY_TOOLS, personaAgents, personaAgentDefinition } from "../../src/lib/personas.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const agents = personaAgents();
const keys = Object.keys(agents);

// --- one seat per persona, addressable by the persona's own key --------------
ok(keys.length === PERSONAS.length, `every persona is published as a seat (${keys.join(", ")})`);
ok(
  PERSONAS.every((p) => agents[p.key]),
  "and each is keyed by its persona key, so the sub-agent type IS the persona key"
);
ok(personaAgentDefinition("no-such-seat") === null, "an unknown key yields no seat rather than a default one");
ok(personaAgentDefinition(null) === null, "and neither does the absence of a persona - Coordinator is not a seat");

// --- the ceiling: read tools only, and no shell in ANY spelling --------------
const WRITE_OR_RUN = /^(Edit|MultiEdit|Write|NotebookEdit|Task|Agent|Bash|PowerShell|Shell|WebFetch|KillShell|BashOutput)\b/i;
for (const [key, def] of Object.entries(agents)) {
  ok(Array.isArray(def.tools) && def.tools.length > 0, `${key}: declares an explicit tool list (${def.tools?.join(", ")})`);
  const offenders = def.tools.filter((t) => WRITE_OR_RUN.test(t));
  ok(offenders.length === 0, `${key}: grants nothing that can write or execute (${offenders.join(", ") || "clean"})`);
  // The scoped-grant trap: `Bash(git log:*)` reads as read-only and is not.
  const scopedShell = def.tools.filter((t) => /\(/.test(t));
  ok(
    scopedShell.length === 0,
    `${key}: uses no SCOPED grant - a specifier is a permission rule, not a smaller tool (${scopedShell.join(", ") || "none"})`
  );
  ok(
    def.tools.every((t) => ADVISORY_TOOLS.includes(t)),
    `${key}: stays within the measured ceiling ${ADVISORY_TOOLS.join("/")}`
  );
}
ok(!ADVISORY_TOOLS.some((t) => WRITE_OR_RUN.test(t)), `the ceiling itself contains no write or shell tool (${ADVISORY_TOOLS.join(", ")})`);

// Frozen: a caller that pushes onto the shared ceiling would widen every seat at
// once, and the widening would be invisible here (the assertions above read the
// same array they were mutated into).
let mutated = false;
try {
  ADVISORY_TOOLS.push("Bash");
  mutated = ADVISORY_TOOLS.includes("Bash");
} catch {
  mutated = false;
}
ok(!mutated, "and cannot be widened at runtime by a caller pushing onto it");

// --- what the calling model reads to choose a seat ---------------------------
for (const [key, def] of Object.entries(agents)) {
  ok(def.description.length > 60, `${key}: the description says enough to choose it on (${def.description.length} chars)`);
  ok(/read-only/i.test(def.description), `${key}: and states up front that it cannot edit or run anything`);
  ok(/consult/i.test(def.description), `${key}: and says WHEN to reach for it`);
}

// --- what the seat itself is told -------------------------------------------
for (const [key, def] of Object.entries(agents)) {
  ok(/CONSULTED/.test(def.prompt), `${key}: knows it is being consulted, not running its own session`);
  ok(/cannot change anything/i.test(def.prompt), `${key}: is told the containment rather than discovering it mid-task`);
  ok(
    /SAY WHAT YOU COULD NOT CHECK/.test(def.prompt),
    `${key}: is told to name the gap instead of presenting reasoning as verification`
  );
  ok(/READ THE FILES/.test(def.prompt), `${key}: is told to judge the code, not the caller's summary of it`);
  ok(def.prompt.includes(`PERSONA: ${PERSONAS.find((p) => p.key === key).label}`), `${key}: still carries its own temperament`);
}

// The boundary that made Architect and Red team distinct must survive the move
// into a seat - the seat prompt embeds the overlay, so a regression there would
// silently collapse two seats into one.
ok(/that is the Red team seat/i.test(agents.architect.prompt), "the Architect seat still refuses to attack without owning an alternative");
ok(/that is the Architect seat/i.test(agents["red-team"].prompt), "and the Red team seat still refuses to propose the fix");

// --- the JSON actually survives the trip to the CLI --------------------------
const encoded = JSON.stringify(agents);
ok(encoded.length > 500 && JSON.parse(encoded).architect.tools.length === ADVISORY_TOOLS.length, `the seats round-trip as JSON (${encoded.length} bytes)`);
ok(![...encoded].some((c) => c.codePointAt(0) === 0), "and carry no NUL byte, which would truncate the single argv value they travel in");

// --- the seats reach the tier that can actually call them --------------------
// A first mate is denied Task by the tier guard, so seats belong on the second-mate
// launch. This checks the wiring exists where it should and NOT where it cannot work.
const mainSrc = fs.readFileSync(path.join(repo, "src", "main.js"), "utf8");
const launcherSrc = fs.readFileSync(path.join(repo, "src", "lib", "launcher.js"), "utf8");
ok(/agents = personaAgents\(\)/.test(mainSrc), "main.js attaches the seats to a launch");
ok(/--agents/.test(launcherSrc), "and the launcher passes them to the CLI");
const secondMateBranch = mainSrc.slice(mainSrc.indexOf("effectiveSecondMateId = secondMateId"), mainSrc.indexOf("} catch (err) {", mainSrc.indexOf("effectiveSecondMateId = secondMateId")));
ok(/agents = personaAgents\(\)/.test(secondMateBranch), "the attachment sits in the SECOND-MATE branch, the tier that has Task");
const firstMateBranch = mainSrc.slice(mainSrc.indexOf("allowedTools = FIRST_MATE_ALLOWED_TOOLS"), mainSrc.indexOf("effectiveSecondMateId = secondMateId"));
ok(!/agents = personaAgents\(\)/.test(firstMateBranch), "and not on the first mate, which is denied Task and could never call one");

// The manual is how a second mate learns the seats exist at all - an injected
// capability nothing mentions is an unused capability.
const manual = fs.readFileSync(path.join(repo, "src", "lib", "second-mate-instructions.md"), "utf8");
for (const key of keys) {
  ok(manual.includes(`\`${key}\``), `the second-mate manual names the ${key} seat`);
}
ok(/you decide/i.test(manual), "and says a consult does not transfer the decision");
ok(/hand them the output/i.test(manual), "and that a seat with no shell must be handed the output it needs");

console.log(
  exit === 0
    ? "VERIFY OK: four read-only advisory seats, no shell in any spelling, wired to the tier that can call them and documented where it will read about them."
    : "VERIFY FAILED."
);
process.exit(exit);
