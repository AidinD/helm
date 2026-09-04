import { requireLive } from "../checks-lib/live-gate.mjs";
requireLive("starts a real first-mate session to check its tool gating");

// E2E (LIVE): a meta-home session is only treated as a FIRST MATE when it is
// actually bound to a mate (mateId passed, or resumed-and-bound). A personal chat
// the captain keeps in the meta-home (/claude) - no mateId - must NOT get the
// first-mate treatment: no first-mate system prompt, and (the point) the user's
// full MCP set instead of the lean strict config that strips the user's own servers.
//
// We verify via the transcript's MCP set: a first mate is launched with the
// lean helm-dispatch MCP server (helm_* tools) and --strict-mcp-config, so
// "helm-dispatch" appears in its transcript. A personal chat is NOT, so it has
// zero helm-dispatch (and therefore keeps the user's full MCP set).
// This directly checks the thing that broke, not a proxy.
//
// Two cheap claude turns.
//
// Run:  node scripts/e2e/test-first-mate-gating.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[fm-gating-e2e]", ...a);
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

// The helm-dispatch MCP server is attached ONLY to first mates; its presence in
// the transcript = "treated as a first mate (lean, user MCP stripped)".
const FM_MARKER = "helm-dispatch";

async function runTurn(app, metaHome, mateId) {
  // Snapshot the meta-home session ids that already exist, so we can pick out the
  // NEW one this turn creates (state.sessions is replaced each refresh, so a flag
  // on the object wouldn't survive).
  const before = new Set(
    await app.eval(`(state.sessions || []).filter((s) => s.cliSessionId || s.sessionId).map((s) => s.cliSessionId || s.sessionId)`)
  );
  await app.eval(`window.helm.startSession({
    cwd: ${JSON.stringify(metaHome)},
    ${mateId ? `mateId: ${JSON.stringify(mateId)},` : ""}
    prompt: "Reply with exactly the word: ready. Do not call any tools.",
    model: "claude-haiku-4-5-20251001",
    effort: "low"
  })`);
  for (let i = 0; i < 60; i++) {
    await wait(3000);
    const ids = await app.eval(`(() => {
      const norm = (p) => (p || "").replace(/[\\\\/]+$/,"").toLowerCase();
      return (state.sessions || [])
        .filter((x) => (x.cliSessionId || x.sessionId) && norm(x.cwd) === norm(${JSON.stringify(metaHome)}) && x.status !== "active")
        .map((x) => x.cliSessionId || x.sessionId);
    })()`);
    const fresh = ids.find((id) => !before.has(id));
    if (fresh) {
      return fresh;
    }
  }
  return null;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-fmgate-"));
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

  // 1) Personal chat: meta-home, NO mateId -> must NOT be a first mate.
  const personalId = await runTurn(app, metaHome, null);
  assert(!!personalId, `the no-mate meta-home session completed (${personalId})`);
  const personalTx = personalId ? findTranscript(personalId) : null;
  const personalHasFm = personalTx ? fs.readFileSync(personalTx, "utf8").includes(FM_MARKER) : true;
  assert(personalHasFm === false, "a no-mate meta-home session is NOT a first mate: no helm-dispatch MCP -> keeps the user's full MCP set");

  // 2) First mate: meta-home, WITH mateId -> IS a first mate.
  const mateId = mate0.mateId;
  const fmId = await runTurn(app, metaHome, mateId);
  assert(!!fmId, `the mate-bound meta-home session completed (${fmId})`);
  const fmTx = fmId ? findTranscript(fmId) : null;
  const fmHasFm = fmTx ? fs.readFileSync(fmTx, "utf8").includes(FM_MARKER) : false;
  assert(fmHasFm === true, "a mate-bound meta-home session IS a first mate: helm-dispatch MCP attached (lean)");

  log(exitCode === 0 ? "VERIFY OK: only mate-bound meta-home sessions get the lean first-mate MCP; personal chats keep the full user MCP." : "VERIFY FAILED.");
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
