// Verifying a check signature must never CREATE the signing key.
//
// The key is what separates "the app ran this check and stamped the result" from "the author
// wrote down an outcome they believed". runKey() minted one when the file was absent, and
// verifyCheckRun reaches runKey through signCheckRun - so merely LOOKING at a board could
// create it. Two ways that goes wrong:
//
//   - The review queue is built in the off-main worker, whose one stated invariant is that it
//     never writes. Two processes finding the file missing at once mint different keys and
//     race; the loser's key wins on disk, and every run signed before that silently fails to
//     verify from then on - the board reports verified work as unverified.
//   - It is wrong on its own terms anyway: minting a key while checking a signature
//     guarantees the signature cannot match.
//
// The fix passes create:false from verifyCheckRun. It shipped in eb24914 with NO test at all,
// in a commit whose whole theme was tests staying green against broken code - a second review
// mutated it straight back to create:true and the fast lane stayed 85/85 green.
//
// Pure (no app/harness) - runs in the fast lane.
// Run:  node scripts/e2e/test-run-key-readonly.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signCheckRun, verifyCheckRun } from "../../src/lib/reviewRecords.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), "helm-runkey-"));
const keyFile = path.join(home, ".helm", "run-key");
const TASK = "aaaaaaaa-0000-0000-0000-000000000000";
const run = { label: "unit", cmd: "npm run test:fast", exitCode: 0, ranAt: 1_700_000_000_000 };

try {
  ok(!fs.existsSync(keyFile), "the fixture starts with no run-key on disk");

  // --- VERIFYING must not write -------------------------------------------------
  const verdict = verifyCheckRun(home, TASK, { ...run, sig: "0".repeat(64) });
  ok(verdict === false, "verifying a signature with no key present returns false - 'cannot confirm', which renders as unverified");
  ok(
    !fs.existsSync(keyFile),
    "and it did NOT create the key. This is the whole fix: the off-main worker reaches this path, and a second writer of the meta-home is a race that silently invalidates every previously signed run"
  );

  // --- SIGNING still establishes the key on first use ---------------------------
  const sig = signCheckRun(home, TASK, run);
  ok(typeof sig === "string" && sig.length > 0, "signing a run DOES mint the key on first use, so a fresh meta-home still works");
  ok(fs.existsSync(keyFile), "the key file now exists");
  const keyAfterSign = fs.readFileSync(keyFile, "utf8");

  // --- and a run signed with it verifies ---------------------------------------
  ok(verifyCheckRun(home, TASK, { ...run, sig }) === true, "a run signed with that key verifies");
  ok(fs.readFileSync(keyFile, "utf8") === keyAfterSign, "verifying did not rewrite the key either");

  // --- the failure mode the race would produce ----------------------------------
  // Not a race, but the CONSEQUENCE of one, so the cost is on the record: a different key on
  // disk makes an already-signed run read as unverified.
  fs.writeFileSync(keyFile, "f".repeat(64) + "\n", "utf8");
  ok(
    verifyCheckRun(home, TASK, { ...run, sig }) === false,
    "with a DIFFERENT key on disk, the same signed run no longer verifies - this is exactly what a second process minting its own key would do to every stamp on the board"
  );
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(
  exit === 0
    ? "VERIFY OK: reading a signature never writes the key, and signing still creates it on a fresh meta-home."
    : "VERIFY FAILED."
);
process.exit(exit);
