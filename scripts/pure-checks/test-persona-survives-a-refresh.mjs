// A persona is kept across a retire unless somebody explicitly clears it.
//
// WHY THIS IS NOT A CONVENIENCE. Under the seat model a persona decides what a seat IS: a
// meta-home seat carrying the assistant persona is a standing assistant, with its own manual
// and its own tools. So a saturation refresh that drops the persona does not return a mate
// with a plainer character - it returns a DIFFERENT SEAT, and reads as the seat having
// forgotten itself. The same trap already bit one level down and left a comment in mates.js
// about a persona that "evaporated on the next refresh"; the whole seat identity now sits
// behind it.
//
// THE THREE STATES, which are easy to collapse into two and must not be:
//   omit the flag          -> keep     (an ordinary refresh)
//   keepPersona: false + a key -> switch  (a deliberate change of character)
//   keepPersona: false + null  -> clear   (choosing plain Coordinator on purpose)
// The third is why "keep" cannot simply be unconditional, and it is asserted here because a
// fix that made keeping absolute would pass a test that only checked the first two.
//
// Run:  node scripts/pure-checks/test-persona-survives-a-refresh.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-persona-refresh-"));
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");

// Dynamic and after the env var: mates.js resolves its store path at import time, so a static
// import would read the real one.
const mates = await import("../../src/lib/mates.js");

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

try {
  const root = path.join(tmp, "meta-home");
  fs.mkdirSync(root, { recursive: true });
  mates.ensureMates(root, 1);

  const first = mates.activeMates()[0];
  const withPersona = mates.setMatePersona(first.mateId, "teacher");
  ok(withPersona?.persona === "teacher", `a persona can be set (${JSON.stringify(withPersona?.persona)})`);

  // THE DEFAULT. Omitting the option entirely is the case that changed, and the case a
  // future caller will hit - every call site in the app passes the flag today, so a test
  // that only exercised those would have passed before the change too.
  const refreshed = mates.retireAndRespawn(withPersona.mateId, "handoff text");
  ok(
    refreshed.persona === "teacher",
    `omitting keepPersona KEEPS the persona (${JSON.stringify(refreshed.persona)})`
  );
  ok(refreshed.mateId !== withPersona.mateId, "and it really is a successor, not the same record");
  ok(refreshed.root === path.resolve(root), "the successor keeps the root as well");

  // A PASSED persona wins even with no flag, and this is the assertion the flip actually
  // needed. Keeping was implemented as the first branch, which made the persona argument
  // unreachable unless the caller also said keepPersona: false - so a deliberate switch was
  // silently ignored. Two older checks caught it; it belongs here, next to the default it
  // is a consequence of.
  const switchedNoFlag = mates.retireAndRespawn(refreshed.mateId, null, "red-team");
  ok(
    switchedNoFlag.persona === "red-team",
    `naming a persona switches to it even with no flag (${JSON.stringify(switchedNoFlag.persona)})`
  );

  // Explicit false still means what it meant.
  const switched = mates.retireAndRespawn(switchedNoFlag.mateId, null, "teacher", { keepPersona: false });
  ok(switched.persona === "teacher", `an explicit switch still switches (${JSON.stringify(switched.persona)})`);

  const cleared = mates.retireAndRespawn(switched.mateId, null, null, { keepPersona: false });
  ok(
    cleared.persona === null,
    `and choosing plain Coordinator still CLEARS it - keeping must not become unconditional (${JSON.stringify(cleared.persona)})`
  );

  // A refresh of a personaless seat stays personaless, so the new default cannot invent one.
  const stillNone = mates.retireAndRespawn(cleared.mateId, null);
  ok(stillNone.persona === null, "refreshing a seat with no persona does not invent one");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The IPC handler's own coercion, which is the half a behavioural test cannot reach: the
// handler is not importable, so this reads the source. Comments are stripped first - a check
// that matches its own documentation is on this project's failure list, and this file's own
// header talks about `!!keepPersona`.
//
// WHAT A SOURCE SCAN CANNOT PROVE, stated rather than implied: that the handler is wired up,
// that the renderer sends what it claims to, or that nothing downstream re-coerces. It proves
// only that this one known-destructive spelling is gone.
const mainSrc = fs
  .readFileSync(new URL("../../src/main.js", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");
ok(
  !/keepPersona:\s*!!keepPersona/.test(mainSrc),
  "the retire IPC no longer coerces an ABSENT flag to false, which would invert the new default"
);
ok(
  /keepPersona:\s*keepPersona\s*!==\s*false/.test(mainSrc),
  "and it passes keep-unless-explicitly-false instead"
);

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - a refresh keeps the seat's persona, and only an explicit choice clears it");
