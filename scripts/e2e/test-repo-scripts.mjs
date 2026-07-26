// Task 8bfae7a0: run a bound repo's package.json scripts from the pane with no
// model turn. Verifies listing, the security re-check, a real streamed run, and
// that a non-node folder offers nothing.
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-rs-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");

// A tiny throwaway repo with predictable scripts.
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(
  path.join(repo, "package.json"),
  JSON.stringify({ name: "demo-repo", scripts: { hello: "node -e \"console.log('hello from script')\"", boom: "node -e \"process.exit(3)\"" } }, null, 2),
  "utf8"
);
const bare = path.join(tmp, "bare");
fs.mkdirSync(bare, { recursive: true });

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // 1. listing
  const list = await app.eval(`window.helm.listRepoScripts(${JSON.stringify(repo)})`);
  ok(list?.ok === true && list.scripts.length === 2, `lists the repo's scripts (${JSON.stringify((list?.scripts || []).map((s) => s.name))})`);
  ok(list?.name === "demo-repo", "reports the package name");

  const none = await app.eval(`window.helm.listRepoScripts(${JSON.stringify(bare)})`);
  ok(none?.ok === false && none.scripts.length === 0, "a folder with no package.json offers nothing");

  const noCwd = await app.eval(`window.helm.listRepoScripts(null)`);
  ok(noCwd?.ok === false, "no cwd -> no scripts, no throw");

  // 2. server-side re-check: an undeclared command must be refused even if the
  //    channel is called directly.
  const refused = await app.eval(`window.helm.runRepoScript(${JSON.stringify(repo)}, "rm -rf /", "evil-1")`);
  ok(refused?.ok === false && /isn't a script/.test(refused.error || ""), `an undeclared command is refused (${refused?.error})`);

  // 3. a real run, streamed to completion
  const run = await app.eval(`(async () => {
    const runId = "test-run-1";
    const events = [];
    const stop = window.helm.onRepoScriptEvent((p) => { if (p.runId === runId) events.push(p); });
    const started = await window.helm.runRepoScript(${JSON.stringify(repo)}, "hello", runId);
    const done = await new Promise((resolve) => {
      const t = setInterval(() => {
        const d = events.find((e) => e.kind === "done");
        if (d) { clearInterval(t); resolve(d); }
      }, 100);
      setTimeout(() => { clearInterval(t); resolve(null); }, 25000);
    });
    stop();
    return { started, done, text: events.filter((e) => e.kind === "out").map((e) => e.text).join("") };
  })()`);
  ok(run?.started?.ok === true, `the run starts (${run?.started?.command})`);
  ok(run?.done?.code === 0, `it reports exit 0 (got ${JSON.stringify(run?.done)})`);
  ok(/hello from script/.test(run?.text || ""), `its stdout streamed back (${JSON.stringify((run?.text || "").trim().slice(0, 60))})`);

  // 4. a failing script surfaces its exit code rather than looking successful
  const failRun = await app.eval(`(async () => {
    const runId = "test-run-2";
    let done = null;
    const stop = window.helm.onRepoScriptEvent((p) => { if (p.runId === runId && p.kind === "done") done = p; });
    await window.helm.runRepoScript(${JSON.stringify(repo)}, "boom", runId);
    const res = await new Promise((resolve) => {
      const t = setInterval(() => { if (done) { clearInterval(t); resolve(done); } }, 100);
      setTimeout(() => { clearInterval(t); resolve(null); }, 25000);
    });
    stop();
    return res;
  })()`);
  ok(failRun && failRun.code !== 0, `a failing script reports a non-zero exit (got ${JSON.stringify(failRun)})`);

  // 5. the overlay renders and wires its controls
  const ui = await app.eval(`(() => {
    showScriptRunOverlay(${JSON.stringify(repo)}, "hello");
    const o = document.querySelector('.script-run-overlay');
    const r = {
      overlay: !!o,
      title: (o?.querySelector('.script-run-title')||{}).textContent,
      buttons: [...(o?.querySelectorAll('button')||[])].map(b=>b.textContent),
      hasOut: !!o?.querySelector('.script-run-out')
    };
    o?.remove();
    return r;
  })()`);
  ok(ui.overlay && ui.hasOut, "the run overlay renders with an output area");
  ok(ui.title === "npm run hello", `it names the command (${ui.title})`);
  ok(JSON.stringify(ui.buttons) === JSON.stringify(["Stop", "Copy output", "Close"]), `it offers Stop / Copy / Close (${JSON.stringify(ui.buttons)})`);

  const errs = app.getConsoleErrors();
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs[0].text.slice(0, 200) : ""}`);
} catch (e) {
  fails++;
  console.error("ERR", e.stack || e.message);
} finally {
  if (app) {
    await app.close();
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
console.log(fails === 0 ? "\nVERIFY OK: repo scripts list, run, stream and report exit status - with no model turn." : `\nVERIFY FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
