// E2E (LIVE): does a SECOND MATE actually get the crew-dispatch tools? Task
// 9c358433 - "the 2nd mate no longer spins up autopilots, it does the work
// itself". A second mate is supposed to hold judgment and dispatch crew via
// helm_dispatch. If it does the work inline, the first question (verify before
// theorizing) is whether it even HAS helm_dispatch, or whether that tool silently
// went missing from its launch config.
//
// We verify via the transcript's MCP set, exactly like test-first-mate-gating: a
// session launched with a secondMateId (project-rooted, NOT the meta-home) should
// get the lean helm-dispatch MCP server ON TOP of its full user MCP, so
// "helm-dispatch" appears in its transcript. If it's absent, the second mate
// literally cannot dispatch - a capability regression, not a behaviour one.
//
// One cheap claude turn.
//
// Run:  node scripts/e2e/test-second-mate-dispatch-tools.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[sm-dispatch-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function findTranscript(cliSessionId) {
  const root = path.join(os.homedir(), ".claude", "projects");
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.name === `${cliSessionId}.jsonl`) {
        return p;
      }
    }
  }
  return null;
}

// The helm-dispatch MCP server carries helm_dispatch (+ the other crew tools).
// Its presence in the transcript = "this session can dispatch crew".
const DISPATCH_MARKER = "helm-dispatch";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-smdispatch-"));
const metaHome = path.join(tmp, "meta-home");
const projectDir = path.join(tmp, "some-project");
fs.mkdirSync(metaHome, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Start a project-rooted session WITH a secondMateId - the jump-into-a-second-
  // mate flow (renderer passes pane.secondMateId). No binding needed: the branch
  // condition is `secondMateId || ...`.
  const before = new Set(
    await app.eval(`(state.sessions || []).filter((s) => s.cliSessionId || s.sessionId).map((s) => s.cliSessionId || s.sessionId)`)
  );
  await app.eval(`window.helm.startSession({
    cwd: ${JSON.stringify(projectDir)},
    secondMateId: "sm_test_dispatch",
    prompt: "Reply with exactly the word: ready. Do not call any tools.",
    model: "claude-haiku-4-5-20251001",
    effort: "low"
  })`);

  let smId = null;
  for (let i = 0; i < 60; i++) {
    await wait(3000);
    const ids = await app.eval(`(() => {
      const norm = (p) => (p || "").replace(/[\\\\/]+$/,"").toLowerCase();
      return (state.sessions || [])
        .filter((x) => (x.cliSessionId || x.sessionId) && norm(x.cwd) === norm(${JSON.stringify(projectDir)}) && x.status !== "active")
        .map((x) => x.cliSessionId || x.sessionId);
    })()`);
    const fresh = ids.find((id) => !before.has(id));
    if (fresh) {
      smId = fresh;
      break;
    }
  }
  assert(!!smId, `the second-mate session completed (${smId})`);
  const tx = smId ? findTranscript(smId) : null;
  const hasDispatch = tx ? fs.readFileSync(tx, "utf8").includes(DISPATCH_MARKER) : false;
  assert(hasDispatch === true, "a second-mate session gets the helm-dispatch MCP (helm_dispatch etc.) - it CAN spin up crew");

  log(exitCode === 0 ? "VERIFY OK: the second mate has the crew-dispatch tools; if it works inline it's a behaviour/calibration issue, not a missing capability." : "VERIFY FAILED: the second mate is missing helm_dispatch - a capability regression, root-cause the launch config.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_MATES_PATH;
  delete process.env.HELM_SECOND_MATES_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
