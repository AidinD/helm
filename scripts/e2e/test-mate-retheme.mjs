// Unit test: rethemeMateNames swaps the active mates' names across a theme
// FAMILY change (nautical <-> space) preserving id/slot/persona, and is a
// no-op within a family (dark <-> brass). Uses the HELM_MATES_PATH seam.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
const tmp = path.join(os.tmpdir(), "mate-retheme-" + process.pid + ".json");
process.env.HELM_MATES_PATH = tmp;
const { ensureMates, rethemeMateNames, setMatePersona } = await import("../../src/lib/mates.js");
let exit = 0;
const assert = (c, m) => { console.log(`${c ? "OK  " : "FAIL"} - ${m}`); if (!c) exit = 1; };
try {
  const m = ensureMates("D:/x");
  const ids0 = m.map((x) => x.mateId);
  const names0 = m.map((x) => x.name);
  setMatePersona(m[0].mateId, "architect");

  const space = rethemeMateNames("dark", "space");
  assert(space.map((x) => x.mateId).join() === ids0.join(), "mateIds preserved across nautical->space");
  assert(space.every((x, i) => x.name !== names0[i]), "both names changed nautical->space");
  assert(space.find((x) => x.mateId === m[0].mateId).persona === "architect", "persona preserved across retheme");
  const spaceNames = space.map((x) => x.name);

  const back = rethemeMateNames("space", "dark");
  assert(back.every((x, i) => x.name !== spaceNames[i]), "names changed space->nautical");

  const nautNames = back.map((x) => x.name);
  const noop = rethemeMateNames("dark", "brass");
  assert(noop.map((x) => x.name).join() === nautNames.join(), "dark->brass is a no-op (same nautical pool)");

  const noop2 = rethemeMateNames("brass", "dark");
  assert(noop2.map((x) => x.name).join() === nautNames.join(), "brass->dark is a no-op too");
} catch (e) { exit = 1; console.log("ERROR:", e.message); }
finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
console.log(exit === 0 ? "VERIFY OK: mate retheme." : "VERIFY FAILED.");
process.exit(exit);
