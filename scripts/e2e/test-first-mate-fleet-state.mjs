// E2E (real claude): a REAL first-mate session calls maestro_fleet_state through
// the permission gate and USES the cross-mate view - naming the OTHER mate's
// in-flight project (which its own maestro_collect_reports would never show).
// No Electron: the MCP server the mate spawns reads the fleet-state snapshot
// straight off disk, so we write a controlled one and point the mate at it.
// haiku + trivial prompt. Run:  node scripts/e2e/test-first-mate-fleet-state.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleFleetState } from "../../src/lib/fleetState.js";
import { writeFleetState, ensureDispatchDirs } from "../../src/lib/dispatchQueue.js";

function log(...a) {
  console.log("[first-mate-fleet-state-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const CLAUDE = "C:/Users/aidin/.local/bin/claude.exe";
const REPO = "D:/Repo/Tools/maestro";
const SERVER = path.join(REPO, "src", "mcp", "maestroDispatchServer.js");
const SERVER_NAME = "maestro-dispatch";
const ALLOWED = ["maestro_dispatch", "maestro_collect_reports", "maestro_list_projects", "maestro_fleet_state"].map((t) => `mcp__${SERVER_NAME}__${t}`);
const tmp = path.join(os.tmpdir(), "fm-fleet-" + Date.now());
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });
ensureDispatchDirs(metaHome);

// Controlled snapshot: I am mate_me; the OTHER mate (mate_other) has dispatched
// work in "reinmaker". A correct survey should surface reinmaker as NOT mine.
writeFleetState(
  metaHome,
  assembleFleetState(
    [{ mateId: "mate_me", name: "Nemo", slot: 0 }, { mateId: "mate_other", name: "Barbossa", slot: 1 }],
    [
      { dispatchedBy: "mate_me", projectPath: "D:/Repo/crewline", status: "running", updatedAt: 3 },
      { dispatchedBy: "mate_other", projectPath: "D:/Repo/reinmaker", status: "running", updatedAt: 2 },
    ],
    Date.now()
  )
);

const mcpConfig = JSON.stringify({
  mcpServers: {
    [SERVER_NAME]: {
      command: "node",
      args: [SERVER],
      env: { MAESTRO_META_HOME: metaHome, MAESTRO_MATE_ID: "mate_me", MAESTRO_PROJECTS: "[]", MAESTRO_WIDTH_CAP: "3" },
    },
  },
});

const prompt =
  "Call the maestro_fleet_state tool. Then reply with ONLY the project name that the OTHER first mate (not you) has dispatched work in, lowercase. " +
  "If you cannot call the tool, reply exactly: TOOL-BLOCKED.";
// --strict-mcp-config: use ONLY the maestro-dispatch server, not the machine's
// other MCP servers - otherwise a spawned claude here inherits ~20 of them and a
// small model drowns (verified). This isolates the test to the tool under test.
const args = ["-p", prompt, "--model", "claude-haiku-4-5-20251001", "--mcp-config", mcpConfig, "--strict-mcp-config", "--allowedTools", ...ALLOWED];

const child = spawn(CLAUDE, args, { cwd: metaHome, stdio: ["ignore", "pipe", "pipe"], env: process.env });
let out = "";
child.stdout.on("data", (c) => (out += c.toString("utf8")));
child.stderr.on("data", (c) => (out += c.toString("utf8")));
await new Promise((r) => {
  const to = setTimeout(() => { child.kill(); r(); }, 120000);
  child.on("exit", () => { clearTimeout(to); r(); });
});

const reply = out.trim();
log("mate reply (tail):", reply.slice(-160).replace(/\s+/g, " "));
assert(!/TOOL-BLOCKED/.test(reply), "the real first-mate session was NOT permission-blocked from calling maestro_fleet_state");
assert(/reinmaker/i.test(reply), "the mate surveyed the fleet and named the OTHER mate's in-flight project (reinmaker)");
assert(!/crewline/i.test(reply) || /reinmaker/i.test(reply), "it did not confuse its own project (crewline) for the other mate's");

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
log(exitCode === 0 ? "VERIFY OK: a real first mate surveys cross-mate fleet state through the permission gate." : "VERIFY FAILED.");
process.exit(exitCode);
