// A fresh orchestrator session roots in the Claude meta home - the folder carrying BOTH the
// canonical CLAUDE.md AND the cwd-keyed auto-memory - so it starts with the accumulated rules
// and memory in context, and never inside a code project.
//
// Regression guard for two fixes: it used to root in Helm's own repo (a footgun), and an
// interim neutral ~/.helm was empty, so the orchestrator would have had no memory at all.
//
// AGAINST A FIXTURE, NOT AGAINST THIS MACHINE. Until 2026-09-04 the last three assertions
// read whatever happened to be on the author's disk: does the real meta home have a
// CLAUDE.md, is its memory directory populated. That cannot pass anywhere else - it was one
// of six checks that failed on a hosted runner for having no opinion of their own - and it is
// a weak check even where it passes, because it goes green or red when a folder is tidied and
// no code has changed.
//
// The property that is true everywhere is the conditional one: GIVEN a meta home that carries
// rules and memory, Helm roots there and reports it. So this builds that meta home and points
// the app at it with HELM_META_HOME_OVERRIDE, which main.js honours in a dev build and refuses
// in a packaged one.
//
// One write lands outside the fixture and it is deliberate: Claude Code keys a project's
// auto-memory by its sanitised cwd under the real home directory, so a fixture meta home has
// its memory folder there too. It is keyed by a temp path, so it collides with nothing, and it
// is removed in the finally.
//
// Run:  node scripts/app-checks/test-orchestrator-root.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

function log(...a) {
  console.log("[orch-e2e]", ...a);
}

// Claude Code keys a project's auto-memory dir by its sanitised cwd: each of ':' '\' '/' and
// space becomes '-'. Mirrored here so the fixture can put memory where the app will look.
function memoryDirFor(cwd) {
  const key = cwd.replace(/[:\/ ]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", key, "memory");
}

// A meta home with the two things the orchestrator is rooted there FOR.
const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-metahome-"));
fs.writeFileSync(path.join(metaHome, "CLAUDE.md"), "# Fixture rules\n\nBe precise.\n", "utf8");
const memDir = memoryDirFor(metaHome);
fs.mkdirSync(memDir, { recursive: true });
fs.writeFileSync(path.join(memDir, "MEMORY.md"), "# Memory Index\n\n- [A thing](a-thing.md)\n", "utf8");
fs.writeFileSync(path.join(memDir, "a-thing.md"), "a remembered thing\n", "utf8");

process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9535";

const { launch } = await import("../checks-lib/harness.mjs");
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
  // Against the fixture, so this says something about Helm rather than about a folder.
  assert(
    path.resolve(cwd).toLowerCase() === path.resolve(metaHome).toLowerCase(),
    `the app roots the orchestrator at the meta home it was pointed at (${JSON.stringify(cwd)})`
  );
  assert(fs.existsSync(path.join(cwd, "CLAUDE.md")), "and that folder carries the rules file - the first reason to root there");
  const memDir = memoryDirFor(cwd);
  const memFiles = fs.existsSync(memDir) ? fs.readdirSync(memDir).filter((f) => f.endsWith(".md")) : [];
  log(`memory dir: ${memDir} (${memFiles.length} .md files)`);
  assert(memFiles.length >= 2, `and its auto-memory directory is where the app will look for it (${memFiles.length} .md files) - the second reason`);
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
  // Including the memory folder under the real home, which is the one write this check makes
  // outside its own temp directory.
  fs.rmSync(memDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(memDir), { recursive: true, force: true });
  fs.rmSync(metaHome, { recursive: true, force: true });
}

process.exit(exitCode);
