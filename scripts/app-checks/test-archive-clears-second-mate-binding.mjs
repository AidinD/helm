// A second mate bound to a session must LET IT GO when that session is archived.
// The second mate id is deterministic per (first mate, project), so a stale binding
// to an archived session makes a freshly-created second mate for the SAME project
// inherit it - and jumping in then resurrects the archived session instead of
// starting fresh (the captain, 2026-08-12: "den 2nd mate som spann upp bindades till en
// annan session jag redan arkiverat").
//
// Drives the REAL session:archive IPC in a launched app and checks the on-disk
// second-mate binding was reverted to a null-session "proposed" state.
//
// Run:  node scripts/e2e/test-archive-clears-second-mate-binding.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-arch-bind-"));
const bindingsPath = path.join(tmp, "second-mates.json");
const SM_BOUND = "sm_boundproject1"; // its session gets archived -> must be cleared
const SM_OTHER = "sm_otherproject9"; // an unrelated binding -> must be untouched
const ARCHIVED_SESSION = "sess-to-archive-1234";
const readBindings = () => JSON.parse(fs.readFileSync(bindingsPath, "utf8"));

try {
  fs.writeFileSync(
    bindingsPath,
    JSON.stringify({
      [SM_BOUND]: { firstMateId: "mate_a", projectPath: "D:/Repo/Proj", sessionId: ARCHIVED_SESSION, status: "created" },
      [SM_OTHER]: { firstMateId: "mate_a", projectPath: "D:/Repo/Other", sessionId: "sess-keep-9999", status: "created" },
    }),
    "utf8"
  );
  process.env.HELM_SECOND_MATES_PATH = bindingsPath;

  const app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Precondition.
  ok(readBindings()[SM_BOUND].sessionId === ARCHIVED_SESSION, "precondition: the second mate is bound to the session about to be archived");

  // Archive the session through the real IPC (what the sidebar's archive button calls).
  const res = await app.eval(`window.helm.archiveSession(${JSON.stringify(ARCHIVED_SESSION)}, true)`);
  ok(res?.ok === true, `session:archive succeeded (${JSON.stringify(res)})`);

  const after = readBindings();
  ok(after[SM_BOUND] && after[SM_BOUND].sessionId === null, `the bound second mate's session was CLEARED (got ${JSON.stringify(after[SM_BOUND]?.sessionId)})`);
  ok(after[SM_BOUND].status === "proposed", `and it reverted to "proposed" so a jump-in starts fresh (got ${JSON.stringify(after[SM_BOUND]?.status)})`);
  ok(after[SM_OTHER] && after[SM_OTHER].sessionId === "sess-keep-9999", "an unrelated second mate's binding is untouched");

  // Un-archiving must NOT re-bind (the session is gone from the node for good).
  await app.eval(`window.helm.archiveSession(${JSON.stringify(ARCHIVED_SESSION)}, false)`);
  ok(readBindings()[SM_BOUND].sessionId === null, "un-archiving does not resurrect the binding");

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  await app.close();
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  delete process.env.HELM_SECOND_MATES_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(exit === 0 ? "VERIFY OK: archiving a session frees the second mate bound to it (no stale archived-session binding)." : "VERIFY FAILED.");
process.exit(exit);
