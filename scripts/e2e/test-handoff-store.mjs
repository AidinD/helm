// Unit test: the topic-keyed handoff store for non-rooted sessions (task
// 663ab4b6). A session with no project repo has no HANDOFF.md to write, so its
// handoff is filed per TOPIC under <meta-home>/.helm/handoffs/<slug>.md.
// Covers slugging (incl. Swedish letters), match-first category resolution,
// and the atomic write/read round-trip.
// Run:  node scripts/e2e/test-handoff-store.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  slugifyCategory,
  resolveHandoffCategory,
  writeHandoff,
  readHandoff,
  listHandoffCategories,
  handoffsDir,
} from "../../src/lib/handoffStore.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-handoff-"));
try {
  // --- slugging ---
  ok(slugifyCategory("Woodwork") === "woodwork", "plain name -> lowercase slug");
  ok(slugifyCategory("Model trains") === "model-trains", "spaces -> kebab-case");
  ok(slugifyCategory("Trädgård och växthus") === "tradgard-och-vaxthus", `Swedish letters degrade to ASCII (got ${slugifyCategory("Trädgård och växthus")})`);
  ok(slugifyCategory("  Bikupor!!  ") === "bikupor", "punctuation and padding stripped");
  ok(slugifyCategory("../../etc/passwd") === "etc-passwd", `path separators cannot survive (got ${slugifyCategory("../../etc/passwd")})`);
  ok(slugifyCategory("!!!") === null, "a name with nothing usable -> null");
  ok(slugifyCategory(null) === null, "non-string -> null");

  // --- match-first category resolution ---
  const existing = ["woodwork", "bikupor", "bird-feeders"];
  ok(resolveHandoffCategory("woodwork", existing).category === "woodwork", "exact existing topic is reused");
  ok(resolveHandoffCategory("Woodwork", existing).isNew === false, "reuse is not flagged as new");
  ok(resolveHandoffCategory("woodwork-log", existing).category === "woodwork", "a variant folds into the existing topic");
  ok(resolveHandoffCategory("bikupor", []).isNew === true, "with no existing topics, it's new");
  ok(resolveHandoffCategory("composting", existing).category === "composting", "a genuinely new topic keeps its own slug");
  ok(resolveHandoffCategory("composting", existing).isNew === true, "a genuinely new topic is flagged new");
  // Containment must be word-wise, not substring: "bird" must not swallow an
  // unrelated topic that merely contains those letters.
  ok(resolveHandoffCategory("birdbath", existing).category === "birdbath", "substring lookalike does NOT fold into bird-feeders");
  ok(resolveHandoffCategory(null, existing).category === "general", "unusable proposal falls back to 'general'");

  // --- the FALLBACK is matched too (the captain, 2026-08-02) ---------------------
  // When the classifier fails, the caller passes the session title as the
  // fallback. That path used to return the title slug immediately, skipping the
  // matching entirely - so the one time matching mattered most (nothing else was
  // going to catch a near-duplicate) was the one time it did not run.
  ok(
    resolveHandoffCategory(null, existing, "Woodwork log").category === "woodwork",
    `a fallback title folds into an existing topic (got ${JSON.stringify(resolveHandoffCategory(null, existing, "Woodwork log").category)})`
  );
  ok(
    resolveHandoffCategory(null, existing, "Woodwork log").isNew === false,
    "and is not reported as a new topic"
  );
  ok(
    resolveHandoffCategory(null, existing, "Composting").category === "composting",
    "a fallback that matches nothing still becomes its own topic"
  );
  ok(
    resolveHandoffCategory(null, existing, "!!!").category === "general",
    "an unusable fallback still lands on 'general', never on an empty slug"
  );

  // --- write / read round-trip ---
  const w = writeHandoff(metaHome, "Trädgård", "Planed the tabletop. Next: cut the tenons.", { title: "Trädgård och växthus", now: 1784000000000 });
  ok(w.ok === true && w.category === "tradgard", `write returns the resolved slug (got ${JSON.stringify(w.category)})`);
  ok(fs.existsSync(path.join(handoffsDir(metaHome), "tradgard.md")), "file lands in <meta-home>/.helm/handoffs");
  const text = readHandoff(metaHome, "tradgard");
  ok(/Planed the tabletop/.test(text), "the body round-trips");
  ok(/latest-only/.test(text), "header states the latest-only contract");
  ok(/from "Trädgård och växthus"/.test(text), "header records which session it came from");

  // Latest-only: a second write REPLACES, never appends.
  writeHandoff(metaHome, "tradgard", "Glued the frame. Next: sand and oil.", { now: 1784000100000 });
  const text2 = readHandoff(metaHome, "tradgard");
  ok(/Glued the frame/.test(text2) && !/Planed the tabletop/.test(text2), "a second handoff overwrites (latest-only, like HANDOFF.md)");

  writeHandoff(metaHome, "bikupor", "Second hive inspected.", {});
  ok(JSON.stringify(listHandoffCategories(metaHome)) === JSON.stringify(["bikupor", "tradgard"]), `categories list the filed topics (got ${JSON.stringify(listHandoffCategories(metaHome))})`);

  // Guards
  ok(writeHandoff(metaHome, "!!!", "x").ok === false, "unusable category is refused");
  ok(writeHandoff(metaHome, "woodwork", "   ").ok === false, "empty text is refused");
  ok(readHandoff(metaHome, "nope") === null, "reading an unknown topic -> null");
  ok(listHandoffCategories(path.join(metaHome, "missing")).length === 0, "missing dir -> no categories, no throw");

  // No temp files left behind.
  const leftovers = fs.readdirSync(handoffsDir(metaHome)).filter((f) => f.includes(".tmp"));
  ok(leftovers.length === 0, "atomic write leaves no .tmp files");
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.stack || err.message);
} finally {
  try {
    fs.rmSync(metaHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
console.log(exit === 0 ? "VERIFY OK: topic-keyed handoff store (slug, match-first category, atomic latest-only write)." : "VERIFY FAILED.");
process.exit(exit);
