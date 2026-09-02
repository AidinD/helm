// The escalation lever has a handle, and pulling it reaches the run.
//
// THE BUG: escalation is the only mechanism by which a goal run STOPS and asks the owner
// instead of guessing, and it was gated on a truthy `escalationConfig`. Neither the dispatch
// path nor the autopilot path passed one - and helm_dispatch's input schema had no field for
// it at all (project, goal, tier, model, effort, maxIterations, verifyCommand, taskId, and
// nothing else), so a second mate could not switch it on even deliberately. Measured on the
// installed run store 2026-09-02: 56 runs, 0 with a config, 0 that ever escalated.
//
// It is on by default now, so the field's job is the opposite one - letting a mate say NO on
// purpose, and tune a threshold when it has a reason. This drives the REAL MCP server over
// stdio and then reads the queue file the app would pick up, so it checks the contract a mate
// actually meets and the value that actually travels, not a function signature.
//
// Run:  node scripts/e2e/test-dispatch-escalation-lever.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEscalationConfig } from "../../src/lib/goalOrchestrator.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-dispatch-escalate-"));
const requestsDir = path.join(metaHome, ".helm-dispatch", "requests");

const MODEL = "claude-sonnet-5";
// One dispatch per way a mate can express itself about the pause.
const DISPATCHES = [
  ["default", { project: "p", goal: "leave escalation alone", model: MODEL }],
  ["off", { project: "p", goal: "run unattended, do not stop to ask", model: MODEL, escalate: false }],
  ["tuned", { project: "p", goal: "raise the cost cap", model: MODEL, escalationConfig: { maxCostPerIterationUsd: 7 } }],
];

const child = spawn(process.execPath, [path.join(repo, "src", "mcp", "helmDispatchServer.js")], {
  env: { ...process.env, HELM_META_HOME: metaHome, HELM_MATE_ID: "sm_test000000", HELM_CALLER_TIER: "second-mate", HELM_PROJECTS: "[]" },
  stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => {
  out += d;
});

const send = (r) => child.stdin.write(JSON.stringify(r) + "\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
DISPATCHES.forEach(([, args], i) => send({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: { name: "helm_dispatch", arguments: args } }));

// The handler writes the queue file BEFORE it waits for the app's ack, and no app is running
// here - so poll for the files rather than for replies that will not come for 15 seconds.
const deadline = Date.now() + 15000;
let files = [];
while (Date.now() < deadline) {
  files = fs.existsSync(requestsDir) ? fs.readdirSync(requestsDir).filter((f) => f.endsWith(".json")) : [];
  const listed = out.split("\n").filter(Boolean).some((l) => l.includes('"tools"'));
  if (files.length >= DISPATCHES.length && listed) {
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
child.kill();

// --- the schema a mate reads ------------------------------------------------
const list = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.id === 2);
const tool = (list?.result?.tools || []).find((t) => t.name === "helm_dispatch");
ok(!!tool, "the server offers helm_dispatch");
const props = tool?.inputSchema?.properties || {};
ok(!!props.escalate, "the schema now has a field for the pause at all - it had none, which is why nothing ever used it");
ok(props.escalate?.type === "boolean", "expressed as a plain boolean, so saying no is one word");
ok(!!props.escalationConfig, "and a second field for tuning the thresholds deliberately");
const escDesc = String(props.escalate?.description || "");
ok(/default true/i.test(escDesc), `the description states the default out loud (${escDesc.slice(0, 60)}…)`);
for (const promise of ["worktree", "resumable"]) {
  ok(escDesc.toLowerCase().includes(promise), `and says what a pause actually costs - it mentions "${promise}"`);
}
const cfgDesc = String(props.escalationConfig?.description || "");
for (const field of ["maxCostPerIterationUsd", "repeatedVerifyFailureThreshold", "noProgressStreak", "ambiguityKeywords"]) {
  ok(cfgDesc.includes(field), `the tuning field ${field} is documented rather than left to be guessed`);
  ok(!!props.escalationConfig.properties?.[field], `and declared in the schema, so the CLI can validate it`);
}

// --- the value that actually travels ---------------------------------------
const queued = new Map();
for (const f of files) {
  const req = JSON.parse(fs.readFileSync(path.join(requestsDir, f), "utf8"));
  queued.set(req.goal, req);
}
ok(queued.size === DISPATCHES.length, `all ${DISPATCHES.length} dispatch requests reached the queue (${queued.size})`);

const byLabel = new Map(DISPATCHES.map(([label, args]) => [label, queued.get(args.goal)]));
ok("escalationConfig" in (byLabel.get("default") || {}), "every request now carries the field, so the app never has to infer intent from its absence");
ok(byLabel.get("default")?.escalationConfig === null, "saying nothing queues null, which the run reads as the default");
ok(resolveEscalationConfig(byLabel.get("default")?.escalationConfig) !== null, "and that null really does enable escalation in the run");
ok(byLabel.get("off")?.escalationConfig === false, "escalate:false queues false, the app-wide off switch");
ok(resolveEscalationConfig(byLabel.get("off")?.escalationConfig) === null, "and that false really does switch it off in the run");
ok(byLabel.get("tuned")?.escalationConfig?.maxCostPerIterationUsd === 7, "a tuned threshold travels intact");
ok(resolveEscalationConfig(byLabel.get("tuned")?.escalationConfig)?.maxCostPerIterationUsd === 7, "and survives resolution in the run");

// --- the app end of the wire ------------------------------------------------
// A schema field that the watcher drops is the same lever with the same missing handle, one
// layer down. These are source checks because the alternative is booting Electron.
const mainSrc = fs.readFileSync(path.join(repo, "src", "main.js"), "utf8");
ok(
  /escalationConfig:\s*request\.escalationConfig/.test(mainSrc),
  "the dispatch watcher forwards the mate's choice into the run instead of dropping it"
);
ok(
  !/escalationConfig:\s*(escalationConfig|rec\.escalationConfig)\s*\|\|\s*undefined/.test(mainSrc),
  "and nothing coerces it with `|| undefined` any more - that would turn a deliberate false back into the default"
);
// The Goal page's config proposer drives the one checkbox a person can reach, and it
// defaulted the pause to OFF - so the single screen that could have switched escalation on
// arrived with it switched off.
ok(
  /escalate: true, rationale/.test(mainSrc),
  "the autopilot config proposer's fallback now defaults the pause ON, like the run itself"
);
ok(
  /escalate: p\.escalate !== false/.test(mainSrc),
  "and a proposer that says nothing about it gets the default rather than off"
);
const orchSrc = fs.readFileSync(path.join(repo, "src", "lib", "goalOrchestrator.js"), "utf8");
ok(
  !/const escalationEnabled = Boolean\(escalationConfig\)/.test(orchSrc),
  "the run no longer decides with Boolean(escalationConfig), which read `nobody said` as `no`"
);

fs.rmSync(metaHome, { recursive: true, force: true, maxRetries: 5 });
console.log(
  exit === 0
    ? "VERIFY OK: a second mate can see the pause in the tool schema, turn it off or tune it deliberately, and its choice survives all the way to the run."
    : "VERIFY FAILED."
);
process.exit(exit);
