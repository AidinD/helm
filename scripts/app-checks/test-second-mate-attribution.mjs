import { requireLive } from "../checks-lib/live-gate.mjs";
requireLive("drives a real second mate so its work can be attributed");

// E2E (LIVE): reproduce 2a5e6196 - when the SECOND first mate creates a second
// mate, is it attributed to THAT mate or mis-stamped onto the slot-0 mate?
// Starts a session with the slot-1 mate's mateId (as jumping into the second first
// mate does), asks it to call helm_create_second_mate, and checks the resulting
// proposal's firstMateId. firstMateId === slot-1 = correct; === slot-0 = the bug.
//
// One live Sonnet turn. Sandboxed (temp meta-home + seams + a throwaway git repo).
//
// Run:  node scripts/e2e/test-second-mate-attribution.mjs
import { launch } from "../checks-lib/harness.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[sm-attribution-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-smattr-"));
const metaHome = path.join(tmp, "meta-home");
const smPath = path.join(tmp, "second-mates.json");
const fakeProj = path.join(tmp, "fake-proj");
fs.mkdirSync(metaHome, { recursive: true });
fs.mkdirSync(fakeProj, { recursive: true });
fs.writeFileSync(path.join(fakeProj, "README.md"), "# fake-proj\n", "utf8");
try {
  execFileSync("git", ["init", "-q"], { cwd: fakeProj });
  execFileSync("git", ["add", "-A"], { cwd: fakeProj });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: fakeProj });
} catch (e) {
  log("WARN git init:", e.message);
}

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  process.env.HELM_SECOND_MATES_PATH = smPath;
  process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "history.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const mates = await app.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      const r = await window.helm.listMates();
      if ((r.active || []).length >= 2) return r.active.map((m) => ({ mateId: m.mateId, slot: m.slot, name: m.name }));
      await new Promise(res => setTimeout(res, 150));
    }
    const r = await window.helm.listMates();
    return (r.active || []).map((m) => ({ mateId: m.mateId, slot: m.slot, name: m.name }));
  })()`);
  const slot0 = mates.find((m) => m.slot === 0);
  const slot1 = mates.find((m) => m.slot === 1);
  assert(slot0 && slot1, `two first mates exist (slot0=${slot0?.name}, slot1=${slot1?.name})`);

  // Prompt the SECOND mate (slot 1) to create a second mate - the exact scenario.
  const prompt = `Call the helm_create_second_mate tool with project set to the absolute path ${fakeProj}. Call ONLY that one tool, then reply with the single word done.`;
  const started = await app.eval(`window.helm.startSession({
    cwd: ${JSON.stringify(metaHome)},
    mateId: ${JSON.stringify(slot1.mateId)},
    prompt: ${JSON.stringify(prompt)},
    model: "claude-sonnet-5",
    effort: "low"
  })`);
  assert(started && started.ok !== false, "the slot-1 first-mate session started");

  // Poll the sandbox bindings for the new proposal.
  let proposal = null;
  for (let i = 0; i < 60 && !proposal; i++) {
    await wait(3000);
    try {
      const b = JSON.parse(fs.readFileSync(smPath, "utf8"));
      proposal = Object.values(b).find((x) => x && x.projectPath && x.projectPath.toLowerCase().includes("fake-proj")) || null;
    } catch {}
  }
  assert(!!proposal, `a second-mate proposal was created (${proposal ? "found" : "NOT found"})`);
  if (proposal) {
    log(`proposal.firstMateId = ${proposal.firstMateId}  |  slot1(Davy) = ${slot1.mateId}  |  slot0 = ${slot0.mateId}`);
    assert(proposal.firstMateId === slot1.mateId, "the proposal is attributed to the SECOND mate (slot 1) that created it, NOT slot 0");
    if (proposal.firstMateId === slot0.mateId) {
      log(">>> BUG REPRODUCED: attributed to slot-0 mate instead of the creating slot-1 mate.");
    }
  }

  log(exitCode === 0 ? "VERIFY OK: second mate attributed to its creating first mate." : "VERIFY FAILED (see above).");
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
  delete process.env.HELM_GOAL_RUN_HISTORY_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
