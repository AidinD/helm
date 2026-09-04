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
// The real shape of the captain's setup: the skills root is FLAT and its entries are links
// into <meta-home>/skills-catalog, which is the organised tree. A skill linked from
// there has to render under the catalog's own path.
const metaHome = path.join(tmp, "meta-home");
skill(path.join(metaHome, "skills-catalog", "portfolio", "dev-workflow", "catchup"), "---\nname: catchup\n---\n\nSummarise the branch.\n");
fs.symlinkSync(path.join(metaHome, "skills-catalog", "portfolio", "dev-workflow", "catchup"), path.join(home, "skills", "catchup"), "junction");
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
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9518";
const { launch } = await import("../checks-lib/harness.mjs");

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
      childCount: b.children.length,
      // Kept so a failure on a machine nobody can attach a debugger to carries its own
      // diagnosis. On a hosted runner this check reported "(0 has 0)" - a block whose heading
      // was the string "0" - and nothing in the output said what that block WAS. Two guesses
      // were spent on it, both wrong. A scrape that fails should hand over the thing it
      // scraped, not a number derived from it.
      classes: b.className,
      outline: b.outerHTML.replace(/\s+/g, " ").slice(0, 220),
    }));
    return { blocks };
  })()`);

  // Found while writing this test: navigating to Analysis starts a render, and a second
  // render starting before the first finished its IPC made BOTH append - every block on
  // the page twice. The test drives exactly that overlap, so it stays pinned here.
  const heads = view.blocks.map((b) => b.head);
  const dupes = heads.filter((h, i) => heads.indexOf(h) !== i);
  ok(dupes.length === 0, `two overlapping renders draw the page once, not twice (duplicated: ${JSON.stringify([...new Set(dupes)])})`);

  // Review analytics (task 76790f23: "Visa hur review hanteras"). Whether this
  // machine's real helm-usage.jsonl happens to have logged review decisions or not is
  // NOT pinned here - like the project-skills picker above, getReviewActionSummary
  // reads the real local log (there is no isolation seam for it that does not also
  // move Electron's own profile), so this only pins the shape: the block renders and
  // is never blank (either the empty-state text, or at least the heading plus real
  // content). The join math (fractions, model breakdown) is verified separately
  // against an isolated log in test-review-action-tracking.mjs.
  const reviewBlock = view.blocks.find((b) => b.head === "Review analytics");
  ok(!!reviewBlock, "the review analytics block renders");
  ok(
    !!reviewBlock?.empty || (reviewBlock?.childCount || 0) > 1,
    `and is never blank - either an empty-state message or real analytics content (${JSON.stringify(reviewBlock)})`
  );

  const globalBlock = view.blocks.find((b) => b.head.startsWith("Global skills"));
  ok(!!globalBlock, "the global skills block renders");
  ok(globalBlock.head.endsWith("· 4"), `it counts skills across categories (${globalBlock.head})`);
  ok(globalBlock.headTitle.endsWith(path.join("claude-home", "skills")), `and its heading carries the folder it read (${globalBlock.headTitle})`);
  ok(
    globalBlock.hints.some((h) => h === "git · 2"),
    `a subfolder renders as its own labelled group (${JSON.stringify(globalBlock.hints)})`
  );
  // THE case from his answer: the skills root is flat, and the categorisation comes
  // from the catalog the entries link into.
  ok(
    globalBlock.hints.some((h) => h === "portfolio / dev-workflow · 1"),
    `a skill linked into skills-catalog renders under the catalog's own path (${JSON.stringify(globalBlock.hints)})`
  );
  ok(
    globalBlock.hints.some((h) => h === "uncategorised · 1"),
    `and one the catalog does not know is named as the remainder rather than sitting unlabelled (${JSON.stringify(globalBlock.hints)})`
  );
  ok(
    globalBlock.hints.some((h) => h === "Grouped by skills-catalog"),
    `the page says where the grouping came from - a flat folder rendering as labelled groups is otherwise unexplainable (${JSON.stringify(globalBlock.hints)})`
  );
  ok(
    JSON.stringify(globalBlock.chips) === JSON.stringify(["blame", "rebase", "catchup", "handoff"]),
    `a grouped skill shows its own name, not the folder path (${JSON.stringify(globalBlock.chips)})`
  );

  // Project skills are PER PROJECT now, not for whichever pane is focused - a page you
  // reach by leaving the pane cannot answer a question about that pane (the captain,
  // 2026-08-05: "man kan inte ens vara i ett projekt OCH analysis samtidigt").
  ok(
    !view.blocks.some((b) => b.head.startsWith("This pane's project skills")),
    `no block describes "this pane" any more (${JSON.stringify(view.blocks.map((b) => b.head))})`
  );
  // Which projects appear depends on the machine's real session list (there is no seam
  // for it that does not also move Electron's own profile), so this asserts the SHAPE
  // every project block must have. Which projects, and that only ones with skills are
  // listed, is pinned by test-skill-sources against a fixture.
  const projectBlocks = view.blocks.filter((b) => b.head.startsWith("Project skills"));
  // ONE block, whatever the number of projects: a block per project grew out of hand
  // immediately (the captain, 2026-08-05 - three projects, and the row was already too much).
  ok(
    projectBlocks.length === 1,
    `exactly one project-skills block, however many projects have skills (${projectBlocks.length})`
  );
  for (const b of projectBlocks) {
    // The nothing-found case is recognised by WHAT IT CONTAINS, not by its heading text. It was
    // matched as the exact string "Project skills", which the app never produces: skillListEl
    // appends the count, so the empty block reads "Project skills · 0". On a machine that has
    // projects with skills that branch is never taken, so the mismatch was invisible here and
    // failed on a runner as "(0 has 0)" - a project block with no chips, which is the one thing
    // the assertion below forbids. An empty state has an empty state in it; that is the test.
    if (b.empty) {
      // The nothing-found case: it must say how many folders were looked at, not just 0.
      ok(
        /project folders Helm has sessions in|No project folders known yet/.test(b.empty),
        `the empty state says how hard it looked (${JSON.stringify(b.empty)})`
      );
      ok(!/this pane|focused pane/i.test(b.empty), "and does not talk about a pane you cannot see from here");
      continue;
    }
    ok(/^Project skills · .+/.test(b.head), `a project block is named after its project (${b.head})`);
    ok(
      b.hints.some((h) => /[\\/]/.test(h)),
      `with its full path on screen, since a folder name is ambiguous (${JSON.stringify(b.hints)})`
    );
    ok(
      b.chips.length > 0,
      `and only projects that HAVE skills are offered (${JSON.stringify(b.head)} has ${b.chips.length}; classes ${JSON.stringify(b.classes)}; ${b.outline})`
    );
  }

  // The picker: one pill per project with skills, exactly one selected, and clicking
  // another one actually swaps the block's skills - a picker that repaints nothing is a
  // control that visibly does nothing, which this app has shipped before.
  const picker = await app.eval(`(() => {
    const el = document.querySelector(".analysis-project-picker");
    if (!el) {
      return { present: false };
    }
    const pills = [...el.querySelectorAll(".dash-chip")];
    return {
      present: true,
      labels: pills.map((p) => p.textContent.trim()),
      titles: pills.map((p) => p.title),
      selected: pills.filter((p) => p.classList.contains("dash-chip-selected")).map((p) => p.textContent.trim()),
      head: el.closest(".analysis-block").querySelector("h3").textContent,
    };
  })()`);
  ok(picker.present, "a project picker renders inside the block");
  ok(picker.selected.length === 1, `with exactly one project selected (${JSON.stringify(picker.selected)})`);
  ok(
    picker.labels.every((l) => /· \d+$/.test(l)),
    `each pill carries its project's skill count, so picking is informed (${JSON.stringify(picker.labels)})`
  );
  ok(
    picker.titles.every((t) => /[\\/]/.test(t)),
    "and its full path on hover, since two repos can share a basename"
  );
  if (picker.labels.length > 1) {
    const swapped = await app.eval(`(async () => {
      const el = document.querySelector(".analysis-project-picker");
      const before = { head: el.closest(".analysis-block").querySelector("h3").textContent, chips: [...el.closest(".analysis-block").querySelectorAll(".skill-chip")].map((c) => c.textContent.trim()) };
      const other = [...el.querySelectorAll(".dash-chip")].find((p) => !p.classList.contains("dash-chip-selected"));
      other.click();
      await new Promise((r) => setTimeout(r, 150));
      const el2 = document.querySelector(".analysis-project-picker");
      const block2 = el2.closest(".analysis-block");
      return {
        before,
        after: { head: block2.querySelector("h3").textContent, chips: [...block2.querySelectorAll(".skill-chip")].map((c) => c.textContent.trim()) },
        blocks: document.querySelectorAll(".analysis-project-picker").length,
        selected: [...el2.querySelectorAll(".dash-chip-selected")].map((p) => p.textContent.trim()),
      };
    })()`);
    ok(swapped.after.head !== swapped.before.head, `picking another project retitles the block (${swapped.before.head} -> ${swapped.after.head})`);
    ok(
      JSON.stringify(swapped.after.chips) !== JSON.stringify(swapped.before.chips),
      "and swaps the skills shown, rather than leaving the previous project's list in place"
    );
    ok(swapped.blocks === 1, `still one block afterwards - the repaint replaces it, it does not add another (${swapped.blocks})`);
    ok(swapped.selected.length === 1, `and one pill is selected afterwards (${JSON.stringify(swapped.selected)})`);
  } else {
    console.log("   (only one project has skills on this machine - the swap half of the picker was not exercised)");
  }

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
