// E2E (LIVE): first-mate -> second-mate relay delivery. A first mate's
// helm_relay_to_second_mate spawns a REAL second-mate (Opus) turn that receives
// the message and reports back UP via helm_report_up; the first mate collects it
// with helm_collect_reports. This is "orchestrate via the first mate" mode.
//
// This spends a real (small) Opus turn and can take a minute or two. The message
// is deliberately directive so the turn reliably calls helm_report_up.
//
// Run:  node scripts/e2e/test-relay-delivery.mjs
import { requireLive } from "../checks-lib/live-gate.mjs";
import { launch } from "../checks-lib/harness.mjs";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// This drives a REAL second-mate Opus turn (via helm_relay_to_second_mate) and then
// polls up to five minutes for its report-up, so it must self-skip on a default run -
// exactly like the 15 other live checks. It was the one live test missing this gate,
// so an ordinary `node scripts/run-tests.mjs` both spent tokens on it AND timed out
// waiting for the turn (300s) instead of skipping it. Gate FIRST, before any fixture
// setup / git init / launch(), so a non-live run pays nothing. NOTE: the relay reaches
// a model through the MCP dispatch server, a shape test-live-checks-declared.mjs cannot
// yet see (it strips the quoted tool name / server path), which is why that guard never
// flagged this omission - see the follow-up on widening REACHES_MODEL.
requireLive("drives a real second-mate Opus turn via helm_relay_to_second_mate and polls for its report-up");

function log(...a) {
  console.log("[relay-delivery-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-relay-"));
const metaHome = path.join(tmp, "meta-home");
const matesPath = path.join(tmp, "mates.json");
const scratchRepo = path.join(tmp, "scratch-repo");
const TOKEN = "relaytok" + Math.floor(Date.now() / 1000);

function makeMcpClient(env) {
  const serverPath = path.join(REPO_ROOT, "src", "mcp", "helmDispatchServer.js");
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {}
    }
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return {
    rpc,
    async callTool(name, args) {
      const res = await rpc("tools/call", { name, arguments: args || {} });
      const text = res?.result?.content?.[0]?.text;
      return text ? JSON.parse(text) : res?.result;
    },
    kill: () => child.kill(),
  };
}

let app;
let mate;
try {
  fs.mkdirSync(metaHome, { recursive: true });
  fs.mkdirSync(scratchRepo, { recursive: true });
  execSync("git init", { cwd: scratchRepo });
  execSync('git config user.email "e2e@test.local"', { cwd: scratchRepo });
  execSync('git config user.name "E2E"', { cwd: scratchRepo });
  fs.writeFileSync(path.join(scratchRepo, "README.md"), "# scratch\n");
  execSync("git add -A", { cwd: scratchRepo });
  execSync('git commit -m "init"', { cwd: scratchRepo });

  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = matesPath;
  process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  let ownedMateId = null;
  for (let i = 0; i < 40 && !ownedMateId; i++) {
    try {
      const state = JSON.parse(fs.readFileSync(matesPath, "utf8"));
      ownedMateId = (state.mates || []).find((m) => m.status === "active")?.mateId || (state.mates || [])[0]?.mateId || null;
    } catch {}
    if (!ownedMateId) {
      await wait(150);
    }
  }
  assert(!!ownedMateId, `found an owned first mate (${ownedMateId})`);

  mate = makeMcpClient({
    HELM_META_HOME: metaHome,
    HELM_MATE_ID: ownedMateId,
    HELM_WIDTH_CAP: "3",
    HELM_PROJECTS: JSON.stringify([{ name: "scratch", path: scratchRepo }]),
  });
  await mate.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });

  // Relay a directive message. Keep it cheap + reliable: no file work, just the
  // roll-up call back to the first mate with our correlation token.
  const relay = await mate.callTool("helm_relay_to_second_mate", {
    project: scratchRepo,
    message:
      "You are the second mate for this project. Do NOT read or change any files, and do NOT dispatch any crew. " +
      "Your ONLY action is to immediately call the helm_report_up tool with summary set to exactly \"" + TOKEN + "\". Then stop.",
  });
  log("relay ack:", JSON.stringify(relay));
  assert(relay && (relay.status === "accepted" || relay.async || relay.ok), "the relay is accepted (async)");

  // Poll for the second mate's report-up to arrive at the first mate.
  let report = null;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline && !report) {
    const col = await mate.callTool("helm_collect_reports", {});
    const hit = (col.reports || []).find((r) => (r.summary || "").includes(TOKEN) || r.fromSecondMate);
    if (hit) {
      report = hit;
      break;
    }
    await wait(5000);
  }
  assert(!!report, "the second mate's report-up reached the first mate (relay delivered end to end)");
  if (report) {
    log("report:", JSON.stringify(report).slice(0, 300));
    assert((report.summary || "").includes(TOKEN), `the report carries the relayed instruction's token (got "${report.summary}")`);
  }

  log(exitCode === 0 ? "VERIFY OK: relay drives a real second-mate turn that reports back up." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (mate) mate.kill();
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
