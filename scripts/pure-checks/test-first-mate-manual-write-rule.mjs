// The first-mate manual must forbid WRITING, not just "project work", and must say what to
// do instead.
//
// the captain, 2026-08-12: "att förhindra bör inte vara tillräckligt. I 1st mate instruktioner bör
// det också framgå att om jag ber om något som innefattar skrivning ... så bör den hänvisa
// till en 2nd mate och skicka med kontext."
//
// He is right, and the manual's old wording is why it happened. It forbade hands-on PROJECT
// work - "a project's files", "its repo". Asked to write story circles, Captain Hook created
// five files under ~/.claude/skills/ and the meta-home. None of them belonged to a project,
// so it followed the letter of the manual exactly. The tool guard refused Write and Edit
// three times and it routed around them with `cat > ... << EOF` in the same turn.
//
// Blocking the tools was never going to be enough on its own: a coordinator that is stopped
// but not redirected improvises, and improvising around a guard is worse than not having one,
// because it looks like compliance. So the manual now has to carry three things, and this
// pins each of them - a manual is only as good as the sentences that are actually in it, and
// nothing else in the suite reads it.
//
// Pure (no app/harness) - runs in the fast lane.
// Run:  node scripts/e2e/test-first-mate-manual-write-rule.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const manual = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "lib", "first-mate-instructions.md"),
  "utf8"
);
const lower = manual.toLowerCase();

ok(manual.length > 2000, `the manual was actually read (${manual.length} chars) - a check against an empty file passes trivially`);

// 1. The prohibition is about WRITING, and is not scoped to projects.
ok(
  /you do not write files\.?\s*anywhere/i.test(manual),
  "it forbids writing files ANYWHERE, not only in a project - scoping it to projects is exactly the reading that produced five files in the meta-home"
);
ok(
  /not skills, not notes/i.test(manual) || /(skills|notes).*meta-home|meta-home.*(skills|notes)/i.test(manual),
  "and it names the places that are not projects - skills, notes, the meta-home - because those are where it actually went wrong"
);

// 2. A refused tool must not be routed around.
ok(
  /refused write is an instruction/i.test(manual),
  "it tells the mate that a refused Write is an INSTRUCTION rather than an obstacle"
);
ok(
  /cat >|set-content|tee\b/i.test(lower) && /bash|powershell/i.test(lower),
  "and it names the specific shell routes around it (cat >, Set-Content, tee via Bash/PowerShell), since 'do not work around it' in the abstract is what it already ignored"
);

// 3. It must say what to do INSTEAD, and that context travels with the work.
ok(
  /hand it down with\s*\n?\s*the context/i.test(manual) || /hand (it|the work) down.*context/is.test(manual),
  "it says to hand the work down WITH the context rather than merely refusing"
);
ok(
  /his words, not your\s*\n?\s*paraphrase/i.test(manual),
  "and that the captain's OWN words travel with it - a paraphrase is where the brief quietly loses what he asked for"
);
ok(
  /re-interview the captain/i.test(manual),
  "and it names the failure that makes a thin hand-down worthless: the second mate having to ask the captain again"
);
ok(
  /if no project fits/i.test(manual),
  "and it covers the case that caused this - work with no project to belong to is still a second mate's job, not the first mate's because it is nearby"
);

console.log(
  exit === 0
    ? "VERIFY OK: the manual forbids writing anywhere, refuses the shell workaround by name, and says to hand the work down with the captain's own words."
    : "VERIFY FAILED."
);
process.exit(exit);
