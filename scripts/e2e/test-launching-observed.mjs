// E2E with a REAL spawned session: is `launching` actually observable on the
// board, and does it clear on its own? (Epic f3d096fa, increment 5.)
//
// This test exists because of what its absence cost. The projection was unit
// tested and the IPC was E2E tested, both green - but nothing had ever WATCHED a
// real launch, so a renderer regression shipped in which a just-spawned session
// printed "idle" on the Fleet rows: the exact bug the epic exists to remove. A
// state you have never seen appear is a state you have not tested.
//
// Costs one real (tiny) turn against your quota, so it is not part of the fast
// suite. Run: node scripts/e2e/test-launching-observed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireLive } from "./live-gate.mjs";
requireLive("starts a real session to observe the launch");

import { launch } from "./harness.mjs";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-launching-"));
fs.writeFileSync(path.join(tmp, "README.md"), "# scratch\n", "utf8");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Start a real session and poll the board hard while its first turn runs. The
  // launching window is narrow by design (session id known -> first output), so
  // this samples fast rather than waiting.
  const observed = await app.eval(
    `(async () => {
    const samples = [];
    const started = window.helm.startSession({
      cwd: ${JSON.stringify(tmp.replace(/\\/g, "/"))},
      prompt: "Reply with exactly: ok",
      model: "claude-haiku-4-5-20251001",
      permissionMode: "default"
    });
    const deadline = Date.now() + 90000;
    let sawId = null;
    while (Date.now() < deadline) {
      const res = await window.helm.getSessions();
      const rows = res?.sessions || [];
      // The new session is the helm-owned one that wasn't there before; identify
      // it by cwd, which is what we control.
      const mine = rows.find(s => (s.cwd || "").toLowerCase().replace(/\\\\/g,"/") === ${JSON.stringify(tmp.replace(/\\/g, "/").toLowerCase())});
      if (mine) {
        sawId = mine.sessionId;
        const last = samples[samples.length - 1];
        if (!last || last.lifecycleState !== mine.lifecycleState || last.stateSource !== mine.stateSource) {
          samples.push({ at: Date.now(), lifecycleState: mine.lifecycleState, stateSource: mine.stateSource, helmOwned: mine.helmOwned, status: mine.status });
        }
        if (samples.length > 1 && (mine.lifecycleState === "waiting" || mine.lifecycleState === "wrapped")) {
          break;
        }
      }
      await new Promise(r => setTimeout(r, 250));
    }
    let result = null;
    try { result = await started; } catch (e) { result = { error: String(e) }; }
    return { samples, sawId, result: result && { ok: result.ok, error: result.error } };
  })()`
  );

  const states = observed.samples.map((s) => s.lifecycleState);
  console.log("     transitions:", states.join(" -> ") || "(none)");
  console.log("     stateSource:", observed.samples.map((s) => s.stateSource).join(" -> ") || "(none)");

  ok(!!observed.sawId, "the spawned session appeared on the board");
  ok(observed.samples.length > 0, "its state was sampled at least once");
  // The point of the whole increment: it must NEVER read as idle while Helm is
  // running its first turn.
  ok(!states.slice(0, -1).includes("idle"), `it never reads idle while the turn is running (saw ${states.join(" -> ")})`);
  ok(states.includes("launching") || states.includes("working"), "it reads launching or working while in flight");
  // And it must not get stuck: the window has to close on its own.
  ok(states[states.length - 1] !== "launching", `it leaves launching on its own (ended at ${states[states.length - 1]})`);
  const owned = observed.samples.every((s) => s.helmOwned === true);
  ok(owned, "a Helm-spawned session reads as helm-owned throughout");
  const trackedWhileFlying = observed.samples.some((s) => s.stateSource === "tracked");
  ok(trackedWhileFlying, "while in flight it reads stateSource 'tracked' - Helm's authority over its own launch is visible");

  const errs = app.getConsoleErrors();
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs[0].text.slice(0, 240) : ""}`);
} catch (e) {
  fails++;
  console.error("ERR", e.stack || e.message);
} finally {
  if (app) {
    await app.close();
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
console.log(fails === 0 ? "\nVERIFY OK: launching is observable on a real launch, never reads idle mid-turn, and closes on its own." : `\nVERIFY FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
