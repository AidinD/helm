// E2E (real claude): a REAL first-mate session calls helm_fleet_state through
// the permission gate and USES the cross-mate view - naming the OTHER mate's
// in-flight project (which its own helm_collect_reports would never show).
// No Electron: the MCP server the mate spawns reads the fleet-state snapshot
// straight off disk, so we write a controlled one and point the mate at it.
// Uses claude-sonnet-5 - the model real first mates actually run on. haiku was
// too weak for the deferred-MCP-tool ToolSearch->call dance in this setup (it
// found the tool reference but gave up with TOOL-BLOCKED); Sonnet does it
// cleanly (ToolSearch loads the schema, then it calls the tool). This is a
// correctness test of the real first-mate capability, so it uses the real
// first-mate model, not the cheapest one. Run:  node scripts/e2e/test-first-mate-fleet-state.mjs
//
// WHY A PERSISTENT stream-json SESSION, NOT A ONE-SHOT `-p`:
// A bare `claude -p "<prompt>"` snapshots its tool list at init, and a stdio
// MCP server passed via --mcp-config is still `status:"pending"` at that
// instant (it hasn't finished its stdio handshake). The tool then never enters
// the callable set for that single turn, so a small model can't invoke it and
// reports TOOL-BLOCKED - a pure init RACE, not a product bug. The real app
// never hits this: it launches first mates INTERACTIVELY, so the server
// connects while the session sits idle before the captain's first prompt.
// We reproduce THAT ordering faithfully with a long-lived
// `--input-format stream-json` process: a cheap warmup turn boots the session
// and lets the server connect (each turn re-emits a `system` init carrying the
// live mcp_servers status), we WAIT until helm-dispatch reports
// `status:"connected"`, and only THEN issue the tool-requiring prompt - just
// like a captain typing after the mate has settled. Robust to connect latency
// by gating on the observed status, not on a fixed sleep.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLAUDE = "C:/Users/aidin/.local/bin/claude.exe";
const REPO = "D:/Repo/Tools/helm";
const SERVER = path.join(REPO, "src", "mcp", "helmDispatchServer.js");
const SERVER_NAME = "helm-dispatch";
const ALLOWED = ["helm_dispatch", "helm_collect_reports", "helm_list_projects", "helm_fleet_state"].map((t) => `mcp__${SERVER_NAME}__${t}`);
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
      env: { HELM_META_HOME: metaHome, HELM_MATE_ID: "mate_me", HELM_PROJECTS: "[]", HELM_WIDTH_CAP: "3" },
    },
  },
});

// --strict-mcp-config: use ONLY the helm-dispatch server, not the machine's
// other MCP servers - otherwise a spawned claude here inherits ~20 of them and a
// small model drowns (verified). This isolates the test to the tool under test.
// --input-format stream-json (no positional prompt): a persistent, multi-turn
// session driven by user messages on stdin (see the header note) instead of a
// racy one-shot -p.
const args = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--model", "claude-sonnet-5",
  "--mcp-config", mcpConfig,
  "--strict-mcp-config",
  "--allowedTools", ...ALLOWED,
];

const child = spawn(CLAUDE, args, { cwd: metaHome, stdio: ["pipe", "pipe", "pipe"], env: process.env });

const FLEET_TOOL = `mcp__${SERVER_NAME}__helm_fleet_state`;

// Event plumbing: parse the stream-json line protocol, track the newest MCP
// connection status AND whether the fleet-state tool is in the turn's DIRECT
// tool list (the per-turn `system` init event carries both `mcp_servers` and
// `tools`), collect assistant text, and count completed turns (each `result`
// event = one turn). `toolDirect` is the authoritative "the init race is over,
// the tool is callable this turn" signal - stronger than mcp status alone,
// since a freshly-connected server's tools are directly listed only from the
// NEXT turn's snapshot onward.
const events = [];
let buffer = "";
let resultCount = 0;
let mcpStatus = null; // latest observed status for helm-dispatch
let toolDirect = false; // latest observed: FLEET_TOOL in the init tool list
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) {
      continue;
    }
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(evt);
    if (Array.isArray(evt.mcp_servers)) {
      const s = evt.mcp_servers.find((m) => m.name === SERVER_NAME);
      if (s && s.status) {
        mcpStatus = s.status;
      }
    }
    if (evt.type === "system" && evt.subtype === "init" && Array.isArray(evt.tools)) {
      toolDirect = evt.tools.includes(FLEET_TOOL);
    }
    if (evt.type === "result") {
      resultCount += 1;
    }
  }
});
let stderrText = "";
child.stderr.on("data", (c) => (stderrText += c.toString("utf8")));

function sendUser(text) {
  child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
}

async function waitForTurn(prevCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (resultCount > prevCount) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

// Assistant text produced strictly AFTER a given event-log length, so the real
// prompt's reply is not conflated with the warmup "READY".
function assistantTextAfter(startIdx) {
  return events
    .slice(startIdx)
    .filter((e) => e.type === "assistant")
    .flatMap((e) => (e.message?.content || []).filter((b) => b.type === "text").map((b) => b.text))
    .join(" ");
}

try {
  // Boot + settle the session with cheap warmup turns until the fleet-state
  // tool is in the DIRECT tool list (the real app's idle-before-first-prompt
  // window, where the stdio server finishes its handshake). Gating on
  // toolDirect - not just mcpStatus - guarantees the init race is fully over:
  // the tool is genuinely callable on the next turn.
  for (let attempt = 0; attempt < 5 && !toolDirect; attempt++) {
    const prev = resultCount;
    sendUser("Reply with exactly: READY");
    const ok = await waitForTurn(prev, 60000);
    if (!ok) {
      break;
    }
    log(`warmup turn ${attempt + 1}: helm-dispatch status = ${mcpStatus || "(unseen)"}, fleet tool direct = ${toolDirect}`);
  }
  assert(toolDirect, "the helm_fleet_state tool became directly callable before the real prompt (no init race)");

  // The real prompt, issued exactly as a captain would after the mate settled.
  // Nudged to call the tool itself rather than hand it to a sub-agent (that
  // detour can drop the answer), but NOT forbidden from using ToolSearch - a
  // small model sometimes needs it to reach even a directly-listed tool, and
  // forbidding it just makes haiku give up and (mis)report TOOL-BLOCKED.
  const prompt =
    "Call the helm_fleet_state tool yourself to survey the fleet (do not delegate it to a sub-agent). " +
    "Then reply with ONLY the project name that the OTHER first mate (not you) has dispatched work in, lowercase. " +
    "If you truly cannot call the tool, reply exactly: TOOL-BLOCKED.";

  // Bounded re-ask WITHIN the same already-connected session. This cannot mask
  // the two failure modes the test guards against:
  //   - the init race: proven resolved by the toolDirect gate above.
  //   - a real permission regression: DETERMINISTIC - if the tool were not
  //     allow-listed, every attempt would fail to execute it and the test
  //     still fails. Only STOCHASTIC small-model confusion (an occasional
  //     detour or a spurious self-reported TOOL-BLOCKED) is retried away, so a
  //     genuine gate block cannot be rescued by retrying.
  let reply = "";
  for (let attempt = 0; attempt < 4 && !/reinmaker/i.test(reply); attempt++) {
    const beforeIdx = events.length;
    const beforeCount = resultCount;
    sendUser(prompt);
    const finished = await waitForTurn(beforeCount, 120000);
    if (!finished) {
      log(`real-ask attempt ${attempt + 1}: turn did not complete in time`);
      continue;
    }
    reply = assistantTextAfter(beforeIdx).trim();
    log(`real-ask attempt ${attempt + 1} reply (tail):`, reply.slice(-160).replace(/\s+/g, " "));
  }

  assert(!/TOOL-BLOCKED/i.test(reply) && /reinmaker/i.test(reply), "the real first-mate session called helm_fleet_state through the permission gate and named the OTHER mate's in-flight project (reinmaker)");
  assert(!/crewline/i.test(reply) || /reinmaker/i.test(reply), "it did not confuse its own project (crewline) for the other mate's");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  try { child.stdin.end(); } catch {}
  try { child.kill(); } catch {}
  if (stderrText.trim() && exitCode !== 0) {
    log("stderr (tail):", stderrText.trim().slice(-300).replace(/\s+/g, " "));
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

log(exitCode === 0 ? "VERIFY OK: a real first mate surveys cross-mate fleet state through the permission gate." : "VERIFY FAILED.");
process.exit(exitCode);
