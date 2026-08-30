// Auto-compact must not attack a session it has already compacted.
//
// THE BUG THIS PINS, measured 2026-08-28 on the real machine:
//
//   estimateSessionContextTokens read the newest usage block in the transcript tail. On a
//   freshly compacted session that block is the COMPACTION'S OWN summarization call, which
//   read the entire pre-compaction context. So a session whose real context was 17,189
//   tokens reported 879,644, stayed over every threshold forever, and was compacted again
//   on the next sweep - fifteen minutes later, indefinitely.
//
//   634 /compact calls are recorded on disk against 5 rows in the usage log. The estimator
//   was not lagging reality; it was reading the receipt for the operation that made it
//   obsolete.
//
// The fix reads the CLI's own `postTokens` off the compaction boundary when no usage block
// follows it, and returns null - never a number - when it cannot tell. Every uncertain case
// must end in "do not compact": a wrong `false` costs one sweep, a wrong `true` costs a
// model call over the biggest context on the machine.
//
// MUTATIONS THAT MUST TURN THIS RED (run them; a guard that survives its own mutation is
// not a guard):
//   - revert the estimate to "last cache_read_input_tokens in the tail"      -> case 1, 2
//   - swap the JSON.parse marker check for text.includes("compact_boundary") -> case 5
//   - read `postTokens` only, dropping the snake_case fallback               -> case 2
//   - treat "no LINE after the boundary" instead of "no USAGE BLOCK after"   -> case 1
//   - return 0 instead of null on an unreadable tail                         -> case 7
//
// Pure (no app/harness) - runs in the fast lane.
// Run:  node scripts/e2e/test-auto-compact-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// MUST precede the dynamic import: paths.js resolves projectsRoot at import time, so a
// static import here would silently test the real ~/.claude/projects instead of the fixtures.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-compact-"));
const projects = path.join(tmp, "projects");
const projDir = path.join(projects, "D--fixture");
fs.mkdirSync(projDir, { recursive: true });
process.env.HELM_PROJECTS_ROOT = projects;

const { estimateSessionContextTokens, shouldCompact } = await import("../../src/lib/orchestratorHelper.js");
const { invalidateTranscriptIndex } = await import("../../src/lib/paths.js");

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

let n = 0;
/** Write a transcript fixture and return its session id. */
const fixture = (lines) => {
  const id = `0000000${++n}-1111-4111-8111-222222222222`;
  fs.writeFileSync(path.join(projDir, `${id}.jsonl`), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n", "utf8");
  // paths.js caches its transcript index, so a fixture written after the first lookup is
  // invisible. Found the hard way while writing this: three cases returned null, and two
  // others PASSED FOR THE WRONG REASON - they expect null, and an unfindable file returns
  // null too. A test that cannot tell "correctly declined" from "could not find the file"
  // is not testing anything, which is the exact defect class this whole file is about.
  invalidateTranscriptIndex();
  return id;
};

const usage = (cacheRead) => ({
  type: "assistant",
  message: { usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead } },
});
const boundary = (post, { snake = false } = {}) =>
  snake
    ? { type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 880000, post_tokens: post, duration_ms: 145097 } }
    : { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 880000, postTokens: post, durationMs: 145097 } };
const queued = { type: "user", toolUseResult: null, content: '{"type":"queue-operation","operation":"enqueue","content":"/compact"}' };

const OPTS = { threshold: 150000, idleMs: 10 * 60 * 1000, now: Date.now() };
const idle = (id) => ({ cliSessionId: id, sessionId: id, lastActivityAt: OPTS.now - 60 * 60 * 1000 });

// --- 1. the exact shape of the real bug ------------------------------------
console.log("-- a compacted session, with only queued commands after the boundary --");
{
  // Pre-compaction usage block (the big one), then the boundary, then nothing but Helm's
  // own repeated attempts. This is Tend, reproduced.
  const id = fixture([usage(879644), boundary(17189), queued, queued, queued]);
  const est = estimateSessionContextTokens(id, id);
  ok(est === 17189, `the estimate is the boundary's own post size, not the pre-compaction receipt (${est})`);
  const v = shouldCompact(idle(id), OPTS);
  ok(v.compact === false, `so it is NOT compacted again (${v.reason})`);
}

// --- 2. the other transcript format ----------------------------------------
console.log("\n-- the same, in snake_case --");
{
  const id = fixture([usage(879644), boundary(17189, { snake: true }), queued]);
  const est = estimateSessionContextTokens(id, id);
  ok(est === 17189, `post_tokens is read too - two formats, one answer (${est})`);
  ok(shouldCompact(idle(id), OPTS).compact === false, "and it is still held back");
}

// --- 3. a session that genuinely regrew ------------------------------------
console.log("\n-- compacted, then really worked on again --");
{
  const id = fixture([usage(879644), boundary(17189), usage(400000), usage(690000)]);
  const est = estimateSessionContextTokens(id, id);
  ok(est === 690002, `real usage AFTER the boundary wins - the context is genuinely big again (${est})`);
  ok(shouldCompact(idle(id), OPTS).compact === true, "so compacting it is correct");
}

// --- 4. never compacted at all ---------------------------------------------
console.log("\n-- never compacted --");
{
  const id = fixture([usage(823447)]);
  const est = estimateSessionContextTokens(id, id);
  ok(est === 823449, `the ordinary path is untouched (${est})`);
  ok(shouldCompact(idle(id), OPTS).compact === true, "a big uncompacted session is still compacted");
}

// --- 5. a session that TALKED about compaction -----------------------------
console.log("\n-- a tool result quoting the marker strings --");
{
  // Measured on the real machine: one transcript has 12 lines containing "compact_boundary"
  // of which only 8 are real system lines - the rest are tool results from the session
  // reading Helm's own source. A text scan cannot tell those apart, and the difference
  // decides whether a 900,000-token compaction fires.
  const id = fixture([
    { type: "user", message: { content: 'file contents: subtype === "compact_boundary" and "isCompactSummary":true' } },
    usage(900000),
  ]);
  const est = estimateSessionContextTokens(id, id);
  ok(est === 900002, `a quoted marker is not a boundary (${est})`);
  ok(shouldCompact(idle(id), OPTS).compact === true, "so the session is judged on its real usage");
}

// --- 5b. the phantom marker LAST, which is the case that actually needs the parse ---
console.log("\n-- the quoted marker after the last usage block --");
{
  // Mutation-testing 5 showed it passed for the wrong reason: the phantom sat BEFORE the
  // usage block, so the "is the boundary newer?" ordering check rejected it and the parse
  // was never load-bearing. Replacing the parse with a text match left 5 green.
  //
  // This is the shape that needs it: a session that read Helm's own source, so the last
  // line in the tail quotes the marker strings. Text-matched, that is a boundary with no
  // metadata, and a 900,000-token session reports null - which reads as "cannot tell" and
  // silently stops it ever being compacted.
  const id = fixture([
    usage(900000),
    { type: "user", message: { content: 'source: subtype === "compact_boundary" / "isCompactSummary":true' } },
  ]);
  const est = estimateSessionContextTokens(id, id);
  ok(est === 900002, `a quoted marker AFTER the usage block is still not a boundary (${est})`);
  ok(shouldCompact(idle(id), OPTS).compact === true, "so a genuinely big session is not hidden by its own reading material");
}

// --- 6. an unreadable tail fails SAFE --------------------------------------
console.log("\n-- nothing to read --");
{
  const id = fixture([queued, queued, queued]);
  const est = estimateSessionContextTokens(id, id);
  ok(est === null, `no usage and no boundary is null, not zero and not a guess (${est})`);
  const v = shouldCompact(idle(id), OPTS);
  ok(v.compact === false && /unknown/.test(v.reason), `and unknown means DO NOT SPEND (${v.reason})`);
}

// --- 7. a boundary with no usable size also fails safe ---------------------
console.log("\n-- a boundary that states no size --");
{
  const id = fixture([usage(879644), { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 880000 } }]);
  const est = estimateSessionContextTokens(id, id);
  ok(est === null, `a boundary with no post size is 'cannot tell', never 'it is huge' (${est})`);
  ok(shouldCompact(idle(id), OPTS).compact === false, "so nothing is spent on it");
}

// --- 8. the idle gate still applies ----------------------------------------
console.log("\n-- a session being actively worked --");
{
  const id = fixture([usage(823447)]);
  const busy = { cliSessionId: id, sessionId: id, lastActivityAt: OPTS.now - 1000 };
  const v = shouldCompact(busy, OPTS);
  ok(v.compact === false && /active/.test(v.reason), `a live session is never compacted, however big (${v.reason})`);
}

// --- 9. the timeout must clear the real world ------------------------------
console.log("\n-- the compaction deadline --");
{
  const src = fs.readFileSync(new URL("../../src/lib/orchestratorHelper.js", import.meta.url), "utf8");
  const ms = Number(/COMPACT_TIMEOUT_MS\s*=\s*([0-9_]+)/.exec(src)?.[1]?.replace(/_/g, "") || 0);
  // Measured across all 74 real compactions on this machine: median 145,097 ms, max
  // 245,132 ms. A deadline under the median guarantees failure on exactly the sessions the
  // feature exists for, and each failure still pays full price.
  ok(ms >= 250000, `the deadline (${ms.toLocaleString()} ms) clears the longest observed real compaction (245,132 ms)`);
  ok(/killChildTree\(child\)/.test(src), "and a timeout kills the process TREE - the bare kill left the compaction running and paying");
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  exit === 0
    ? "\nVERIFY OK: a compacted session reports its real size, an uncertain one is never compacted, and the deadline clears a real compaction."
    : "\nVERIFY FAILED."
);
process.exit(exit);
