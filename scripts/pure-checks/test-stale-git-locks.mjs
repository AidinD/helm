/**
 * A lock left by a killed process gets cleared; a live one is never touched.
 *
 * ## What this is for
 *
 * git takes `.git/index.lock` before writing its index and releases it after. Kill the
 * process in between and the lock stays forever, and git refuses EVERY writing command in
 * that repository from then on.
 *
 * Found 2026-08-20 by accident: four repositories across the tree, all from one afternoon,
 * two of them work repositories that had silently been unable to accept a commit for two
 * days. Nothing warns, and the eventual error is about a lock file rather than about a run
 * that died on Tuesday. It happened twice again on 2026-09-01, from interrupted shell
 * commands rather than killed runs, which is a wider cause than the original card assumed.
 *
 * ## Which half matters more
 *
 * Not the clearing. Deleting a LIVE lock destroys the index write it belongs to, which is a
 * worse failure than the one being fixed - so most of what follows is about the locks this
 * must refuse to touch, and about failing safe when it cannot tell.
 *
 * Run: node scripts/e2e/test-stale-git-locks.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findStaleIndexLocks, clearStaleIndexLocks, runningGitCommandLines, STALE_AFTER_MS } from "../../src/lib/gitLocks.js";

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-gitlocks-"));
const NOW = Date.parse("2026-09-01T12:00:00Z");
const NO_GIT_RUNNING = { ok: true, lines: [] };

/** A repo directory with an optional index.lock of a given size and age. */
function repo(name, lock) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  if (lock) {
    const lockPath = path.join(dir, ".git", "index.lock");
    fs.writeFileSync(lockPath, lock.content ?? "", "utf8");
    const when = new Date(NOW - lock.ageMs);
    fs.utimesSync(lockPath, when, when);
  }
  return dir;
}

const abandoned = repo("abandoned", { ageMs: STALE_AFTER_MS + 60_000 });
const fresh = repo("fresh", { ageMs: 2_000 });
const partial = repo("partial", { ageMs: STALE_AFTER_MS + 60_000, content: "half an index\n" });
const clean = repo("clean", null);
const all = [abandoned, fresh, partial, clean];

// --- what it finds ---------------------------------------------------------------
{
  const { stale, kept } = findStaleIndexLocks(all, { now: NOW, gitProcesses: NO_GIT_RUNNING });
  ok(stale.length === 1 && stale[0].repoPath === abandoned, "the empty, old, unattended lock is the only one called stale", `${stale.length} found`);
  ok(!kept.some((k) => k.repoPath === clean), "a repository with no lock is not mentioned at all");

  const freshKept = kept.find((k) => k.repoPath === fresh);
  ok(!!freshKept, "a lock a few seconds old is kept");
  // The reason matters: an empty lock IS what a live one looks like for its first
  // milliseconds, so age is the only thing separating the two.
  ok(/live one looks like/.test(freshKept?.why || ""), "and the reason says why age is the deciding thing", freshKept?.why);

  const partialKept = kept.find((k) => k.repoPath === partial);
  ok(!!partialKept, "a lock with CONTENT is kept however old it is");
  ok(/not empty/.test(partialKept?.why || ""), "because git writes the new index into it, so a write got somewhere", partialKept?.why);
}

// --- a git process against that repo makes it untouchable ---------------------------
{
  const busy = { ok: true, lines: [`C:\\Program Files\\Git\\cmd\\git.exe -C ${abandoned} commit -m x`] };
  const { stale, kept } = findStaleIndexLocks(all, { now: NOW, gitProcesses: busy });
  ok(stale.length === 0, "nothing is stale while a git process names that repository");
  ok(/git process is running/.test(kept.find((k) => k.repoPath === abandoned)?.why || ""), "and it says so");

  // Path spelling must not be the thing that decides. A process line with forward slashes
  // and different case is the same repository.
  const oddly = { ok: true, lines: [`git.exe -C ${abandoned.replace(/\\/g, "/").toUpperCase()} status`] };
  ok(findStaleIndexLocks(all, { now: NOW, gitProcesses: oddly }).stale.length === 0, "however the path is spelled in the process line");
}

// --- and an unreadable process list means BUSY, never free ----------------------------
// The one that decides whether this tool can destroy a live index write on a machine where
// the query does not work.
{
  const { stale, kept } = findStaleIndexLocks(all, { now: NOW, gitProcesses: { ok: false, lines: [] } });
  ok(stale.length === 0, "when the process list cannot be read, NOTHING is stale");
  ok(/counts as busy/.test(kept.find((k) => k.repoPath === abandoned)?.why || ""), "and it says the repository counts as busy", kept.find((k) => k.repoPath === abandoned)?.why);
}

// --- clearing, and only the right one --------------------------------------------------
{
  const before = all.filter((r) => fs.existsSync(path.join(r, ".git", "index.lock"))).length;
  ok(before === 3, "three locks exist before the sweep", String(before));

  const result = clearStaleIndexLocks(all, { now: NOW, gitProcesses: NO_GIT_RUNNING });
  ok(result.removed.length === 1 && result.removed[0].repoPath === abandoned, "exactly one is removed");
  ok(result.failed.length === 0, "with nothing failing", JSON.stringify(result.failed));

  ok(!fs.existsSync(path.join(abandoned, ".git", "index.lock")), "the abandoned lock is gone from disk");
  // The half that would be a disaster.
  ok(fs.existsSync(path.join(fresh, ".git", "index.lock")), "the fresh one is still there");
  ok(fs.existsSync(path.join(partial, ".git", "index.lock")), "and so is the one with content");
  ok(fs.readFileSync(path.join(partial, ".git", "index.lock"), "utf8") === "half an index\n", "untouched, not truncated");
}

// --- a second sweep is quiet ---------------------------------------------------------
{
  const again = clearStaleIndexLocks(all, { now: NOW, gitProcesses: NO_GIT_RUNNING });
  ok(again.removed.length === 0, "a repeat sweep removes nothing");
}

// --- can this machine answer the question the safety rests on? --------------------------
// Every refusal above depends on knowing which git processes are running. If that lookup
// stops working - no PowerShell, a locked-down box, a renamed binary - the sweep does not
// break, it goes SILENTLY INERT: every lock is kept because every repository counts as busy.
// That is the safe direction and the invisible one, so it is said out loud rather than
// asserted away.
{
  const probe = runningGitCommandLines();
  ok(typeof probe.ok === "boolean" && Array.isArray(probe.lines), "the process lookup returns a well-formed answer");
  if (probe.ok) {
    ok(true, `and this machine can read it (${probe.lines.length} git process(es) right now)`);
  } else {
    // Not a failure: a machine that cannot answer is a real machine. But a sweep that can
    // never clear anything should not be discovered by wondering why locks pile up.
    console.log("--   NOTE: the process list could not be read here, so the sweep will clear NOTHING on this machine.");
  }
}

// --- and it is actually run at startup --------------------------------------------------
// The join. A sweep nothing calls is a sweep that has never run - and this whole card exists
// because nothing noticed four dead repositories for two days.
{
  const main = fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
  ok(/clearStaleIndexLocks\(/.test(main), "main.js calls the sweep");
}

fs.rmSync(root, { recursive: true, force: true });

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: an abandoned lock is cleared, and a live, a fresh or an unverifiable one is left exactly where it is.");
