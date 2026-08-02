// A settings write that FAILS must come back as an answer, not as a rejected
// promise.
//
// Why this exists (found by the independent pre-release review, 2026-08-02):
// writeConfig throws when config.json can't be written - another program holding
// it, a read-only file, a full disk. Two handlers added that day called it with no
// guard, so the throw crossed the channel as a rejected promise. In the renderer
// that means `await window.helm.parkDocsProject(...)` throws INSIDE a click
// handler: the `if (!res?.ok)` branch never runs, no message appears, and the
// button stays disabled. The user sees a dead control and no explanation - which
// is the worst possible outcome for a failure that is genuinely likely on a
// Dropbox-synced folder.
//
// Two assertions, and the second is the one that lasts:
//   1. Behaviour - force a real write failure and check the reply.
//   2. CLASS - fail if any ipcMain handler calls writeConfig outside a try.
//
// Run: node scripts/e2e/test-config-write-failure.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./harness.mjs";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(here, "..", "..", "src", "main.js");

// ---- 2. THE CLASS CHECK (no app needed) ----------------------------------
// Walk every ipcMain.handle(...) body and check that a writeConfig call inside it
// is inside a try block. Crude but sufficient: these bodies are small, and the
// alternative - trusting each new handler to remember - is what failed.
const src = fs.readFileSync(mainPath, "utf8");
const unguarded = [];
{
  const re = /ipcMain\.handle\(\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) {
    // Slice the handler body by brace matching from the first "{" after the match.
    let i = src.indexOf("{", m.index + m[0].length);
    if (i < 0) {
      continue;
    }
    let depth = 0;
    let end = i;
    for (; end < src.length; end++) {
      if (src[end] === "{") {
        depth++;
      } else if (src[end] === "}") {
        depth--;
        if (depth === 0) {
          break;
        }
      }
    }
    const body = src.slice(i, end + 1);
    if (!/writeConfig\(/.test(body)) {
      continue;
    }
    // The write must be preceded by a `try {` inside this handler.
    const writeAt = body.indexOf("writeConfig(");
    const before = body.slice(0, writeAt);
    if (!/\btry\s*\{/.test(before)) {
      unguarded.push(m[1]);
    }
  }
}
ok(
  unguarded.length === 0,
  `every IPC handler that writes settings answers instead of throwing (unguarded: ${unguarded.join(", ") || "none"})`
);

// The scan above only sees `writeConfig(` written INSIDE a handler body. A handler
// that delegates in one line - `ipcMain.handle("session:archive", (...) =>
// applySessionArchive(...))` - is invisible to it, and that is exactly where the
// review found the remaining hole. So the delegating helpers are named and checked
// directly: each must catch internally and return a result.
for (const fn of ["applySessionArchive"]) {
  const start = src.indexOf(`function ${fn}(`);
  const body = start < 0 ? "" : src.slice(start, start + 900);
  ok(start >= 0, `${fn} exists`);
  ok(/try\s*\{/.test(body) && /catch/.test(body) && /ok:\s*false/.test(body), `${fn} answers with ok:false instead of throwing`);
}

// ---- 1. BEHAVIOUR --------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-cfgfail-"));
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({ dashboardWidgets: { enabled: false } }, null, 2), "utf8");
process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = "9385";

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Sanity: it works when the file is writable.
  const good = await app.eval(`window.helm.parkDocsProject("D:/Repo/Tools/loom", true)`);
  ok(good?.ok === true, `parking works normally first (${JSON.stringify(good)})`);

  // Now make the real write fail. Read-only on Windows makes the rename onto the
  // target fail, which is exactly the shape of the Dropbox-lock case.
  fs.chmodSync(configPath, 0o444);
  const bad = await app.eval(`window.helm.parkDocsProject("D:/Repo/Tools/jot", true).then(r => r, e => ({ REJECTED: String(e) }))`);
  fs.chmodSync(configPath, 0o644);

  ok(!bad?.REJECTED, `a failed settings write does NOT reject the call (${JSON.stringify(bad).slice(0, 160)})`);
  if (!bad?.REJECTED) {
    ok(bad?.ok === false, `it answers ok:false instead (${JSON.stringify(bad).slice(0, 160)})`);
    ok(typeof bad?.error === "string" && bad.error.length > 0, `with a reason the UI can show (${JSON.stringify(bad?.error)})`);
    ok(
      !/EPERM|EACCES|EBUSY/.test(bad.error) || /lock|Dropbox|allowed|folder/i.test(bad.error),
      `worded for a human, not just an error code (${JSON.stringify(bad?.error)})`
    );
  }

  // The same guarantee for the review acknowledgement, the other new writer.
  fs.chmodSync(configPath, 0o444);
  const ack = await app.eval(`window.helm.acknowledgeNoRecord("some-task").then(r => r, e => ({ REJECTED: String(e) }))`);
  fs.chmodSync(configPath, 0o644);
  ok(!ack?.REJECTED && ack?.ok === false, `acknowledging behaves the same way (${JSON.stringify(ack).slice(0, 140)})`);

  // And nothing was half-written: the file is still valid JSON with its old value.
  const after = JSON.parse(fs.readFileSync(configPath, "utf8"));
  ok(
    (after.parkedDocsProjects || []).length === 1,
    `the failed writes changed nothing - no partial state (${JSON.stringify(after.parkedDocsProjects)})`
  );

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
    fs.chmodSync(configPath, 0o644);
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
console.log(
  fails === 0
    ? "\nVERIFY OK: a settings write that fails produces a message, not a dead button."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
