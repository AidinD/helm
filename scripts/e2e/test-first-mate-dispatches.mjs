// KNOWN-SOFT (2026-08-12): the structural half of this check is now sound - with a bound
// mateId the session really is a first mate, and the tool sequence shows it (ToolSearch ->
// helm_list_projects instead of the old Bash -> Write). What is left is a MODEL-BEHAVIOUR
// expectation: that one Sonnet turn both orients AND completes a dispatch. It orients
// reliably; completing in a single turn it does not. Treat a red run here as "the mate did
// not finish in one turn", not as a broken guard - the guard is covered deterministically by
// test-first-mate-guards (Write denied) and test-first-mate-gating.
import { requireLive } from "./live-gate.mjs";
requireLive("drives a real first mate through a dispatch");

// SMOKE (LIVE, stochastic - ONE real Sonnet engagement): does a first mate, given
// a single-project "I want to work on X" request, now reach for
// helm_create_second_mate (the playbook fix, commit 0e1667a) instead of doing the
// work itself (Bash into the repo + Edit)? This is the exact failure from p0
// tasks 43982d2e / 508c03fc.
//
// SAFE: the named project is a THROWAWAY git repo in a temp dir, so even if the
// fix regressed and the mate tried to implement inline, it edits the throwaway,
// never a real repo. Sandboxed meta-home too (no real Fleet side effect).
//
// One stochastic turn - a single PASS is signal, not proof. Reports the actual
// tool sequence either way.
//
// Run:  node scripts/e2e/test-first-mate-dispatches.mjs
import { launch } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[first-mate-dispatch-smoke]", ...a);
}
let exitCode = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-fmdispatch-"));
const metaHome = path.join(tmp, "meta-home");
const fakeProj = path.join(tmp, "fake-proj");
fs.mkdirSync(metaHome, { recursive: true });
fs.mkdirSync(fakeProj, { recursive: true });
fs.writeFileSync(path.join(fakeProj, "README.md"), "# fake-proj\n\nA throwaway project for a Helm smoke test.\n", "utf8");
// A real git repo so create_second_mate's absolute-path resolver accepts it.
try {
  execFileSync("git", ["init", "-q"], { cwd: fakeProj });
  execFileSync("git", ["add", "-A"], { cwd: fakeProj });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: fakeProj });
} catch (e) {
  log("WARN: git init failed, continuing anyway:", e.message);
}

// Find a transcript file by its cli session id anywhere under ~/.claude/projects.
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

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  // Sandbox the bindings + run-history too: helm_create_second_mate writes a
  // binding, and without these seams it lands in the REAL repo second-mates.json
  // (a stale "fake-proj" proposal pointing at a deleted temp dir - exactly the
  // lingering-proposal class this app has bugs about). Keep the test hermetic.
  process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
  process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "goal-run-history.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const prompt = `Jag vill jobba med projektet fake-proj (${fakeProj}). Jag vill lagga till en enkel hello-funktion i repot.`;
  // mateId is REQUIRED, and leaving it out is why this failed on 2026-08-12 with the tool
  // sequence Bash -> Read -> Write -> Bash. Without it the session is not a first mate at all:
  // it gets no helm_* dispatch tools (so it CANNOT relay) and no tier guard (so Write is not
  // denied) - so it did the work itself, which the check then reported as the old
  // absorb-the-work behaviour. It was reading a session that was never a first mate. Deciding
  // first-mate-ness by cwd alone was itself a bug, so the binding is the point.
  const mateId = await app.eval(`window.helm.listMates().then(r => ((r.active || [])[0] || {}).mateId || null)`);
  log("launching as first mate:", mateId);
  const started = await app.eval(`window.helm.startSession({
    cwd: ${JSON.stringify(metaHome)},
    prompt: ${JSON.stringify(prompt)},
    model: "claude-sonnet-5",
    effort: "medium",
    mateId: ${JSON.stringify(mateId)}
  })`);
  log("startSession:", JSON.stringify(started));

  // Wait for the single engagement to settle (turn finished / waiting on input).
  let cliSessionId = null;
  for (let i = 0; i < 60 && !cliSessionId; i++) {
    await wait(3000);
    cliSessionId = await app.eval(`(() => {
      const norm = (p) => (p || "").replace(/[\\\\/]+$/,"").toLowerCase();
      const s = (state.sessions || []).find((x) => (x.cliSessionId || x.sessionId) && norm(x.cwd) === norm(${JSON.stringify(metaHome)}) && x.status !== "active");
      return s ? (s.cliSessionId || s.sessionId) : null;
    })()`);
  }
  log("settled cliSessionId:", cliSessionId);

  await app.close();
  app = null;

  const tpath = cliSessionId ? findTranscript(cliSessionId) : null;
  if (!tpath) {
    log("FAIL - could not locate the session transcript to inspect tool calls.");
    exitCode = 1;
  } else {
    const lines = fs.readFileSync(tpath, "utf8").split(/\r?\n/).filter(Boolean);
    const toolSeq = [];
    const counts = {};
    for (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const msg = o.message || o;
      if (o.type === "assistant" && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === "tool_use") {
            toolSeq.push(b.name);
            counts[b.name] = (counts[b.name] || 0) + 1;
          }
        }
      }
    }
    log("tool sequence:", toolSeq.join(" -> ") || "(none)");
    const createdSecondMate = !!counts["mcp__helm-dispatch__helm_create_second_mate"];
    const relayed = !!counts["mcp__helm-dispatch__helm_relay_to_second_mate"];
    const edits = (counts["Edit"] || 0) + (counts["Write"] || 0);
    log(`create_second_mate=${counts["mcp__helm-dispatch__helm_create_second_mate"] || 0} relay=${counts["mcp__helm-dispatch__helm_relay_to_second_mate"] || 0} Edit/Write=${edits}`);

    if (createdSecondMate || relayed) {
      log("PASS (single run) - the first mate dispatched via a second mate instead of doing the work itself.");
    } else {
      exitCode = 1;
      log("FAIL (single run) - the first mate did NOT create/relay to a second mate. Inspect the tool sequence above; if it Edited/Bashed the repo, that's the old absorb-the-work behavior.");
    }
    if (edits > 0) {
      log(`NOTE: ${edits} Edit/Write call(s) in a first-mate session - it should never edit project files.`);
    }
  }
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (app) {
    await app.close();
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
