// Unit test: the shared atomic write, and that EVERY durable store now uses it.
//
// The history matters. The tmp+rename discipline was copied into seven modules and all
// seven copies let an EPERM from the rename throw straight through as a lost write.
// Helm's durable state lives under a Dropbox-synced meta-home, so a sync client
// holding a file mid-rename is the NORMAL condition - observed for real on 2026-07-27.
// I then fixed exactly one of the seven (jot.js) and tagged the commit with the task
// about a DIFFERENT one, which is how the other six stayed broken for a while longer.
//
// So this test does two things: it exercises the shared helper, and it asserts that no
// store has a private rename left. The second half is the one that would have caught
// the original mistake.
//
// The implementation moved to `keel/storage` on 2026-08-24 - this version was the
// best in the suite, so it became the shared one, and Jot's and Nib's copies (which
// only knew half of it) now come from here rather than the other way round.
// `src/lib/atomicWrite.js` is still the import path every store uses, so both
// halves of this test still apply; `isTransientLock` is imported from keel because
// that is where the predicate lives now.
//
// Run: node scripts/e2e/test-atomic-write.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTransientLock } from "keel/storage";
import { writeFileAtomicSync, writeJsonAtomicSync } from "../../src/lib/atomicWrite.js";

let code = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    code = 1;
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-atomic-"));
const target = path.join(dir, "store.json");
const realRename = fs.renameSync;
const realUnlink = fs.unlinkSync;

/** Make renameSync throw `errCode` for the first `times` attempts on our target. */
function lockFor(times, errCode = "EPERM") {
  let thrown = 0;
  fs.renameSync = (from, to) => {
    if (to === target && thrown < times) {
      thrown += 1;
      const err = new Error("operation not permitted");
      err.code = errCode;
      throw err;
    }
    return realRename(from, to);
  };
  return () => thrown;
}

try {
  // --- the happy path ---
  ok(writeJsonAtomicSync(target, { a: 1 }).ok === true, "a plain write succeeds");
  ok(JSON.parse(fs.readFileSync(target, "utf8")).a === 1, "and the content lands");
  ok(fs.readFileSync(target, "utf8").endsWith("\n"), "JSON is written with a trailing newline, matching the previous writers");
  ok(fs.readdirSync(dir).filter((f) => f.includes(".tmp")).length === 0, "no .tmp file is left behind");

  // It creates missing directories - several stores relied on their own mkdir.
  const nested = path.join(dir, "a", "b", "c.json");
  ok(writeJsonAtomicSync(nested, { deep: true }).ok === true, "a missing directory is created");

  // --- transient locks are retried, not dropped ---
  for (const errCode of ["EPERM", "EBUSY", "EACCES"]) {
    fs.writeFileSync(target, JSON.stringify({ before: errCode }), "utf8");
    const thrown = lockFor(2, errCode);
    const t0 = Date.now();
    const res = writeFileAtomicSync(target, `after ${errCode}`);
    fs.renameSync = realRename;
    ok(res.ok === true, `${errCode}: a locked target is retried, not dropped`);
    ok(thrown() === 2, `${errCode}: the lock really fired (${thrown()})`);
    ok(fs.readFileSync(target, "utf8") === `after ${errCode}`, `${errCode}: the change reached disk`);
    ok(Date.now() - t0 < 2000, `${errCode}: the backoff stays bounded`);
  }

  // --- a lock that never clears FAILS, loudly, without touching the file ---
  fs.writeFileSync(target, "untouched", "utf8");
  lockFor(99);
  const stuck = writeFileAtomicSync(target, "should not land");
  fs.renameSync = realRename;
  ok(stuck.ok === false, "a permanent lock fails rather than claiming success");
  ok(/stayed locked|EPERM/i.test(stuck.error || ""), `and names the likely cause (${stuck.error})`);
  ok(fs.readFileSync(target, "utf8") === "untouched", "the original file is intact - no half-write");
  ok(fs.readdirSync(dir).filter((f) => f.includes(".tmp")).length === 0, "and no .tmp files are left from the failed attempts");

  // --- a temp file that is ITSELF briefly locked is still cleaned up, not leaked ---
  // The leak that motivated the retried cleanup (found 2026-08-12): on Windows+Dropbox
  // the sync client can grab a lock on the fresh .tmp the instant it appears, so the
  // rename fails AND the first unlink of that temp fails too. The old code unlinked
  // once and swallowed the error, leaving the temp behind - and since fleet-state is
  // rewritten every ~5s, the dispatch dir accumulated 1462 orphaned
  // `.fleet-state.json.<uuid>.tmp` files. A single silent unlink would fail this.
  {
    fs.writeFileSync(target, "untouched", "utf8");
    // Rename fails hard (one attempt, one temp) so we land straight in cleanup.
    fs.renameSync = (from, to) => {
      if (to === target) {
        const err = new Error("no such device");
        err.code = "ENODEV";
        throw err;
      }
      return realRename(from, to);
    };
    // The temp's OWN unlink is locked for its first two tries, then clears - exactly
    // the Dropbox-grabbed-the-tmp race.
    let unlinkFails = 2;
    fs.unlinkSync = (p) => {
      if (String(p).includes(".tmp") && unlinkFails > 0) {
        unlinkFails -= 1;
        const err = new Error("resource busy");
        err.code = "EBUSY";
        throw err;
      }
      return realUnlink(p);
    };
    const res = writeFileAtomicSync(target, "should not land");
    fs.renameSync = realRename;
    fs.unlinkSync = realUnlink;
    ok(res.ok === false, "a hard rename error still fails the write");
    ok(unlinkFails === 0, `the temp's locked unlink was retried past its lock, not abandoned (${unlinkFails} fails left)`);
    ok(fs.readdirSync(dir).filter((f) => f.includes(".tmp")).length === 0, "the briefly-locked temp is eventually removed, not leaked");
    ok(fs.readFileSync(target, "utf8") === "untouched", "and the original file is untouched");
  }

  // --- a REAL error is not retried into a hang ---
  fs.renameSync = (from, to) => {
    if (to === target) {
      const err = new Error("no such device");
      err.code = "ENODEV";
      throw err;
    }
    return realRename(from, to);
  };
  const hard = writeFileAtomicSync(target, "x");
  fs.renameSync = realRename;
  ok(hard.ok === false && /no such device/.test(hard.error || ""), `a non-lock error fails immediately with its own message (${hard.error})`);

  // --- the onBeforeRename hook (jot.js's concurrent-edit guard) ---
  let asked = 0;
  const aborted = writeFileAtomicSync(target, "nope", {
    onBeforeRename: () => {
      asked += 1;
      return "someone else changed it";
    },
  });
  ok(aborted.ok === false && /changed it/.test(aborted.error || ""), "onBeforeRename can abort the write");
  ok(asked > 1, `and it is re-asked on each attempt, on fresh data (${asked} times)`);
  ok(fs.readFileSync(target, "utf8") === "untouched", "an aborted write leaves the file alone");
  ok(fs.readdirSync(dir).filter((f) => f.includes(".tmp")).length === 0, "and cleans up its temp files");

  ok(isTransientLock({ code: "EPERM" }) === true && isTransientLock({ code: "ENOENT" }) === false, "isTransientLock distinguishes a lock from a real failure");
  ok(isTransientLock(null) === false, "isTransientLock(null) is safe");

  // --- NO STORE MAY KEEP A PRIVATE RENAME -----------------------------------
  // This is the assertion that would have caught the original mistake: fixing one
  // writer and believing the class was closed. Every durable store must go through
  // the shared helper, so a future one cannot quietly reintroduce the hole.
  const libDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "lib");
  const offenders = [];
  for (const file of fs.readdirSync(libDir).filter((f) => f.endsWith(".js") && f !== "atomicWrite.js")) {
    const src = fs
      .readFileSync(path.join(libDir, file), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    if (/fs\.renameSync\s*\(/.test(src)) {
      offenders.push(file);
    }
  }
  // dispatchQueue's CLAIM uses renameSync as a lock (rename-or-lose), not as a write -
  // a failed rename there is the intended signal that another worker won the race, so
  // retrying it would break the claim. Named explicitly rather than pattern-excluded.
  const allowed = new Set(["dispatchQueue.js"]);
  const unexpected = offenders.filter((f) => !allowed.has(f));
  ok(unexpected.length === 0, `no lib module keeps a private atomic rename (found: ${unexpected.join(", ") || "none"})`);

  // --- AND NO STORE MAY WRITE ITSELF WITHOUT THE HELPER ---------------------
  // The check above only catches a store that rolled its OWN tmp+rename. It could
  // not see config.js, which had no rename at all - just a bare overwrite. That
  // slipped through the whole atomic-write task and was only found on 2026-08-02
  // while chasing an unrelated test failure. config.json is the most frequently
  // written store in the app, so it was the worst one to miss.
  //
  // The class rule: if a lib declares a HELM_*_PATH store seam, it owns a durable
  // file, and it must write through the shared helper.
  // APPEND-ONLY logs are the deliberate exception. A tmp+rename would replace the
  // whole file, which is the opposite of appending a line - and a torn append at
  // worst loses the last usage entry, not the store. Named, not pattern-excluded,
  // so this list has to be maintained honestly.
  const appendOnly = new Set(["helmUsage.js", "usage.js"]);
  const missing = [];
  for (const file of fs.readdirSync(libDir).filter((f) => f.endsWith(".js") && f !== "atomicWrite.js" && f !== "packagedPaths.js")) {
    if (appendOnly.has(file)) {
      continue;
    }
    const src = fs.readFileSync(path.join(libDir, file), "utf8");
    const declaresStore = /process\.env\.HELM_[A-Z0-9_]*PATH/.test(src);
    if (!declaresStore) {
      continue;
    }
    // Check for the WRITE, not for the import.
    //
    // The first version of this asserted only that `from "./atomicWrite.js"`
    // appeared in the file. The pre-release review mutation-tested it: putting the
    // old `fs.writeFileSync(configPath, ...)` back into config.js while leaving the
    // import line alone left this assertion green. The guard written to catch
    // exactly that regression did not catch it. An import is not a call.
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    if (/fs\.writeFileSync\s*\(/.test(code)) {
      missing.push(`${file} (writes directly)`);
      continue;
    }
    if (!/writeJsonAtomicSync\s*\(|writeFileAtomicSync\s*\(/.test(code)) {
      missing.push(`${file} (never calls the helper)`);
    }
  }
  ok(missing.length === 0, `every whole-file store writes through the shared helper (missing: ${missing.join(", ") || "none"})`);
  for (const f of appendOnly) {
    const src = fs.readFileSync(path.join(libDir, f), "utf8");
    ok(/appendFileSync/.test(src) && !/writeFileSync/.test(src), `${f} really is append-only, so its exemption is earned`);
  }
  ok(offenders.includes("dispatchQueue.js"), "dispatchQueue still has its rename-as-a-lock (the deliberate exception, so this list stays honest)");
} catch (err) {
  code = 1;
  console.error("ERR", err.stack || err.message);
} finally {
  fs.renameSync = realRename;
  fs.unlinkSync = realUnlink;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
console.log(code === 0 ? "\nVERIFY OK: locked writes are retried, permanent locks fail loudly, and no store keeps a private rename." : "\nVERIFY FAILED");
process.exit(code);
