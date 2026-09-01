/**
 * The second diff view has to BE there - on a one-file change as much as a twenty-file one.
 *
 * ## Why the affordance is what is checked
 *
 * The bind flow shipped earlier on 2026-09-01 with every part working and the button that
 * reaches them missing, because it was gated on a flag nobody had taught about bindings. The
 * lesson is not "test bindings harder", it is that a feature reached through a control is
 * only as real as the control.
 *
 * So this opens the viewer on a card that really has a diff and asks what the column offers.
 * It never presses the attention button: that spends money, and what it would prove is
 * covered by test-diff-attention-live.
 *
 * A one-file diff is the case worth having: the file column used to hide itself entirely
 * below two files, on the sound reasoning that a list with one entry is not a choice. That
 * reasoning stopped holding the moment there was a second VIEW to choose.
 *
 * Everything is temporary - its own board, its own repo, its own meta-home - so it never
 * reads or writes the real ones.
 *
 * Run: node scripts/e2e/test-diff-attention-view.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeBinding } from "../../src/lib/commitBindings.js";

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-attn-view-"));
const metaHome = path.join(tmp, "meta");
const repo = path.join(tmp, "repo");
fs.mkdirSync(metaHome, { recursive: true });
fs.mkdirSync(repo, { recursive: true });

const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "p@p");
git("config", "user.name", "p");
fs.writeFileSync(path.join(repo, "summary.js"), "export const total = (rows) => rows.length;\n", "utf8");
git("add", "-A");
git("commit", "-q", "-m", "seed");
// ONE file, so the column's old `paths.length > 1` gate would have hidden everything.
fs.writeFileSync(path.join(repo, "summary.js"), "export const total = (rows) => rows.reduce((s, r) => s + r.hours, 0);\n", "utf8");
git("add", "-A");
git("commit", "-q", "-m", "fix(summary): total the hours instead of counting rows");
const sha = git("rev-parse", "HEAD").trim();

const taskId = "0f1e2d3c-0000-4000-8000-000000000000";
writeBinding(metaHome, taskId, { projectPath: repo, shas: [sha], by: "captain" });

const boardPath = path.join(tmp, "todos.json");
fs.writeFileSync(
  boardPath,
  JSON.stringify({
    categories: [{ id: "cat1", name: "Fixture Board", repoPath: repo }],
    todos: [
      {
        id: taskId,
        text: "Summeringen ska räkna timmar, inte rader",
        status: "review",
        categoryId: "cat1",
        createdAt: Date.now() - 86400000,
        description: "",
      },
    ],
  }),
  "utf8"
);

// The app must resolve THIS meta-home and THIS board, never the real ones.
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({ jot: { path: boardPath } }), "utf8");
process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9643";

const { launch } = await import("./harness.mjs");
let app = null;
try {
  app = await launch({});
  await app.waitForSelector("#pageToggle", 60000, { visible: true });
  await app.eval(`navigateToPage("review")`);

  const opened = await app.eval(`
    (async () => {
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const btn = [...document.querySelectorAll(".rev-item button")].find((b) => b.textContent === "See the diff");
        if (btn) {
          btn.click();
          for (let k = 0; k < 60; k++) {
            await new Promise((r) => setTimeout(r, 200));
            const overlay = document.getElementById("docViewer");
            if (overlay && !overlay.classList.contains("hidden")) { return { ok: true }; }
          }
          return { ok: false, why: "the viewer never opened", body: document.body.innerText.slice(-300) };
        }
      }
      return { ok: false, why: "no row ever offered a diff", body: document.body.innerText.slice(-300) };
    })()
  `);
  // This IS the regression the bind flow shipped with: the button not being there at all.
  ok(opened.ok, "a bound card offers its diff and the viewer opens", opened.ok ? "" : `${opened.why}: ${opened.body}`);

  if (opened.ok) {
    const shape = await app.eval(`
      (() => {
        const list = document.getElementById("docvFileList");
        const att = list.querySelector(".docv-filelist-attention");
        return {
          columnHidden: list.classList.contains("hidden"),
          labels: [...list.querySelectorAll(".docv-filelist-item")].map((b) => b.textContent),
          attentionPresent: !!att,
          attentionDisabled: att ? att.disabled : null,
          fileBlocks: document.querySelectorAll(".diff-file-block").length,
          diffCells: document.querySelectorAll(".diff-cell").length,
        };
      })()
    `);
    ok(!shape.columnHidden, "the column is shown even though the change touches ONE file", JSON.stringify(shape.labels));
    ok(shape.attentionPresent, "and it offers the second view");
    ok(shape.attentionDisabled === false, "which is clickable rather than a decoration");
    // The way back. A view you cannot leave is a trap.
    ok(shape.labels.some((l) => /whole diff|all files/i.test(l)), "and a way back to the whole diff", JSON.stringify(shape.labels));
    // The diff itself really rendered, so the column is attached to something.
    ok(shape.diffCells > 0, "with the diff actually rendered behind it", `${shape.diffCells} cells`);
  }
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: a bound card opens its diff, and the second view is offered there - single file and all.");
