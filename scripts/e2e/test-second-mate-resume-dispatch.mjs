// A DIRECT/derived second mate must keep its dispatch identity when RESUMED, not just when
// opened fresh. The bug (found by following a live Halyard session): jumpIntoSecondMate set
// secondMateId only on the fresh path; resuming an existing project session dropped it, so
// session:start launched a PLAIN session with no helm_dispatch and no delegate manual - and it
// did every task itself instead of dispatching autopilots. A direct second mate's session is
// never bound, so openSessionInPane's own secondMateForSession lookup can't recover the id;
// jumpIntoSecondMate now passes it explicitly (and binds it).
//
// This drives the real renderer flow in a launched app (no model tokens): stage an UNBOUND
// session, jump into it as a second mate, and assert the resumed pane carries the second-mate
// id - the exact thing that makes session:start attach the crew-dispatch tools.
//
// Run:  node scripts/e2e/test-second-mate-resume-dispatch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./harness.mjs";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-sm-resume-"));
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json"); // isolate the bind
process.env.HELM_SESSIONS_ROOT = path.join(tmp, "no-sessions");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9585";

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const PROJECT = "D:/Repo/Work/Internal/some-project";
  const res = await app.eval(`(() => {
    // An existing project session that is NOT bound to any second mate (a direct/derived
    // second mate - exactly the Halyard case). secondMateBySessionId is empty, so the OLD
    // resume path left secondMateId undefined here.
    state.sessions = [{ sessionId: "s-rein", cliSessionId: "c-rein", cwd: ${JSON.stringify(PROJECT)}, title: "a running halyard chat", status: "idle", isArchived: false, lastActivityAt: 2 }];
    secondMateBySessionId = new Map();
    mateBySessionId = new Map();
    jumpIntoSecondMate({ secondMateId: "sess_c-rein", projectPath: ${JSON.stringify(PROJECT)}, sessionId: "c-rein", name: "Halyard" });
    const p = panes[0] || {};
    return { secondMateId: p.secondMateId, cliSessionId: p.cliSessionId, sessionId: p.sessionId };
  })()`);

  ok(
    res.cliSessionId === "c-rein",
    `jump-in RESUMED the existing session (not a fresh one) (${JSON.stringify(res.cliSessionId)})`
  );
  ok(
    res.secondMateId === "sess_c-rein",
    `the resumed pane carries the second-mate id even though the session was UNBOUND - so session:start attaches helm_dispatch + the delegate manual (${JSON.stringify(res.secondMateId)})`
  );

  // The bind was written to the isolated store, so a later resolve/rebuild recognises it.
  //
  // This used to assert the binding appeared under "sess_c-rein" - the renderer's own
  // display key. That WAS the behaviour, and it was the bug (task 99089c59): the key
  // became a durable identity, crew runs were stamped with it, and deriveSecondMates
  // (which knows only "sm_") hashed them into a phantom node, so the second mate the
  // captain was looking at showed no crew at all. The test's intent - a jump-in binds
  // the session so a later resolve finds it - is unchanged and still checked here; only
  // the id it must be filed under is corrected, to the one secondMateId() mints.
  const { secondMateId, DIRECT_FIRST_MATE } = await import("../../src/lib/secondMates.js");
  const expectedId = secondMateId(DIRECT_FIRST_MATE, PROJECT);
  const bindings = JSON.parse(fs.readFileSync(process.env.HELM_SECOND_MATES_PATH, "utf8"));
  ok(
    bindings[expectedId]?.sessionId === "c-rein",
    `jump-in BOUND the session under the real second-mate id ${expectedId} (${JSON.stringify(bindings[expectedId] || null)})`
  );
  ok(
    bindings[expectedId]?.projectPath,
    `and recorded its project (${bindings[expectedId]?.projectPath || "MISSING"}) - without it deriveSecondMates cannot render the node until its first dispatch lands`
  );
  ok(
    !Object.keys(bindings).some((k) => k.startsWith("sess_")),
    `and nothing was filed under a display key (${Object.keys(bindings).join(", ") || "empty"}) - two id namespaces for one thing is what produced the phantom`
  );

  // Source: the resume path forwards the id (a plain openSessionInPane(existing, 0) is the bug).
  const src = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  ok(
    /openSessionInPane\(existing, 0, \{ secondMateId: sm\.secondMateId \}\)/.test(src),
    "jumpIntoSecondMate forwards secondMateId to openSessionInPane on the resume path"
  );

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors.slice(0, 6)) {
    console.log("   ", e.text.slice(0, 160));
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    await app?.close();
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_SECOND_MATES_PATH;
  delete process.env.HELM_SESSIONS_ROOT;
}

console.log(
  exit === 0
    ? "VERIFY OK: resuming a direct second mate keeps its dispatch identity, so it launches with the crew-dispatch tools instead of as a plain session."
    : "VERIFY FAILED."
);
process.exit(exit);
