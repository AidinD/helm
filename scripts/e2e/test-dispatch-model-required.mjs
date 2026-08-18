// A crew model must be CHOSEN, not inherited.
//
// THE BUG: helm_dispatch fell back to `args.model || "claude-opus-4-8"` whenever a mate
// omitted the field, and mates always omitted it, because nothing in the tool schema or
// the second-mate instructions ever said to choose. Measured on the crewline board
// 2026-08-18: 22 of 22 dispatched runs on Opus 4.8 - including one whose entire goal was
// "run exactly one command and report its output, do NOT modify any files", at $1.32.
//
// A silent default is not a decision, and nobody could see it was being made. This drives
// the REAL MCP server over stdio, so it tests the contract a mate actually meets rather
// than a function signature.
//
// Run:  node scripts/e2e/test-dispatch-model-required.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-dispatch-model-"));

function talk(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo, "src", "mcp", "helmDispatchServer.js")], {
      env: { ...process.env, HELM_META_HOME: metaHome, HELM_MATE_ID: "sm_test000000", HELM_CALLER_TIER: "second-mate", HELM_PROJECTS: "[]" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the MCP server did not answer in time"));
    }, 20000);
    child.stdout.on("data", (d) => {
      out += d;
      // Every request answered? (notifications carry no id and get no reply.)
      const replies = out.split("\n").filter(Boolean);
      if (replies.length >= requests.filter((r) => r.id !== undefined).length) {
        clearTimeout(timer);
        child.kill();
        resolve(replies.map((l) => JSON.parse(l)));
      }
    });
    child.on("error", reject);
    for (const r of requests) {
      child.stdin.write(JSON.stringify(r) + "\n");
    }
  });
}

const replies = await talk([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "helm_dispatch", arguments: { project: "p", goal: "run one command" } } },
]);

const list = replies.find((r) => r.id === 2);
const dispatchTool = (list?.result?.tools || []).find((t) => t.name === "helm_dispatch");
ok(!!dispatchTool, "the server offers helm_dispatch");
ok(
  (dispatchTool?.inputSchema?.required || []).includes("model"),
  `model is declared REQUIRED in the schema, so the CLI itself refuses an omission (required: ${JSON.stringify(dispatchTool?.inputSchema?.required)})`
);

const desc = String(dispatchTool?.inputSchema?.properties?.model?.description || "");
for (const m of ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4-8"]) {
  ok(desc.includes(m), `the description names ${m} with the kind of job it fits - a required field with no guidance is just a coin flip`);
}
ok(!/defaults? to opus/i.test(desc), "and it no longer advertises an Opus default");

// The schema is the first gate, but a hand-built request can still reach the handler, so
// the handler refuses too. Belt and braces, because this is the exact spot where a silent
// fallback lived.
const called = replies.find((r) => r.id === 3);
const payload = JSON.parse(called?.result?.content?.[0]?.text || "{}");
ok(!!payload.error, `dispatching with no model is refused by the handler as well (got: ${String(payload.error || payload.status).slice(0, 60)}…)`);
ok(!payload.dispatchId, "and no run is created - rejecting costs nothing, which is why rejecting is safe here");
for (const m of ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4-8"]) {
  ok(String(payload.error).includes(m), `the refusal names ${m}, so the mate can retry immediately instead of guessing`);
}

// A refusal must not leave the queue half-built.
ok(!fs.existsSync(path.join(metaHome, ".helm-dispatch", "requests")), "a refused dispatch writes nothing to the queue");

// The source must not still carry the fallback anywhere.
const src = fs.readFileSync(path.join(repo, "src", "mcp", "helmDispatchServer.js"), "utf8");
ok(!/args\.model\s*\|\|\s*["']claude-/.test(src), "the `args.model || <some model>` fallback is gone from the source, not just unreachable");

fs.rmSync(metaHome, { recursive: true, force: true });
console.log(exit === 0 ? "VERIFY OK: a crew model is a stated choice, and an omission is refused before any run starts." : "VERIFY FAILED.");
process.exit(exit);
