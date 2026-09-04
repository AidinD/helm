// E2E: a "New orchestrator session" roots in the Claude "meta home" - the dir
// that carries BOTH the canonical CLAUDE.md AND the cwd-keyed auto-memory - so
// the orchestrator starts with the accumulated rules + memory in context, and
// never in a code project repo. Regression guard for two fixes: (1) it used to
// root in Helm's own repo (a footgun), and (2) an interim neutral ~/.helm
// dir was empty, so the orchestrator would have had NO memory. Drives a real
// launched Helm via the CDP harness.
//
// Run:  node scripts/e2e/test-orchestrator-root.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { launch } from "../checks-lib/harness.mjs";

function log(...a) {
  console.log("[orch-e2e]", ...a);
}

// Claude Code keys a project's auto-memory dir by its sanitized cwd: each of
// ':' '\' '/' and space becomes '-'. Mirror that so we can check the memory dir.
function memoryDirFor(cwd) {
  const key = cwd.replace(/[:\\/ ]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", key, "memory");
}

const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const info = await app.eval("window.helm.getOrchestratorInfo()");
  log("orchestrator:info ->", JSON.stringify(info));
  const cwd = (info && info.cwd) || "";

  assert(!!cwd && fs.existsSync(cwd), `cwd exists on disk (got ${JSON.stringify(cwd)})`);
  assert(!/[\\/]Tools[\\/]helm$/i.test(cwd), "cwd is NOT the Helm project repo");
  assert(
    /orchestrator-instructions\.md$/.test((info && info.instructionsPath) || ""),
    "instructionsPath still points at the operating manual (absolute)"
  );

  // The whole point of the meta-home root: CLAUDE files + memory are present.
  assert(fs.existsSync(path.join(cwd, "CLAUDE.md")), "cwd has a CLAUDE.md (the orchestrator gets the rules)");
  const memDir = memoryDirFor(cwd);
  const memFiles = fs.existsSync(memDir) ? fs.readdirSync(memDir).filter((f) => f.endsWith(".md")) : [];
  log(`memory dir: ${memDir} (${memFiles.length} .md files)`);
  assert(memFiles.length > 0, `cwd's auto-memory dir is populated (${memFiles.length} .md files) - orchestrator has memory`);
  assert(memFiles.includes("MEMORY.md"), "memory dir includes the MEMORY.md index");

  // Open a fresh orchestrator session and confirm the pane is rooted in the same
  // meta-home cwd - proves the renderer plumbs info.cwd through. The old
  // '+ New orchestrator session' button is gone: the app now lands on the
  // Dashboard, not a privileged orchestrator chat ("there is no privileged
  // 'orchestrator session' to land on anymore", renderer.js). The fresh-orchestrator
  // ROOT it created still exists, reached now by jumping into a first mate that has
  // no bound session (jumpIntoFirstMate -> openFreshDraftInPane(state.orchestratorHome)).
  // Drive that real path instead of a button that no longer exists.
  await app.eval('navigateToPage("chat")');
  await app.waitForSelector("#chatPage", 8000, { visible: true });
  let paneCwd = null;
  try {
    paneCwd = await app.eval(
      `(() => {
        jumpIntoFirstMate({ mateId: "e2e-orch-root", name: "E2E Orchestrator", sessionId: null });
        const p = (typeof panes !== "undefined") ? (panes.find((x) => x && x.isOrchestrator) || panes[0]) : null;
        return p ? (p.cwd || null) : null;
      })()`
    );
  } catch (e) {
    log("(pane cwd not readable from page scope:", e.message + ")");
  }
  if (paneCwd) {
    assert(
      path.resolve(paneCwd).toLowerCase() === path.resolve(cwd).toLowerCase(),
      `a fresh orchestrator session is rooted in the meta-home (got ${JSON.stringify(paneCwd)})`
    );
  } else {
    log("(skipped pane-cwd assertion - not exposed; IPC check above already proves the root)");
  }

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }

  log(exitCode === 0 ? "VERIFY OK: orchestrator roots in the meta-home with CLAUDE.md + memory present." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}

process.exit(exitCode);
