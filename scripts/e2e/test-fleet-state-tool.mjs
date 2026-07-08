// Integration test: the helm_fleet_state MCP tool serves the app's fleet-state
// snapshot with `yours` tagged relative to the calling mate. Drives the real MCP
// server over stdio JSON-RPC (as the claude client would); no Electron / no
// real claude needed - the app's write side is exercised via the shared libs.
//
// Run:  node scripts/e2e/test-fleet-state-tool.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleFleetState } from "../../src/lib/fleetState.js";
import { writeFleetState, ensureDispatchDirs } from "../../src/lib/dispatchQueue.js";

function log(...a) {
  console.log("[fleet-state-tool-test]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SERVER = path.join(process.cwd(), "src", "mcp", "helmDispatchServer.js");
const tmp = path.join(os.tmpdir(), "fleet-state-tool-" + Date.now());
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });
ensureDispatchDirs(metaHome);
writeFleetState(
  metaHome,
  assembleFleetState(
    [{ mateId: "mate_A", name: "Nemo", slot: 0 }, { mateId: "mate_B", name: "Barbossa", slot: 1 }],
    [
      { dispatchedBy: "mate_A", projectPath: "D:/Repo/crewline", status: "running", updatedAt: 3 },
      { dispatchedBy: "mate_B", projectPath: "D:/Repo/reinmaker", status: "done", commitCount: 2, updatedAt: 2 },
    ],
    111
  )
);

const srv = spawn("node", [SERVER], {
  env: { ...process.env, HELM_META_HOME: metaHome, HELM_MATE_ID: "mate_A", HELM_PROJECTS: "[]" },
  stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
srv.stdout.on("data", (c) => (out += c.toString("utf8")));
const send = (o) => srv.stdin.write(JSON.stringify(o) + "\n");

try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await wait(300);
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  await wait(150);
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "helm_fleet_state", arguments: {} } });
  await wait(700);

  const resp = out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
  assert(!!resp, "the tool returned a JSON-RPC response");
  const payload = JSON.parse(resp.result.content[0].text);
  assert(payload.youAre === "mate_A", "the response tells the mate which id it is");
  assert(payload.mates.length === 2, "both active mates are listed (the OTHER mate is visible)");
  const crew = payload.dispatched.find((d) => d.project === "crewline");
  const rein = payload.dispatched.find((d) => d.project === "reinmaker");
  assert(crew && crew.yours === true, "this mate's own dispatched run is tagged yours:true");
  assert(rein && rein.yours === false, "the OTHER mate's dispatched run is visible + tagged yours:false");
  assert(rein.needsCaptain === true && rein.commits === 2, "the other mate's done-with-commits run carries its status for overlap-avoidance");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message, "| out tail:", out.slice(-200));
} finally {
  srv.kill();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
log(exitCode === 0 ? "VERIFY OK: helm_fleet_state serves the cross-mate view with yours-tagging." : "VERIFY FAILED.");
process.exit(exitCode);
