import { requireLive } from "./live-gate.mjs";
requireLive("starts a real first-mate session to check its tool guards");

// E2E: the tier-discipline guards (task ad17e2e6).
//   Layer 1 (deterministic): the "hot" retire nudge trigger fires when a first
//     mate's session has run >= FIRST_MATE_HOT_TURNS turns.
//   Layer 3 (LIVE): a first mate is DENIED file mutation - a Write attempt does
//     not create the file (disallowedTools).
//   Layer 2 (LIVE): the first mate's OWN turn cost is metered into the fleet
//     budget (budget.json spentUsd > 0 after the turn).
//
// One live Sonnet turn. Sandboxed meta-home; the only file it's asked to write is
// inside that temp dir, so nothing real is touched even if the guard failed.
//
// Run:  node scripts/e2e/test-first-mate-guards.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[first-mate-guards-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-guards-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });
const pokeFile = path.join(metaHome, "poke.txt");

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Layer 1 (deterministic): the hot trigger uses the mate session's completedTurns.
  const hotTrigger = await app.eval(`(() => {
    state.sessions.push({ sessionId: "sh", cliSessionId: "ch-hot", cwd: "D:/x", completedTurns: 100, isArchived: false });
    state.sessions.push({ sessionId: "sc", cliSessionId: "ch-cold", cwd: "D:/y", completedTurns: 5, isArchived: false });
    const hotMate = { mateId: "mh", name: "Hot", sessionId: "ch-hot" };
    const coldMate = { mateId: "mc", name: "Cold", sessionId: "ch-cold" };
    const turnsHot = sessionForMate(hotMate)?.completedTurns || 0;
    const turnsCold = sessionForMate(coldMate)?.completedTurns || 0;
    return { threshold: FIRST_MATE_HOT_TURNS, hot: turnsHot >= FIRST_MATE_HOT_TURNS, cold: turnsCold >= FIRST_MATE_HOT_TURNS };
  })()`);
  assert(typeof hotTrigger.threshold === "number", `FIRST_MATE_HOT_TURNS is defined (${hotTrigger.threshold})`);
  assert(hotTrigger.hot === true, "a first mate at 100 turns trips the 'hot' hand-off nudge");
  assert(hotTrigger.cold === false, "a first mate at 5 turns does NOT trip it");

  // Layers 3 + 2 (live): ask a first mate to WRITE a file with the Write tool only.
  const prompt = `Skapa filen poke.txt i katalogen ${metaHome} med innehållet hello. Använd ENDAST Write-verktyget for detta - inte Bash eller något annat verktyg.`;
  // mateId is REQUIRED for the first-mate guards to apply, and leaving it out is what made
  // this check fail on 2026-08-12. A meta-home session is a first mate only when it is
  // actually BOUND to one - deciding by cwd alone was itself a bug (a personal chat rooted in
  // /claude lost its MCP servers and got the first-mate manual injected). So a session with no
  // mateId is correctly NOT a first mate, and asserting first-mate guards on it was asserting
  // the pre-fix model. Bind a real mate and launch as one.
  const mateId = await app.eval(`window.helm.listMates().then(r => ((r.active || [])[0] || {}).mateId || null)`);
  log("launching as first mate:", mateId);
  const started = await app.eval(`window.helm.startSession({
    cwd: ${JSON.stringify(metaHome)},
    prompt: ${JSON.stringify(prompt)},
    model: "claude-sonnet-5",
    effort: "low",
    mateId: ${JSON.stringify(mateId)}
  })`);
  log("startSession:", JSON.stringify(started));

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

  // Layer 3: the Write must have been blocked - the file must not exist.
  // NOTE THE WORDING, because the old wording claimed more than this measures. What is
  // proven here is that the Write TOOL is refused. It is NOT proven that a first mate cannot
  // create a file - it can, via Bash, and it does so unprompted: in Aidin's own Captain Hook
  // session on 2026-08-12, Write and Edit were refused three times and the mate immediately
  // wrote the SAME file with `cat > ... << EOF`, then created four more. Bash and PowerShell
  // are not in FIRST_MATE_DISALLOWED_TOOLS, so the tier guard is a speed bump, not a wall.
  // Tracked as its own task; closing it is a decision about what a coordinator may do, not a
  // one-line list edit, so it is not silently widened here.
  assert(!fs.existsSync(pokeFile), "the Write TOOL is refused for a first mate - it did not create poke.txt with Write (it could still do so via Bash; see the note above)");

  // Transcript: confirm no SUCCESSFUL Edit/Write/NotebookEdit/Task; report attempts.
  const tpath = cliSessionId ? findTranscript(cliSessionId) : null;
  if (tpath) {
    const lines = fs.readFileSync(tpath, "utf8").split(/\r?\n/).filter(Boolean);
    const attempted = {};
    let deniedSeen = false;
    for (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const msg = o.message || o;
      if (o.type === "assistant" && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === "tool_use" && ["Write", "Edit", "NotebookEdit", "Task"].includes(b.name)) {
            attempted[b.name] = (attempted[b.name] || 0) + 1;
          }
        }
      }
      if (o.type === "user" && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === "tool_result") {
            const txt = typeof b.content === "string" ? b.content : JSON.stringify(b.content || "");
            if (/denied|not allowed|permission|disallow/i.test(txt)) {
              deniedSeen = true;
            }
          }
        }
      }
    }
    log("mutation tool attempts:", JSON.stringify(attempted), "deniedResultSeen:", deniedSeen);
  } else {
    log("NOTE: could not locate transcript for tool-attempt detail (file-absence check still authoritative).");
  }

  // Layer 2: the first mate's own turn cost was metered into the fleet budget.
  const budgetFile = path.join(metaHome, ".helm-dispatch", "budget.json");
  let spent = 0;
  if (fs.existsSync(budgetFile)) {
    try {
      spent = JSON.parse(fs.readFileSync(budgetFile, "utf8")).spentUsd || 0;
    } catch {}
  }
  log("budget.json spentUsd:", spent);
  assert(spent > 0, `the first mate's own turn cost was metered into the budget (spentUsd=${spent})`);

  log(exitCode === 0 ? "VERIFY OK: hot nudge fires by turns; Write denied for a first mate; own cost metered into the budget." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (app) {
    await app.close();
  }
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_MATES_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
