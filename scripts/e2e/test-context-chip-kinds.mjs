// Every chip in "Context files" opens the file it names.
//
// Reported on task 2ba0d277: several chips in the analysis view referenced the wrong thing
// and one said "none", with the doc viewer showing "Invalid project doc" over a topic
// handoff file.
//
// Root cause: main's context:list puts TWO kinds of entry in the same `projectDocs` array -
// the three durable project docs (HANDOFF/DECISIONS/PLAN, kind "projectDoc") and, for a
// session with no repo of its own, the topic handoffs from Helm's own store (kind
// "handoffTopic"). The renderer hardcoded kind: "projectDoc" for every one of them, so a
// topic-handoff chip asked main for a project doc named "bird-feeders.md" - which the
// resolver refuses by design, because it only allows the three known names.
//
// So the check is not "does a chip exist": it is that clicking EVERY chip in the section
// returns that file's real content. A chip that cannot open what it names is the whole bug.
//
// Run:  node scripts/e2e/test-context-chip-kinds.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-ctxchips-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(path.join(metaHome, ".helm", "handoffs"), { recursive: true });
// Two topic handoffs, the store's own file layout. These are what a session with no repo
// carries its continuity in, and they are listed beside the project docs.
fs.writeFileSync(path.join(metaHome, ".helm", "handoffs", "bird-feeders.md"), "# Bird feeders\n\nLast build: cedar, two ports.\n", "utf8");
fs.writeFileSync(path.join(metaHome, ".helm", "handoffs", "model-trains.md"), "# Model trains\n\nNext: wire the second loop.\n", "utf8");
// DECISIONS.md exists, HANDOFF.md and PLAN.md do not - the mix a meta-home-rooted session shows.
fs.writeFileSync(path.join(metaHome, "DECISIONS.md"), "# Decisions\n\n- Meta-home root.\n", "utf8");
fs.writeFileSync(path.join(metaHome, "CLAUDE.md"), "# Rules\n\nBe precise.\n", "utf8");

process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9517";
const { launch } = await import("./harness.mjs");

const jsonCwd = JSON.stringify(metaHome);

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Point the focused pane at the meta-home root - that is the case that gets topic
  // handoffs listed alongside the project docs, and the case in the screenshot.
  const chips = await app.eval(`(async () => {
    panes[focusedPaneIndex].cwd = ${jsonCwd};
    navigateToPage("analysis");
    await renderAnalysisPage();
    const block = [...document.querySelectorAll(".analysis-block")].find((b) =>
      (b.querySelector("h3")?.textContent || "").startsWith("Context files")
    );
    if (!block) {
      return { found: false };
    }
    return {
      found: true,
      labels: [...block.querySelectorAll(".skill-chip")].map((c) => ({
        text: c.textContent.trim(),
        disabled: c.disabled,
      })),
    };
  })()`);
  ok(chips.found, "the Context files section renders");
  const labels = (chips.labels || []).map((l) => l.text);
  ok(
    labels.some((t) => t.startsWith("bird-feeders.md")),
    `the topic handoffs are listed (${JSON.stringify(labels)})`
  );

  // THE point: click each ENABLED chip and read what the viewer actually shows. A chip
  // whose reference is wrong renders main's refusal text instead of the file.
  const opened = await app.eval(`(async () => {
    const block = [...document.querySelectorAll(".analysis-block")].find((b) =>
      (b.querySelector("h3")?.textContent || "").startsWith("Context files")
    );
    const out = [];
    for (const chip of [...block.querySelectorAll(".skill-chip")]) {
      if (chip.disabled) {
        continue;
      }
      const label = chip.textContent.trim();
      chip.click();
      // openDocViewer resolves through IPC; poll until the loading placeholder is gone.
      let body = "";
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        body = (document.getElementById("docvBody").textContent || "").trim();
        if (body && !/^Loading/.test(body)) {
          break;
        }
      }
      out.push({ label, body: body.slice(0, 160), title: document.getElementById("docvTitle").textContent });
      closeDocViewer();
    }
    return out;
  })()`);

  ok(opened.length >= 4, `every enabled chip was clicked (${opened.length} of them)`);
  for (const o of opened) {
    const failed = /^(Invalid |Unknown context kind|No |Could not read|Memory file not found|Handoff topic not found)/.test(o.body) || /not found$/.test(o.body);
    ok(!failed, `"${o.label}" opens its file rather than an error (${JSON.stringify(o.body.slice(0, 70))})`);
  }
  // Named specifically, because this one is the reported bug and a generic loop over
  // whatever happens to be present could stop covering it.
  const topic = opened.find((o) => o.label.startsWith("bird-feeders.md"));
  ok(
    !!topic && /cedar, two ports/.test(topic.body),
    `the topic handoff shows its own content (${JSON.stringify(topic?.body?.slice(0, 70) || null)})`
  );

  // The "(none)" chips: a missing file is still worth showing (it tells him the doc does
  // not exist yet), but it must be disabled rather than clickable-and-broken, and a
  // meta-home root must not claim to be missing a HANDOFF.md when its handoffs live in
  // the topic store beside it.
  const nones = await app.eval(`(() => {
    const block = [...document.querySelectorAll(".analysis-block")].find((b) =>
      (b.querySelector("h3")?.textContent || "").startsWith("Context files")
    );
    return [...block.querySelectorAll(".skill-chip")]
      .filter((c) => /\\(none\\)/.test(c.textContent))
      .map((c) => ({ text: c.textContent.trim(), disabled: c.disabled, title: c.title }));
  })()`);
  ok(
    nones.every((n) => n.disabled),
    `every "(none)" chip is disabled, not a click that fails (${JSON.stringify(nones)})`
  );
  ok(
    !nones.some((n) => n.text.startsWith("HANDOFF.md")),
    `a meta-home root does not report a missing HANDOFF.md - its handoffs are the topic files (${JSON.stringify(nones.map((n) => n.text))})`
  );

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

console.log(exit === 0 ? "VERIFY OK: every context chip opens the file it names." : "VERIFY FAILED.");
process.exit(exit);
