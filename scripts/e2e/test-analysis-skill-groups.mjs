// The Analysis page shows skills grouped the way they are grouped on disk, lists the
// plugins' skills too, and its empty state says where it looked.
//
// Two tasks:
//  - 3d0fe057 "Skillsen är kategoriserade i subfolders. kan vi använda samma
//    kategorisering i presentationen i analysis?"
//  - 07658c1a "Vad är tänkt att visas här i analysis?", asked about an empty
//    "This pane's project skills · 0 / None found." - a section that could not say what
//    it was for. The fix is the empty state, so this test reads that TEXT, not a count.
//
// Everything comes from a fake ~/.claude (HELM_CLAUDE_HOME), so the assertions do not
// move when the real skills folder changes.
//
// Run:  node scripts/e2e/test-analysis-skill-groups.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-skillgrp-"));
const home = path.join(tmp, "claude-home");
const skill = (dir, body) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body || "---\nname: x\n---\n\nbody\n", "utf8");
};
skill(path.join(home, "skills", "handoff"));
skill(path.join(home, "skills", "git", "rebase"), "---\nname: rebase\n---\n\nRebase onto upstream first.\n");
skill(path.join(home, "skills", "git", "blame"));
// The pane's folder is a repo with NO skills of its own - the empty state under test.
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo, { recursive: true });

const mkt = path.join(tmp, "market");
fs.mkdirSync(path.join(mkt, ".claude-plugin"), { recursive: true });
fs.writeFileSync(
  path.join(mkt, ".claude-plugin", "marketplace.json"),
  JSON.stringify({ name: "mkt", plugins: [{ name: "demo", source: "./p/demo" }] }),
  "utf8"
);
skill(path.join(mkt, "p", "demo", "skills", "add-badges"));
skill(path.join(mkt, "p", "demo", "skills", "add-buff"));
fs.writeFileSync(
  path.join(home, "settings.json"),
  JSON.stringify({ enabledPlugins: { "demo@mkt": true }, extraKnownMarketplaces: { mkt: { source: { source: "directory", path: mkt } } } }),
  "utf8"
);

process.env.HELM_CLAUDE_HOME = home;
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9518";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const view = await app.eval(`(async () => {
    panes[focusedPaneIndex].cwd = ${JSON.stringify(repo)};
    navigateToPage("analysis");
    await renderAnalysisPage();
    const blocks = [...document.querySelectorAll(".analysis-block")].map((b) => ({
      head: (b.querySelector("h3")?.textContent || "").trim(),
      headTitle: b.querySelector("h3")?.title || "",
      hints: [...b.querySelectorAll(".suggest-hint")].map((h) => h.textContent.trim()),
      chips: [...b.querySelectorAll(".skill-chip")].map((c) => c.textContent.trim()),
      empty: (b.querySelector(".pane-empty")?.textContent || "").trim(),
    }));
    return { blocks };
  })()`);

  // Found while writing this test: navigating to Analysis starts a render, and a second
  // render starting before the first finished its IPC made BOTH append - every block on
  // the page twice. The test drives exactly that overlap, so it stays pinned here.
  const heads = view.blocks.map((b) => b.head);
  const dupes = heads.filter((h, i) => heads.indexOf(h) !== i);
  ok(dupes.length === 0, `two overlapping renders draw the page once, not twice (duplicated: ${JSON.stringify([...new Set(dupes)])})`);

  const globalBlock = view.blocks.find((b) => b.head.startsWith("Global skills"));
  ok(!!globalBlock, "the global skills block renders");
  ok(globalBlock.head.endsWith("· 3"), `it counts skills across categories (${globalBlock.head})`);
  ok(globalBlock.headTitle.endsWith(path.join("claude-home", "skills")), `and its heading carries the folder it read (${globalBlock.headTitle})`);
  ok(
    globalBlock.hints.some((h) => h === "git · 2"),
    `a subfolder renders as its own labelled group (${JSON.stringify(globalBlock.hints)})`
  );
  ok(
    JSON.stringify(globalBlock.chips) === JSON.stringify(["handoff", "blame", "rebase"]),
    `a grouped skill shows its own name, not the folder path (${JSON.stringify(globalBlock.chips)})`
  );

  const projectBlock = view.blocks.find((b) => b.head.startsWith("This pane's project skills"));
  ok(!!projectBlock, "the project skills block renders");
  ok(projectBlock.head.endsWith("· 0"), `and is empty for a repo with no skills (${projectBlock.head})`);
  // THE point of 07658c1a: the empty state has to answer "what is meant to be here".
  ok(
    projectBlock.empty.includes(path.join(repo, ".claude", "skills")),
    `its empty state names the folder it looked in (${JSON.stringify(projectBlock.empty)})`
  );
  ok(
    /global list/.test(projectBlock.empty),
    "and says the pane's skills are the global ones, so 0 does not read as \"no skills available\""
  );

  const pluginBlock = view.blocks.find((b) => b.head.startsWith("Plugin skills"));
  ok(!!pluginBlock, `an enabled plugin's skills get their own block (${JSON.stringify(view.blocks.map((b) => b.head))})`);
  ok(pluginBlock?.head === "Plugin skills (demo@mkt) · 2", `named by plugin and marketplace (${pluginBlock?.head})`);
  ok(
    JSON.stringify(pluginBlock?.chips) === JSON.stringify(["add-badges", "add-buff"]),
    `with its skills listed (${JSON.stringify(pluginBlock?.chips)})`
  );

  // A chip in a CATEGORY must still open the file it names - the reference carries the
  // category, and a chip that cannot open its own file is the bug this pair replaced.
  const opened = await app.eval(`(async () => {
    const block = [...document.querySelectorAll(".analysis-block")].find((b) =>
      (b.querySelector("h3")?.textContent || "").startsWith("Global skills")
    );
    const chip = [...block.querySelectorAll(".skill-chip")].find((c) => c.textContent.trim() === "rebase");
    chip.click();
    let body = "";
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      body = (document.getElementById("docvBody").textContent || "").trim();
      if (body && !/^Loading/.test(body)) {
        break;
      }
    }
    const title = document.getElementById("docvTitle").textContent;
    closeDocViewer();
    return { body: body.slice(0, 120), title };
  })()`);
  ok(/Rebase onto upstream first/.test(opened.body), `clicking a grouped skill opens its SKILL.md (${JSON.stringify(opened.body)})`);
  ok(opened.title === "git/rebase · SKILL.md", `titled with its full reference (${opened.title})`);

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    console.log("   ", e.text.slice(0, 200));
  }
} catch (err) {
  exit = 1;
  console.error("ERR", err.stack || err.message);
} finally {
  try {
    await app?.close();
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: Analysis groups skills by their folders, lists plugin skills, and its empty state says where it looked."
    : "VERIFY FAILED."
);
process.exit(exit);
