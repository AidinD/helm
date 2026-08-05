// Unit test: which model an independent reviewer is recommended, from the change itself.
//
// the captain, 2026-08-05: "en bra lösning på modell vore att man får en rekommendation baserat
// på dess komplexitet men att man själv kan välja om man inte vill följa
// rekommendationen." So the recommendation has to be derived from something real, and its
// REASON has to name the signal - a recommendation you cannot argue with is just a
// decision someone else made.
//
// Run:  node scripts/e2e/test-reviewer-recommendation.mjs
import { recommendReviewer, diffStats, REVIEWER_MODELS, reviewerModelLabel } from "../../src/lib/reviewerModel.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

// --- the gradient ------------------------------------------------------------
const crit = recommendReviewer({ criticality: "critical", files: 1, changedLines: 12, paths: ["src/renderer/style.css"] });
ok(crit.model === "claude-opus-5" && crit.effort === "high", `critical goes to the top model whatever the size (${crit.model}/${crit.effort})`);
ok(/CRITICAL/.test(crit.why), `and says why in terms of the tier (${JSON.stringify(crit.why.slice(0, 60))})`);

const coreSmall = recommendReviewer({ criticality: "core", files: 2, changedLines: 60, paths: ["src/lib/jot.js"] });
ok(coreSmall.model === "claude-sonnet-5" && coreSmall.effort === "medium", `a contained core change does not need the expensive pass (${coreSmall.model})`);
ok(/60 changed lines across 2 files/.test(coreSmall.why), `with the numbers in the reason (${JSON.stringify(coreSmall.why)})`);

const coreBig = recommendReviewer({ criticality: "core", files: 14, changedLines: 1200, paths: ["src/lib/jot.js"] });
ok(coreBig.model === "claude-opus-5" && coreBig.effort === "high", `a large core change does (${coreBig.model})`);

const cosmeticSmall = recommendReviewer({ criticality: "cosmetic", files: 1, changedLines: 20, paths: ["src/renderer/style.css"] });
ok(
  cosmeticSmall.model === "claude-haiku-4-5-20251001" && cosmeticSmall.effort === "low",
  `a small cosmetic change gets the cheap model - not everything deserves an expensive pass (${cosmeticSmall.model})`
);
const cosmeticBig = recommendReviewer({ criticality: "cosmetic", files: 9, changedLines: 800, paths: ["src/renderer/style.css"] });
ok(cosmeticBig.model === "claude-sonnet-5", `but 800 cosmetic lines is more than a glance (${cosmeticBig.model})`);

// --- the override of the gradient: sensitive paths ---------------------------
// The point of this rule is that "it is only small" is exactly the argument that would
// talk you out of reviewing a permission gate properly.
for (const p of ["src/preload.cjs", "src/main.js", "src/lib/permissionGate.js", "src/lib/tokenStore.js", "src/lib/reviewRecords.js", "src/mcp/spawnServer.js"]) {
  const r = recommendReviewer({ criticality: "cosmetic", files: 1, changedLines: 3, paths: [p] });
  ok(r.model === "claude-opus-5" && r.sensitive === true, `a 3-line change to ${p} still gets the top model (${r.model})`);
}
const notSensitive = recommendReviewer({ criticality: "cosmetic", files: 1, changedLines: 3, paths: ["docs/mocks/chat-formatting.html"] });
ok(notSensitive.sensitive === false && notSensitive.model === "claude-haiku-4-5-20251001", "while an ordinary file is not treated as sensitive");

// --- no declared criticality is itself a signal -----------------------------
const undeclared = recommendReviewer({ files: 3, changedLines: 90, paths: ["src/lib/x.js"] });
ok(undeclared.model === "claude-sonnet-5", `an undeclared change does not default to the cheapest (${undeclared.model})`);
ok(/declares no criticality/.test(undeclared.why), "and the reason says the declaration was missing");

// --- every recommendation is pickable ---------------------------------------
const values = REVIEWER_MODELS.map((m) => m.value);
for (const r of [crit, coreSmall, coreBig, cosmeticSmall, cosmeticBig, undeclared]) {
  ok(values.includes(r.model), `${r.model} is in the list the picker offers`);
}
ok(reviewerModelLabel("claude-opus-5") === "Opus 5", "labels resolve for the dialog");
ok(reviewerModelLabel("something-else") === "something-else", "and an unknown id is shown as itself rather than blank");

// --- the diff statistics the recommendation rests on ------------------------
// Counted from the patch's own markers, because a wrong count here changes the
// recommendation silently.
const patch = [
  "commit 1111111111111111111111111111111111111111",
  "Subject line",
  "",
  "diff --git a/src/a.js b/src/a.js",
  "index 000..111 100644",
  "--- a/src/a.js",
  "+++ b/src/a.js",
  "@@ -1,3 +1,4 @@",
  " unchanged",
  "+added one",
  "+added two",
  "-removed one",
  "diff --git a/src/b.js b/src/b.js",
  "--- a/src/b.js",
  "+++ b/src/b.js",
  "@@ -1 +1 @@",
  "+only",
  "",
  "commit 2222222222222222222222222222222222222222",
].join("\n");
const st = diffStats(patch);
ok(st.files === 2, `files are counted from the diff --git lines (${st.files})`);
ok(st.added === 3 && st.removed === 1, `added/removed exclude the +++/--- file headers (${st.added}/${st.removed})`);
ok(st.changedLines === 4, `changedLines is their sum (${st.changedLines})`);
ok(st.commits === 2, `commits are counted (${st.commits})`);
ok(
  JSON.stringify(st.paths) === JSON.stringify(["src/a.js", "src/b.js"]),
  `and the paths come back for the sensitivity rule (${JSON.stringify(st.paths)})`
);
ok(diffStats("").files === 0 && diffStats(null).changedLines === 0, "an empty or missing patch counts as nothing rather than throwing");

console.log(
  exit === 0
    ? "VERIFY OK: the reviewer model is recommended from criticality, size and touched paths, with a reason that names the signal - and every recommendation is one the picker offers."
    : "VERIFY FAILED."
);
process.exit(exit);
