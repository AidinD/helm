import { requireLive } from "../checks-lib/live-gate.mjs";
requireLive("starts a real first-mate session to see its binding land");

// E2E (LIVE): a first-mate session is bound to its mate SERVER-SIDE, independent
// of the renderer/UI (bugs 3c52cc0d + 2a5e6196). Starts a first-mate session via
// window.helm.startSession WITH a mateId but WITHOUT opening a pane - so the
// renderer's bind-on-session ("session" case, gated on the pane still being
// present) never runs. If the mate still ends up bound to the session, the
// server-side bind is doing its job (mirrors why second mates already bind
// server-side). Before the fix, no pane = no bind = session orphaned under
// Captain / dispatches mis-attributed.
//
// One cheap claude turn.
//
// Run:  node scripts/e2e/test-first-mate-bind.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[first-mate-bind-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-fmbind-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const mate0 = await app.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      const r = await window.helm.listMates();
      const m = (r.active || []).find((x) => x.slot === 0) || (r.active || [])[0];
      if (m) return m;
      await new Promise(res => setTimeout(res, 150));
    }
    return null;
  })()`);
  assert(mate0 && mate0.mateId, `found the slot-0 first mate (${mate0?.mateId})`);
  assert(!mate0.sessionId, "the mate starts with no bound session");

  // Start a first-mate session with the mateId, NO pane (direct IPC) - the
  // renderer bind path cannot run.
  const started = await app.eval(`window.helm.startSession({
    cwd: ${JSON.stringify(metaHome)},
    mateId: ${JSON.stringify(mate0.mateId)},
    prompt: "Reply with exactly: ready. Do not call any tools.",
    model: "claude-haiku-4-5-20251001",
    effort: "low"
  })`);
  assert(started && started.ok !== false, "the first-mate session started");

  // Poll listMates: the server-side bind should set mate.sessionId once the
  // session event lands (early in the turn), with no pane involved.
  let bound = null;
  for (let i = 0; i < 60 && !bound; i++) {
    await wait(3000);
    bound = await app.eval(`(async () => {
      const r = await window.helm.listMates();
      const m = (r.active || []).find((x) => x.mateId === ${JSON.stringify(mate0.mateId)});
      return m && m.sessionId ? m.sessionId : null;
    })()`);
  }
  assert(!!bound, `the mate was bound to its session SERVER-SIDE with no pane (sessionId ${bound})`);

  log(exitCode === 0 ? "VERIFY OK: a first-mate session binds to its mate server-side, independent of the UI." : "VERIFY FAILED.");
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
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
