// The review diff viewer, side by side (task c3dfbb42, Aidin: "Kan vi få en
// side by side diff istället som i vanliga git klienter"). Drives the REAL
// parser + renderer (parseUnifiedDiffFiles / renderDiffFiles) with a
// realistic multi-file unified diff and checks what a person would see: two
// aligned columns, old/new line numbers, an unequal add/remove run leaving a
// blank filler cell on the shorter side (not silently dropped rows), and a
// context line identical on both sides.
//
// Run:  node scripts/e2e/test-diff-side-by-side.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-diffsxs-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9524";
const { launch } = await import("./harness.mjs");

// Two files, one commit header. The first hunk has 2 deletions and 3
// additions (an unequal run - the case that must leave a blank filler cell
// rather than silently lose the third addition); the second has 1-for-1.
const DIFF_TEXT = [
  "commit abc123def456",
  "Fix the thing",
  "",
  " src/a.js | 4 ++--",
  " src/b.js | 2 +-",
  " 2 files changed, 4 insertions(+), 2 deletions(-)",
  "diff --git a/src/a.js b/src/a.js",
  "index 1111111..2222222 100644",
  "--- a/src/a.js",
  "+++ b/src/a.js",
  "@@ -10,4 +10,5 @@ function foo() {",
  " context before",
  "-old line one",
  "-old line two",
  "+new line one",
  "+new line two",
  "+new line three",
  " context after",
  "diff --git a/src/b.js b/src/b.js",
  "index 3333333..4444444 100644",
  "--- a/src/b.js",
  "+++ b/src/b.js",
  "@@ -1,1 +1,1 @@",
  "-removed only",
  "+added only",
].join("\n");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const out = await app.eval(`(() => {
    document.querySelectorAll("#diffProbe").forEach((n) => n.remove());
    const wrap = document.createElement("div");
    wrap.id = "diffProbe";
    document.body.append(wrap);
    let thrown = null;
    let files = null;
    try {
      files = parseUnifiedDiffFiles(${JSON.stringify(DIFF_TEXT)});
      renderDiffFiles(wrap, files);
    } catch (err) {
      thrown = String(err && err.stack ? err.stack : err).slice(0, 800);
    }
    const grids = [...wrap.querySelectorAll(".diff-grid")];
    const rowsOf = (grid) => {
      const cells = [...grid.children].filter((c) => c.classList.contains("diff-ln-old"));
      return cells.map((oldNum) => {
        const oldText = oldNum.nextElementSibling;
        const newNum = oldText.nextElementSibling;
        const newText = newNum.nextElementSibling;
        return {
          oldNum: oldNum.textContent,
          oldText: oldText.textContent,
          oldClass: oldText.className,
          newNum: newNum.textContent,
          newText: newText.textContent,
          newClass: newText.className,
        };
      });
    };
    return {
      thrown,
      fileCount: files ? files.length : -1,
      fileHeaderTexts: files ? files.map((f) => f.header.join("|")) : null,
      gridCount: grids.length,
      grid0Rows: grids[0] ? rowsOf(grids[0]) : null,
      grid1Rows: grids[1] ? rowsOf(grids[1]) : null,
    };
  })()`);

  ok(!out.thrown, `parseUnifiedDiffFiles + renderDiffFiles did not throw${out.thrown ? ": " + out.thrown : ""}`);
  ok(out.fileCount === 3, `three blocks: the commit-header preamble + two real files (got ${out.fileCount})`);
  ok(out.gridCount === 2, `one grid per file with a hunk (got ${out.gridCount})`);

  const g0 = out.grid0Rows || [];
  ok(g0.length === 5, `file a.js's hunk produced 5 rows: context, 2 paired, 1 add-only filler, context (got ${g0.length})`);
  ok(g0[0].oldText === "context before" && g0[0].newText === "context before", "the leading context line is identical on both sides");
  ok(g0[0].oldNum === "10" && g0[0].newNum === "10", "context line numbers start at the hunk header's declared old/new start (10/10)");
  ok(g0[1].oldText === "old line one" && g0[1].newText === "new line one", "row 2 pairs the first deletion with the first addition");
  ok(g0[1].oldClass.includes("diff-del") && g0[1].newClass.includes("diff-add"), "row 2 is coloured del on the left, add on the right");
  ok(g0[2].oldText === "old line two" && g0[2].newText === "new line two", "row 3 pairs the second deletion with the second addition");
  ok(g0[3].oldText === "" && g0[3].oldClass.includes("diff-empty"), "row 4's LEFT cell is a blank filler, not a dropped third addition");
  ok(g0[3].newText === "new line three" && g0[3].newClass.includes("diff-add"), "row 4's RIGHT cell carries the third addition that had no matching deletion");
  ok(g0.at(-1).oldText === "context after" && g0.at(-1).newText === "context after", "the trailing context line closes the hunk on both sides");

  const g1 = out.grid1Rows || [];
  ok(g1.length === 1, `file b.js's 1-for-1 hunk produced exactly 1 row, not 2 (got ${g1.length})`);
  ok(g1[0].oldText === "removed only" && g1[0].newText === "added only", "a simple one-line replace pairs cleanly with no filler");

  // The changed-files column (task c3dfbb42 follow-up: "borde finnas en till kolumn
  // där man kan se ändrade filer och väljer fil att se diff för där") - driven through
  // the REAL openDiffViewer, not the parser alone, since the column lives in its click
  // handlers.
  const fl = await app.eval(`(() => {
    const row = { title: "probe", taskId: "aaaaaaaa" };
    const res = { commits: [{ sha: "abc123def456", subject: "Fix the thing" }], text: ${JSON.stringify(DIFF_TEXT)}, source: "record", truncated: false };
    openDiffViewer(row, res);
    const fileList = document.getElementById("docvFileList");
    const docvBody = document.getElementById("docvBody");
    const items = () => [...fileList.querySelectorAll(".docv-filelist-item")];
    // Scoped to docvBody specifically, not the whole document - an earlier probe in
    // this same test rendered its own .diff-file-block elements into a standalone
    // #mdProbe/#diffProbe wrapper that is never cleaned up, and a bare document-wide
    // query would count those leftovers too.
    const blockState = () => [...docvBody.querySelectorAll(".diff-file-block")].map((b) => ({ file: b.dataset.file || null, hidden: b.classList.contains("hidden") }));
    const before = { hidden: fileList.classList.contains("hidden"), labels: items().map((b) => b.textContent), blocks: blockState() };
    items()
      .find((b) => b.textContent === "a.js")
      .click();
    const afterA = { selected: items().map((b) => b.classList.contains("selected")), blocks: blockState() };
    items()
      .find((b) => b.textContent.startsWith("All files"))
      .click();
    const afterAll = { selected: items().map((b) => b.classList.contains("selected")), blocks: blockState() };
    return { before, afterA, afterAll };
  })()`);
  ok(!fl.before.hidden, "the file-list column shows itself when the diff touches more than one file");
  ok(JSON.stringify(fl.before.labels) === JSON.stringify(["All files (2)", "a.js", "b.js"]), `it lists "All files (N)" plus each changed file, in order (${JSON.stringify(fl.before.labels)})`);
  ok(
    fl.before.blocks.every((b) => !b.hidden),
    "everything is visible before picking a file"
  );
  const aBlocks = fl.afterA.blocks.filter((b) => b.file === "src/a.js");
  const bBlocks = fl.afterA.blocks.filter((b) => b.file === "src/b.js");
  const preamble = fl.afterA.blocks.filter((b) => b.file === null);
  ok(
    aBlocks.every((b) => !b.hidden),
    "picking a.js keeps its own block visible"
  );
  ok(
    bBlocks.length > 0 && bBlocks.every((b) => b.hidden),
    "and hides b.js's block"
  );
  ok(
    preamble.length > 0 && preamble.every((b) => !b.hidden),
    "the commit-message/--stat preamble is not a file block, so picking a.js never hides it"
  );
  ok(fl.afterA.selected[1] === true && fl.afterA.selected[0] === false, "the a.js item is marked selected, All files is not");
  ok(
    fl.afterAll.blocks.every((b) => !b.hidden),
    "clicking All files again shows everything"
  );
  ok(fl.afterAll.selected[0] === true, "and re-selects All files");

  const singleFile = await app.eval(`(() => {
    document.querySelectorAll("#docvFileList .docv-filelist-item").forEach((n) => n.remove());
    const row = { title: "probe2", taskId: "bbbbbbbb" };
    const oneFileDiff = ["diff --git a/x.js b/x.js", "index 111..222 100644", "--- a/x.js", "+++ b/x.js", "@@ -1,1 +1,1 @@", "-old", "+new"].join("\\n");
    const res = { commits: [{ sha: "def", subject: "One file" }], text: oneFileDiff, source: "record", truncated: false };
    openDiffViewer(row, res);
    return document.getElementById("docvFileList").classList.contains("hidden");
  })()`);
  ok(singleFile, "a diff touching only one file gets no column - it would only ever offer 'All files'");

  const consoleErrors = app.getConsoleErrors();
  ok(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
} catch (err) {
  ok(false, `unexpected failure: ${err.message}`);
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(exit === 0 ? "VERIFY OK: the side-by-side diff pairs, aligns, and fills unequal runs correctly." : "VERIFY FAILED.");
process.exit(exit);
