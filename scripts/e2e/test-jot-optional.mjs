// Unit test (no electron): Helm survives a machine where Jot was never installed,
// and SAYS SO instead of showing an empty board.
//
// Card 6c84414b, from a real first-time user: they installed Helm and it "did not
// work" because Jot was not installed. Two distinct failures were reproduced on
// 2026-09-02, and this test guards both:
//
//   1. FATAL. `@jot/core` is declared `file:../jot/dist-core`, a sibling checkout.
//      `npm install` in a clone with no jot repo next to it exits 0 and leaves a
//      dangling symlink. src/lib/jotHostStore.js imported it STATICALLY and main.js
//      imports that module, so Electron printed "App threw an error during load /
//      ERR_MODULE_NOT_FOUND: Cannot find package '@jot/core'" and opened no window
//      at all. Guarded by the subprocess check below, which loads jotHostStore.js
//      from a directory where @jot/core genuinely cannot resolve.
//
//   2. A CONFIDENT LIE. @jot/core's init() WRITES the todos.json it failed to read,
//      so mounting the embedded Jot tab on a machine with no Jot manufactured an
//      empty board in Jot's data directory and rendered it. The tab then said "you
//      have no tasks" when the truth was "Jot has never run here". Guarded by the
//      jotMountDecision / jotUnavailableMessage checks.
//
// Run:  node scripts/e2e/test-jot-optional.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { jotBoardStatus, jotUnavailableMessage } from "../../src/lib/jot.js";
import { jotMountDecision } from "../../src/lib/jotHostStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, "..", "..", "src", "lib");

let exitCode = 0;
function ok(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-jot-optional-"));

// The DEFAULT board location, pointed at a directory that does not exist - which is
// what a machine with no Jot looks like. Without this the checks below would pass or
// fail depending on whether whoever runs them happens to have Jot installed, and on
// this developer's machine they would always take the happy path.
const priorJotDataDir = process.env.JOT_DATA_DIR;
process.env.JOT_DATA_DIR = path.join(tmp, "never-installed", "jot");

try {
  // ---------------------------------------------------------------- board status
  const missing = path.join(tmp, "never-installed", "jot", "todos.json");
  const statusMissing = jotBoardStatus({ path: missing });
  ok(statusMissing.available === false, "jotBoardStatus reports no board when todos.json is absent");
  ok(statusMissing.reason === "no-board", `the reason is "no-board" (got ${statusMissing.reason})`);
  ok(statusMissing.explicitPath === true, "an explicit config path is reported as explicit");

  const defaulted = jotBoardStatus({});
  ok(defaulted.explicitPath === false, "the default location is NOT reported as an explicit path");

  const real = path.join(tmp, "todos.json");
  fs.writeFileSync(real, JSON.stringify({ todos: [], categories: [], tags: [] }));
  const statusEmptyBoard = jotBoardStatus({ path: real });
  ok(statusEmptyBoard.available === true, "an EMPTY but readable board counts as available (empty is not missing)");

  ok(jotBoardStatus({ enabled: false }).reason === "disabled", "the config off-switch reports itself as disabled, not as a missing board");

  // ------------------------------------------------------------------- the words
  const message = jotUnavailableMessage(statusMissing);
  ok(/jot/i.test(message), "the message names Jot");
  ok(message.includes(missing), "the message says WHERE the board was expected");
  ok(/install|open/i.test(message), "the message says what to do about it");
  ok(!/no tasks|nothing to do|all caught up/i.test(message), 'the message does NOT read as "you have no tasks"');
  ok(jotUnavailableMessage(jotBoardStatus({ path: real })) === null, "an available board produces no message");

  // -------------------------------------------------------------- mount decision
  const coreOk = { available: true, error: null };
  const coreGone = { available: false, error: "Helm could not load @jot/core, ..." };

  const noBoardDefault = jotMountDecision(jotBoardStatus({}), coreOk);
  ok(noBoardDefault.mount === false, "REFUSES to mount at the default location when no board exists");
  ok(noBoardDefault.reason === "no-board", `the refusal reason is "no-board" (got ${noBoardDefault.reason})`);
  ok(Boolean(noBoardDefault.error) && /jot/i.test(noBoardDefault.error), "the refusal carries an explanation naming Jot");

  const noBoardExplicit = jotMountDecision(jotBoardStatus({ path: missing }), coreOk);
  ok(noBoardExplicit.mount === true, "MOUNTS when the user pointed jot.path at a file, even if it isn't there yet");

  const haveBoard = jotMountDecision(jotBoardStatus({ path: real }), coreOk);
  ok(haveBoard.mount === true && haveBoard.error === null, "mounts a board that exists, with no message");

  const noCore = jotMountDecision(jotBoardStatus({ path: real }), coreGone);
  ok(noCore.mount === false, "refuses to mount when @jot/core is not in this build");
  ok(noCore.reason === "core-missing", `a missing @jot/core is its own reason, not "no-board" (got ${noCore.reason})`);

  // -------------------------------- @jot/core must not be a LOAD-TIME dependency
  //
  // Run in a child node process from a directory where the package genuinely cannot
  // resolve. A copy of src/lib plus a minimal `keel/storage` stub is the whole
  // dependency closure of jotHostStore.js, so the ONLY thing missing there is
  // @jot/core - which is the condition under test.
  const sandbox = path.join(tmp, "no-jot-installed");
  fs.mkdirSync(sandbox, { recursive: true });
  fs.cpSync(LIB, path.join(sandbox, "lib"), { recursive: true });
  const keelDir = path.join(sandbox, "node_modules", "keel");
  fs.mkdirSync(keelDir, { recursive: true });
  fs.writeFileSync(
    path.join(keelDir, "package.json"),
    JSON.stringify({ name: "keel", version: "0.0.0", type: "module", exports: { "./storage": "./storage.js" } })
  );
  fs.writeFileSync(
    path.join(keelDir, "storage.js"),
    "export function writeFileAtomicSync() { return { ok: true }; }\nexport function writeJsonAtomicSync() { return { ok: true }; }\n"
  );
  fs.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ name: "sandbox", type: "module" }));

  const probe = path.join(sandbox, "probe.mjs");
  fs.writeFileSync(
    probe,
    [
      "const out = { loaded: false, coreAvailable: null, coreError: null, factoryCode: null, factoryMessage: null };",
      "let mod;",
      "try {",
      "  mod = await import('./lib/jotHostStore.js');",
      "  out.loaded = true;",
      "} catch (err) {",
      "  out.coreError = `load failed: ${err.code || ''} ${err.message}`;",
      "  console.log(JSON.stringify(out));",
      "  process.exit(0);",
      "}",
      "const avail = await mod.jotCoreAvailable();",
      "out.coreAvailable = avail.available;",
      "out.coreError = avail.error;",
      "try {",
      "  await mod.createJotHostStore(process.cwd());",
      "} catch (err) {",
      "  out.factoryCode = err.code || null;",
      "  out.factoryMessage = err.message;",
      "}",
      "console.log(JSON.stringify(out));",
    ].join("\n")
  );

  let child;
  try {
    child = JSON.parse(execFileSync(process.execPath, [probe], { cwd: sandbox, encoding: "utf8" }).trim());
  } catch (err) {
    child = { loaded: false, coreError: `probe process failed: ${err.message}` };
  }

  ok(child.loaded === true, `jotHostStore.js LOADS with no @jot/core installed (main.js can start) - ${child.loaded ? "loaded" : child.coreError}`);
  ok(child.coreAvailable === false, "jotCoreAvailable() reports it missing instead of throwing at import time");
  ok(child.factoryCode === "JOT_CORE_MISSING", `createJotHostStore() rejects with code JOT_CORE_MISSING (got ${child.factoryCode})`);
  ok(
    typeof child.factoryMessage === "string" && /newer build/i.test(child.factoryMessage) && /jot repository/i.test(child.factoryMessage),
    "that error tells an installed user AND a source user what to do"
  );

  console.log(
    exitCode === 0
      ? "VERIFY OK: Helm loads and explains itself on a machine with no Jot - @jot/core is not a load-time dependency, and a missing board is refused with a reason instead of mounted as an empty one."
      : "VERIFY FAILED."
  );
} finally {
  if (priorJotDataDir === undefined) {
    delete process.env.JOT_DATA_DIR;
  } else {
    process.env.JOT_DATA_DIR = priorJotDataDir;
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* leftover temp dir, harmless */
  }
}

process.exit(exitCode);
