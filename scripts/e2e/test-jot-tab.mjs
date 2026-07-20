// E2E (LIVE): the embedded Jot tab (one Jot, two mounts). Launches Helm, points
// the embedded Jot at a temp board (JOT_DATA_DIR) seeded with a known todo,
// navigates to the Jot tab, and verifies end-to-end that (1) Helm creates the
// webview (mount + paths succeeded, no error), and (2) the webview actually loaded
// Jot's BUILT renderer and rendered the seeded todo - i.e. window.jot resolved
// through the @jot/core-backed IPC bridge. Requires jot's renderer built
// (out/renderer); the test builds it if missing.
//
// Run:  node scripts/e2e/test-jot-tab.mjs
import { launch } from "./harness.mjs";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[jot-tab-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Ensure jot's built renderer exists (the webview loads it).
const jotRepo = path.resolve(process.cwd(), "..", "jot");
if (!fs.existsSync(path.join(jotRepo, "out", "renderer", "index.html"))) {
  log("building jot renderer...");
  execSync("npm run build", { cwd: jotRepo, stdio: "ignore" });
}

const SEED = "JOT-TAB-E2E-TODO";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-jottab-"));
const jotData = path.join(tmp, "jotdata");
fs.mkdirSync(jotData, { recursive: true });
fs.writeFileSync(
  path.join(jotData, "todos.json"),
  JSON.stringify({ todos: [{ id: "seed", text: SEED, status: "open", description: "", images: [], categoryId: null, tags: [], priority: 0, deadline: null, parentId: null, createdAt: 1, completedAt: null }], categories: [], tags: [] })
);

async function cdp(ws, method, params, id) {
  return new Promise((resolve, reject) => {
    const onMsg = (event) => {
      const m = JSON.parse(event.data);
      if (m.id === id) {
        ws.removeEventListener("message", onMsg);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
  fs.mkdirSync(process.env.HELM_META_HOME_OVERRIDE, { recursive: true });
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  process.env.JOT_DATA_DIR = jotData; // embedded Jot -> the seeded board
  app = await launch({ port: 9355 });
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Navigate to the Jot tab and let the webview mount + load.
  const created = await app.eval(`(async () => {
    navigateToPage("jot");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const page = document.getElementById("jotPage");
      const wv = page && page.querySelector("webview");
      const err = page && page.querySelector(".pane-empty");
      if (wv) return { ok: true, src: wv.getAttribute("src") };
      if (err) return { ok: false, error: err.textContent };
    }
    return { ok: false, error: "no webview after 20s" };
  })()`);
  assert(created.ok, `Helm created the Jot webview (mount+paths ok)${created.ok ? "" : ": " + created.error}`);
  assert(created.ok && /index\.html/.test(created.src || ""), `webview points at Jot's built renderer (${created.src ? "..." + created.src.slice(-40) : "-"})`);

  // Reach the webview's own target over CDP and confirm it rendered the board + seed.
  await wait(2500);
  let webviewOk = false;
  let seedSeen = false;
  try {
    const targets = await (await fetch("http://127.0.0.1:9355/json")).json();
    const t = targets.find((x) => /index\.html/.test(x.url) && /jot/i.test(x.url) && x.type !== "background_page");
    if (t) {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
      await cdp(ws, "Runtime.enable", {}, 1);
      let id = 2;
      // Poll: the board fetches state via window.jot (IPC round-trip) then renders,
      // so the seed can land a beat after #root first has content.
      for (let i = 0; i < 16; i++) {
        const rc = await cdp(ws, "Runtime.evaluate", { expression: `document.querySelector('#root')?.childElementCount ?? 0`, returnByValue: true }, id++);
        const body = await cdp(ws, "Runtime.evaluate", { expression: `document.body.innerText || ''`, returnByValue: true }, id++);
        webviewOk = webviewOk || (rc.result.value || 0) > 0;
        if ((body.result.value || "").includes(SEED)) { seedSeen = true; break; }
        await wait(500);
      }
      ws.close();
    }
  } catch (err) {
    log("webview CDP check skipped/failed:", err.message);
  }
  assert(webviewOk, "the webview mounted Jot's board (React #root has content)");
  assert(seedSeen, `the embedded board shows the seeded todo via the @jot/core bridge ("${SEED}")`);

  log(exitCode === 0 ? "VERIFY OK: the Jot tab embeds Jot's renderer in Helm, backed by @jot/core - one Jot, two mounts, live." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_MATES_PATH;
  delete process.env.JOT_DATA_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
process.exit(exitCode);
