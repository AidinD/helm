// An artifact written into the designated directory offers itself for annotation, and the two
// places that decide "this is an artifact" agree on where one lives.
//
// The feature had a naming convention: an HTML file whose NAME contains "mockup", anywhere in
// the project. That is a judgement about what a file IS, which is exactly what the artifacts
// card wanted replaced by a place - and the tier guard now exempts that place from a second
// mate's write budget. Two rules about the same fact in two files is how a concept drifts, so
// this check holds them together: the folder the guard exempts is the folder the banner
// recognises, spelled the same way and matched the same way.
//
// The name convention stays and is checked too. Sessions have been told to name mockups that
// way for months and such files exist; removing it would break the feature for all of them to
// gain tidiness.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ARTIFACT_DIR, isArtifactPath } from "../../src/lib/tierGuard.js";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const rSrc = fs.readFileSync(path.join(repo, "src", "renderer", "renderer.js"), "utf8");

// The REAL function, lifted rather than reimplemented, so a change in renderer.js cannot pass
// here. Same technique as test-skill-chips.
const at = rSrc.indexOf("function isMockupPath(");
if (at < 0) {
  console.log("FAIL - renderer.js no longer defines isMockupPath");
  console.log("VERIFY FAILED: 1 assertion(s)");
  process.exit(1);
}
const { isMockupPath } = new Function(
  `${rSrc.slice(at, rSrc.indexOf("\n}", at) + 2)}
return { isMockupPath };`
)();

const bs = String.fromCharCode(92);

// --- the directory is recognised ----------------------------------------------------------
ok(isMockupPath(`C:/work/press/${ARTIFACT_DIR}/dashboard.html`), "an HTML file in the artifacts directory opens in Plan");
ok(isMockupPath(`C:/work/press/${ARTIFACT_DIR}/v2/dashboard.html`), "and one nested deeper inside it");
ok(
  isMockupPath(`C:${bs}work${bs}press${bs}${ARTIFACT_DIR}${bs}dashboard.html`),
  "and the same path spelled with backslashes, which is what this platform hands over"
);

// --- the older naming convention still works ----------------------------------------------
ok(isMockupPath("C:/work/press/src/dashboard-mockup.html"), "a file named the old way still opens in Plan - existing sessions are not broken");
ok(isMockupPath("C:/work/press/MOCKUP.html"), "case-insensitively, as it always was");

// --- and nothing else does ------------------------------------------------------------------
ok(!isMockupPath("C:/work/press/src/dashboard.html"), "an ordinary HTML file does not");
ok(!isMockupPath(`C:/work/press/${ARTIFACT_DIR}/notes.md`), "nor a non-HTML file in the artifacts directory - this is a render, not a file browser");
ok(!isMockupPath(""), "nor an empty path");
ok(!isMockupPath(null), "nor a missing one");
// The same trap the guard guards: a folder merely NAMED like the artifacts directory must not
// qualify, or the two rules disagree at exactly the edge where it matters.
ok(!isMockupPath("C:/work/press/my.helm-artifactsish/x.html"), "and not a directory whose name merely contains the artifacts name");

// --- the two rules agree about where an artifact lives --------------------------------------
// If one of them starts matching a path the other does not, an artifact either costs budget it
// should not, or is exempt from the budget while never offering itself for annotation. Both are
// silent failures.
//
// The property, stated exactly, because a looser version of it is false and the first draft of
// this check stated the looser one while its fixture happened to dodge the counterexample:
//
//   every HTML file the guard exempts must be a file the banner offers.
//
// NOT every file. A markdown note beside the mockup is budget-exempt and correctly not
// offered - the banner renders a page, it is not a file browser. Restricting the property to
// HTML is what makes it true, and the .md case below is in the list on purpose so the boundary
// is asserted rather than avoided.
const agree = [
  [`C:/work/press/${ARTIFACT_DIR}/a.html`, true],
  [`C:/work/press/${ARTIFACT_DIR}/deep/b.html`, true],
  [`C:${bs}work${bs}press${bs}${ARTIFACT_DIR}${bs}c.html`, true],
  [`C:/work/press/${ARTIFACT_DIR}/notes.md`, false],
  ["C:/work/press/my.helm-artifactsish/x.html", false],
  ["C:/work/press/src/plain.html", false],
];
for (const [candidate, isHtmlArtifact] of agree) {
  const guard = isArtifactPath(candidate);
  const banner = isMockupPath(candidate);
  const tail = candidate.slice(-26);
  if (guard && isHtmlArtifact) {
    ok(banner, `exempt from the budget AND offered by the banner: ${tail}`);
  } else if (guard) {
    ok(
      !banner,
      `exempt from the budget but NOT offered, which is right for something that is not a page: ${tail} (banner said ${banner})`
    );
  } else {
    ok(!isHtmlArtifact, `not exempt, so the banner decides on its own terms: ${tail} (banner said ${banner})`);
  }
}

// The directory name itself is one string, read from the guard rather than typed here, and the
// renderer must contain that same literal - a second spelling is the drift this exists to stop.
ok(
  rSrc.includes(`"${ARTIFACT_DIR}"`),
  `renderer.js contains the guard's own directory literal ("${ARTIFACT_DIR}") rather than a second spelling of it`
);

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: the folder the guard exempts is the folder the banner offers, and the old naming convention still works."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
