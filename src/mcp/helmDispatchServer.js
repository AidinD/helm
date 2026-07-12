// Helm dispatch MCP server (docs/first-mate-tier-design.md sections 1 + 4).
//
// A stdio MCP server that a FIRST-MATE claude session launches via the
// `--mcp-config` entry main.js appends to first-mate launches only (structural
// depth cap: a dispatched second-mate run never gets this config, so it has no
// dispatch tools - see the design's section 5). It exposes three tools:
//   - helm_dispatch       : launch one project-scoped autonomous run
//   - helm_collect_reports: pull compact reports for this mate's dispatches
//   - helm_list_projects  : the validated project enum a mate may dispatch to
//
// TRANSPORT / ARCHITECTURE: it does NOT talk to the Electron app over a socket.
// It reaches the app through the SAME on-disk request/report queue main.js
// watches (src/lib/dispatchQueue.js) - the "A1" verdict in the design: the app
// stays the single dispatch authority, there is no listening socket or port to
// babysit (the whisper-server lesson, DECISIONS.md 2026-07-05).
//
// MCP-SDK NOTE: @modelcontextprotocol/sdk is NOT a Helm dependency (checked
// package.json - only electron + @huggingface/transformers). Per the build
// brief's explicit instruction, rather than silently `npm install`-ing the SDK,
// this implements a MINIMAL stdio JSON-RPC MCP server in plain Node: it handles
// `initialize`, `tools/list`, `tools/call`, and the `notifications/initialized`
// notification - the subset the Claude Code MCP client actually drives for a
// tools-only server. If the SDK is later added, this file can be reimplemented
// on top of it without changing the on-disk queue contract or the tool schemas.
//
// CONFIG (from env, injected by main.js in the mcp-config payload):
//   HELM_META_HOME  - the first mate's root (where .helm-dispatch/ lives)
//   HELM_MATE_ID    - the dispatching mate's id (stamped on requests)
//   HELM_PROJECTS   - JSON array of { name, path } known-project entries
//   HELM_WIDTH_CAP  - max concurrent dispatched runs (default 3)

import process from "node:process";
import crypto from "node:crypto";
import {
  ensureDispatchDirs,
  writeRequest,
  writeReport,
  readAck,
  readReports,
  readFleetState,
} from "../lib/dispatchQueue.js";

const META_HOME = process.env.HELM_META_HOME || "";
const MATE_ID = process.env.HELM_MATE_ID || null;
// Which tier is dispatching: "first-mate" (dispatches second-mate/crew work) or
// "second-mate" (dispatches crew). Stamped on each request so the watcher's
// depth cap can enforce the chain first-mate -> second-mate -> crew (crew, which
// is a tool-less runGoal, can never dispatch). Defaults to first-mate for the
// original single-tier behaviour.
const CALLER_TIER = process.env.HELM_CALLER_TIER || "first-mate";
// A second mate's parent first mate, so helm_report_up can address the roll-up
// to it. Empty for a first mate (the top of the chain).
const PARENT_MATE_ID = process.env.HELM_PARENT_MATE_ID || null;
const WIDTH_CAP = Number(process.env.HELM_WIDTH_CAP) || 3;

function loadProjects() {
  try {
    const parsed = JSON.parse(process.env.HELM_PROJECTS || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "helm-dispatch", version: "0.1.0" };

const TOOLS = [
  {
    name: "helm_dispatch",
    description:
      "Dispatch ONE project-scoped autonomous Helm run (a CREW member - the autonomous work a second-mate project session owns) and return immediately with its dispatchId + goalRunId. The run executes as a normal Helm Autopilot goal in an isolated git worktree (fresh-context iterations, one commit per success, never pushes/merges). Poll helm_collect_reports later for its compact result. Bounded: at most " +
      WIDTH_CAP +
      " concurrent dispatched runs per mate; a dispatched run cannot itself dispatch (depth capped at 2). " +
      "CAVEAT for dispatching work on Helm itself: a run whose verify step restarts Helm would kill its own parent process; each iteration is git-committed so at most the in-flight iteration is lost, but avoid a restart-style verifyCommand for the Helm project until detached runs land.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Which project to dispatch to. A known project NAME (see helm_list_projects), or an explicit absolute git-repo PATH as an escape hatch.",
        },
        goal: { type: "string", description: "The goal for the dispatched run, in one clear brief." },
        tier: { type: "string", description: "Tier label for the run. Defaults to 'second-mate'." },
        model: {
          type: "string",
          description: "Model for the dispatched run. Defaults to Opus (the second-mate default) when omitted.",
        },
        effort: { type: "string", description: "Optional effort level passed to the run." },
        maxIterations: { type: "number", description: "Optional iteration cap (app clamps to 1..20)." },
        verifyCommand: {
          type: "string",
          description: "Optional independent verify gate, e.g. 'npm test'. See the Helm-self caveat above.",
        },
      },
      required: ["project", "goal"],
    },
  },
  {
    name: "helm_collect_reports",
    description:
      "Pull compact reports for this mate's dispatched runs (status, one-line summary, what changed, what needs the captain, worktree pointer). Not the transcript. Call at a bookend or when the captain asks 'what came back?'.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "Only reports finished after this ms-epoch timestamp." },
        dispatchIds: {
          type: "array",
          items: { type: "string" },
          description: "Only reports for these specific dispatch ids.",
        },
      },
    },
  },
  {
    name: "helm_list_projects",
    description:
      "List the known projects this mate may dispatch to (the validated enum for helm_dispatch's `project`). An explicit absolute repo path is also accepted as an escape hatch.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "helm_fleet_state",
    description:
      "Survey the WHOLE fleet before deciding today's focus: the active first mates and every mate's recent dispatched work (project, status, whether it awaits the captain), plus live/needs-captain rollups by project. Your helm_collect_reports only shows YOUR OWN dispatches - this shows the OTHER mate's too, so you can avoid overlap and propose COMPLEMENTARY focus (e.g. 'the other mate already has skiff + halyard in flight, so I'll take X'). Each dispatched entry is tagged `yours: true/false` relative to you.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "helm_create_second_mate",
    description:
      "FIRST MATES ONLY: propose a second mate for a project (the daily loop's 'lay out A, B, C' step). This does NOT spin up a session - it lazily registers the assignment so the second mate appears in the Fleet; its Opus session spins up only when the captain first engages it (or you relay to it). Idempotent per project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (see helm_list_projects) or absolute repo path." },
        brief: { type: "string", description: "What this second mate should own for the project (the assignment)." },
      },
      required: ["project"],
    },
  },
  {
    name: "helm_relay_to_second_mate",
    description:
      "FIRST MATES ONLY: drive a second mate WITHOUT the captain jumping in (the daily loop's 'orchestrate via the first mate' mode). Sends a message to the project's second mate; it works asynchronously (spins up if needed, dispatches its own crew, etc.) and reports back UP to you via helm_report_up - so this returns immediately, and you pick up the result with helm_collect_reports on a later turn. Use it to delegate + move on, not to converse in real time.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (see helm_list_projects) or absolute repo path." },
        message: { type: "string", description: "What you want the second mate to do." },
      },
      required: ["project", "message"],
    },
  },
  {
    name: "helm_resume_fleet",
    description:
      "FIRST MATES ONLY: resume ALL of your resumable work (runs stopped on a quota limit or paused/escalated) - your own crew AND your second mates' crew - picking up where each left off in its kept worktree. This is what the captain's 'continue'/'fortsätt' maps to after an interruption or running out of tokens. Each run resumes only if the budget/kill switch allow it. Returns how many were resumed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "helm_report_up",
    description:
      "SECOND MATES ONLY: roll up your project's outcome and report it UP to your first mate (who aggregates across projects for the captain). Call this once your assignment is done or needs to pause - after you've validated your crew's work. Give a compact synthesis, not a transcript. This is how the chain closes: first-mate <- you <- crew.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "A compact synthesis of what happened in this project (what changed, what holds)." },
        needsCaptain: { type: "string", description: "What (if anything) needs the captain's decision. Omit or empty if nothing does." },
        project: { type: "string", description: "The project this report is for (name or path); defaults to your own." },
      },
      required: ["summary"],
    },
  },
];

// --- Tool implementations ---------------------------------------------------

/** Waits for the app to write an accept/reject ack for a dispatchId. */
async function waitForAck(dispatchId, { timeoutMs = 15000, pollMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ack = readAck(META_HOME, dispatchId);
    if (ack) {
      return ack;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function toolDispatch(args) {
  if (!META_HOME) {
    return { error: "HELM_META_HOME not configured; cannot reach the dispatch queue." };
  }
  const project = (args?.project || "").trim();
  const goal = (args?.goal || "").trim();
  if (!project || !goal) {
    return { error: "Both `project` and `goal` are required." };
  }
  ensureDispatchDirs(META_HOME);
  // Model-per-tier (design decision 6): default the dispatched run to Opus (the
  // second-mate default) unless the mate overrides it. Use the full model id
  // the rest of the app uses, not the "opus" CLI alias (review finding L7).
  const request = {
    project,
    goal,
    tier: args.tier || "crew",
    model: args.model || "claude-opus-4-8",
    effort: args.effort || null,
    maxIterations: typeof args.maxIterations === "number" ? args.maxIterations : null,
    verifyCommand: args.verifyCommand || null,
    dispatchedBy: MATE_ID,
    callerTier: CALLER_TIER,
  };
  const dispatchId = writeRequest(META_HOME, request);
  const ack = await waitForAck(dispatchId);
  if (!ack) {
    return {
      dispatchId,
      status: "pending",
      note: "Request queued; the app has not acknowledged it yet. It may still start - poll helm_collect_reports.",
    };
  }
  if (ack.status === "rejected") {
    return { dispatchId, status: "rejected", reason: ack.reason || "rejected by Helm" };
  }
  return { dispatchId, goalRunId: ack.goalRunId || null, status: "started" };
}

function toolCollectReports(args) {
  if (!META_HOME) {
    return { error: "HELM_META_HOME not configured; cannot reach the report inbox." };
  }
  const reports = readReports(META_HOME, {
    since: typeof args?.since === "number" ? args.since : undefined,
    dispatchIds: Array.isArray(args?.dispatchIds) ? args.dispatchIds : undefined,
  });
  // A mate only sees its own dispatches' reports (defense in depth; the report
  // carries dispatchedBy).
  const mine = MATE_ID ? reports.filter((r) => !r.dispatchedBy || r.dispatchedBy === MATE_ID) : reports;
  return { reports: mine };
}

function toolListProjects() {
  return { projects: loadProjects().map((p) => ({ name: p.name, path: p.path })) };
}

// The cross-mate fleet view (e07a2c5d) the app snapshots to disk. Tags each
// dispatched entry `yours` relative to THIS mate so the surveying mate can tell
// its own work from the other mate's at a glance.
function toolFleetState() {
  if (!META_HOME) {
    return { error: "HELM_META_HOME not configured; cannot read the fleet state." };
  }
  const state = readFleetState(META_HOME);
  if (!state) {
    return { updatedAt: null, mates: [], dispatched: [], note: "No fleet-state snapshot yet." };
  }
  return {
    ...state,
    youAre: MATE_ID,
    dispatched: (state.dispatched || []).map((d) => ({ ...d, yours: MATE_ID ? d.mate === MATE_ID : false })),
  };
}

// Second mate -> first mate roll-up. Writes a report addressed to the parent
// first mate (dispatchedBy = PARENT_MATE_ID), so the first mate's own
// helm_collect_reports surfaces it. Tagged fromSecondMate so a retire-trace
// check (and the Dashboard) can attribute it. Synthetic dispatchId - a roll-up
// answers no single dispatch.
function toolReportUp(args) {
  if (CALLER_TIER !== "second-mate" || !PARENT_MATE_ID) {
    return { error: "helm_report_up is only for a second mate reporting to its first mate." };
  }
  if (!META_HOME) {
    return { error: "HELM_META_HOME not configured; cannot reach the report inbox." };
  }
  const summary = (args?.summary || "").trim();
  if (!summary) {
    return { error: "summary is required." };
  }
  const dispatchId = "reportup-" + crypto.randomUUID();
  writeReport(META_HOME, {
    dispatchId,
    dispatchedBy: PARENT_MATE_ID,
    fromSecondMate: MATE_ID,
    tier: "second-mate",
    kind: "report-up",
    project: args?.project || null,
    summary,
    needsCaptain: (args?.needsCaptain || "").trim() || null,
  });
  return { ok: true, reportedTo: PARENT_MATE_ID };
}

// First mate proposes a second mate (lazy - no session yet). The app handles the
// "propose-second-mate" request kind and acks with the secondMateId.
async function toolCreateSecondMate(args) {
  if (CALLER_TIER !== "first-mate") {
    return { error: "Only a first mate proposes second mates." };
  }
  if (!META_HOME) {
    return { error: "HELM_META_HOME not configured; cannot reach the dispatch queue." };
  }
  const project = (args?.project || "").trim();
  if (!project) {
    return { error: "`project` is required." };
  }
  ensureDispatchDirs(META_HOME);
  const dispatchId = writeRequest(META_HOME, {
    kind: "propose-second-mate",
    project,
    brief: (args?.brief || "").trim() || null,
    dispatchedBy: MATE_ID,
    callerTier: CALLER_TIER,
  });
  const ack = await waitForAck(dispatchId);
  if (!ack) {
    return { status: "pending", note: "Proposal queued; the app has not acknowledged it yet." };
  }
  if (ack.status === "rejected") {
    return { status: "rejected", reason: ack.reason || "rejected by Helm" };
  }
  return { ok: true, secondMateId: ack.secondMateId || null, project };
}

// First mate relays a message to a project's second mate (async - it reports
// back up). The app launches the second-mate turn fire-and-forget and acks the
// ACCEPT immediately.
async function toolRelay(args) {
  if (CALLER_TIER !== "first-mate") {
    return { error: "Only a first mate relays to a second mate." };
  }
  if (!META_HOME) {
    return { error: "HELM_META_HOME not configured; cannot reach the dispatch queue." };
  }
  const project = (args?.project || "").trim();
  const message = (args?.message || "").trim();
  if (!project || !message) {
    return { error: "Both `project` and `message` are required." };
  }
  ensureDispatchDirs(META_HOME);
  const dispatchId = writeRequest(META_HOME, {
    kind: "relay",
    project,
    message,
    dispatchedBy: MATE_ID,
    callerTier: CALLER_TIER,
  });
  const ack = await waitForAck(dispatchId);
  if (!ack) {
    return { status: "pending", note: "Relay queued; the app has not acknowledged it yet." };
  }
  if (ack.status === "rejected") {
    return { status: "rejected", reason: ack.reason || "rejected by Helm" };
  }
  return {
    ok: true,
    status: "dispatched",
    secondMateId: ack.secondMateId || null,
    note: "The second mate is working on it asynchronously and will report back up - collect it with helm_collect_reports on a later turn.",
  };
}

// First mate resumes all its resumable work (quota-stopped / escalated). The app
// cascades resumeFleet across the first mate's own crew + its second mates' crew.
async function toolResumeFleet() {
  if (CALLER_TIER !== "first-mate") {
    return { error: "Only a first mate resumes the fleet." };
  }
  if (!META_HOME) {
    return { error: "HELM_META_HOME not configured; cannot reach the dispatch queue." };
  }
  ensureDispatchDirs(META_HOME);
  const dispatchId = writeRequest(META_HOME, { kind: "resume-fleet", dispatchedBy: MATE_ID, callerTier: CALLER_TIER });
  const ack = await waitForAck(dispatchId);
  if (!ack) {
    return { status: "pending", note: "Resume queued; the app has not acknowledged it yet." };
  }
  if (ack.status === "rejected") {
    return { status: "rejected", reason: ack.reason || "rejected by Helm" };
  }
  return { ok: true, resumed: ack.resumed || 0, total: ack.total || 0 };
}

function callTool(name, args) {
  switch (name) {
    case "helm_dispatch":
      return toolDispatch(args || {});
    case "helm_create_second_mate":
      return toolCreateSecondMate(args || {});
    case "helm_relay_to_second_mate":
      return toolRelay(args || {});
    case "helm_resume_fleet":
      return toolResumeFleet();
    case "helm_collect_reports":
      return toolCollectReports(args || {});
    case "helm_list_projects":
      return toolListProjects();
    case "helm_fleet_state":
      return toolFleetState();
    case "helm_report_up":
      return toolReportUp(args || {});
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// --- Minimal stdio JSON-RPC MCP loop ---------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Wraps a tool result as an MCP tools/call content payload (JSON as text). */
function toolContent(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") {
    return;
  }
  const { id, method, params } = msg;
  // Notifications (no id) - acknowledge the ones we expect, ignore the rest.
  if (id === undefined || id === null) {
    return;
  }
  try {
    if (method === "initialize") {
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    if (method === "tools/list") {
      sendResult(id, { tools: TOOLS });
      return;
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments || {};
      const payload = await callTool(name, args);
      sendResult(id, toolContent(payload));
      return;
    }
    if (method === "ping") {
      sendResult(id, {});
      return;
    }
    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    sendError(id, -32603, `Internal error: ${err?.message || String(err)}`);
  }
}

function main() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) {
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON lines
      }
      handleMessage(msg);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

main();
