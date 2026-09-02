// LIVE-EXEMPT: it starts the app but never a session, so nothing reaches a model.
//
// The DOM half of card 7cf14337. test-skill-chips.mjs proves the parse and the resolution
// purely; this proves the one thing a pure check cannot: that a Skill call LEAVES the
// collapsed "Used N tools" group and becomes a chip that opens the SKILL.md it names.
//
// That is the whole point of the card. The signal was always in the transcript - a `Skill`
// tool_use - and Helm was already drawing it, one line down inside a closed <details>, beside
// every Bash and Read call of the turn. So "which skills it uses" was technically on screen
// and practically invisible, which is why the card exists.
//
// Two failure modes worth naming, because both look fine in a screenshot:
//   - the chip renders AND the call is still in the group: the same fact twice;
//   - the chip renders and the group stops forming for the ordinary calls beside it.
// Both are asserted, in one render, from the turn shapes the real transcript produces.
//
// Run:  HELM_E2E_HIDDEN=1 node scripts/e2e/test-skill-chip-renders.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-skillchip-dom-"));
const proj = path.join(tmp, "proj");
fs.mkdirSync(path.join(proj, ".claude", "skills", "probe-skill"), { recursive: true });
fs.writeFileSync(
  path.join(proj, ".claude", "skills", "probe-skill", "SKILL.md"),
  "# Probe skill\n\nThe body that proves the chip opened the right file: ZEBRAFISH.\n",
  "utf8"
);

process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9531";
const { launch } = await import("./harness.mjs");

// Exactly what readTranscript produces for the captured records in test-skill-chips.mjs:
// a Skill tool_use, its "Launching skill" result, then an ordinary Read call and result.
const TURNS = [
  { role: "user", kind: "text", text: "Use the probe-skill skill and read sub/note.txt." },
  { role: "assistant", kind: "tool_use", toolName: "Skill", toolInput: "probe-skill" },
  { role: "user", kind: "tool_result", text: "Launching skill: probe-skill" },
  { role: "assistant", kind: "tool_use", toolName: "Read", toolInput: path.join(proj, "sub", "note.txt") },
  { role: "user", kind: "tool_result", text: "1\thello from sub" },
  { role: "assistant", kind: "tool_use", toolName: "Bash", toolInput: "ls" },
  { role: "user", kind: "tool_result", text: "note.txt" },
  { role: "assistant", kind: "text", text: "hello from sub" },
];

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const drawn = await app.eval(`(async () => {
    navigateToPage("chat");
    const pane = panes[0];
    pane.cwd = ${JSON.stringify(proj.replace(/\\/g, "/"))};
    pane.turns = ${JSON.stringify(TURNS)};
    pane.hiddenCount = 0;
    pane.transcriptTruncated = false;
    pane.loading = false;
    renderPane(0);
    // The origin label is resolved through IPC (it reads skills folders), so the chip lands
    // name-only and gains "· project" a beat later. Poll for the label rather than sleeping.
    let chip = null;
    for (let i = 0; i < 60; i++) {
      chip = document.querySelector('.pane[data-pane="0"] .turn-skill-chip');
      if (chip && !chip.disabled) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const scroll = document.querySelector('.pane[data-pane="0"] .transcript, .pane[data-pane="0"] .pane-scroll') ||
      chip?.closest('[class*="scroll"], .pane');
    const groups = [...document.querySelectorAll('.pane[data-pane="0"] .tool-group')];
    return {
      chipText: chip ? chip.textContent.trim() : null,
      chipEnabled: chip ? !chip.disabled : false,
      chipInGroup: chip ? !!chip.closest(".tool-group") : null,
      chipTitle: chip ? chip.title : null,
      groupSummaries: groups.map((g) => g.querySelector("summary").textContent.trim()),
      strayLaunchRows: [...document.querySelectorAll('.pane[data-pane="0"] .turn-tool-result')]
        .map((el) => el.textContent.trim())
        .filter((t) => /^Launching skill/.test(t)),
      // The chip must sit where the call happened, not collected at the end.
      chipBeforeGroup: chip && groups.length
        ? chip.compareDocumentPosition(groups[0]) === Node.DOCUMENT_POSITION_FOLLOWING
        : null,
    };
  })()`);

  ok(drawn.chipText === "⚡ probe-skill · project", `the invoked skill renders as a chip naming it and where it came from (${JSON.stringify(drawn.chipText)})`);
  ok(drawn.chipEnabled === true, "and it is clickable, because Helm found the SKILL.md it refers to");
  ok(drawn.chipInGroup === false, "the Skill call is NOT also inside the collapsed \"Used N tools\" group");
  ok(
    drawn.groupSummaries.length === 1 && /Used 2 tools/.test(drawn.groupSummaries[0]),
    `the ordinary calls beside it still group as before, and the Skill call is not counted among them (${JSON.stringify(drawn.groupSummaries)})`
  );
  ok(!/Skill/.test(drawn.groupSummaries.join(" ")), "so the group summary no longer lists Skill as one of the tools used");
  ok(
    drawn.strayLaunchRows.length === 0,
    `the call's own "Launching skill: X" result is not left as a row under the chip that said so (${JSON.stringify(drawn.strayLaunchRows)})`
  );
  ok(drawn.chipBeforeGroup === true, "the chip sits at the point in the transcript where the skill ran");

  // A chip must be actionable, not decoration - the standard test-context-chip-kinds sets for
  // every chip in this app: clicking it shows that file's real content.
  const opened = await app.eval(`(async () => {
    document.querySelector('.pane[data-pane="0"] .turn-skill-chip').click();
    let body = "";
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 50));
      body = (document.getElementById("docvBody").textContent || "").trim();
      if (body && !/^Loading/.test(body)) {
        break;
      }
    }
    const title = document.getElementById("docvTitle").textContent;
    closeDocViewer();
    return { body: body.slice(0, 200), title };
  })()`);
  ok(/probe-skill/.test(opened.title || ""), `clicking opens a viewer titled after the skill (${JSON.stringify(opened.title)})`);
  ok(/ZEBRAFISH/.test(opened.body || ""), `and shows that SKILL.md's real content, not an error (${JSON.stringify(opened.body)})`);

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    console.log("   ", e.text.slice(0, 200));
  }
} catch (err) {
  exit = 1;
  console.log(`FAIL - the check threw: ${err && (err.stack || err.message)}`);
} finally {
  try {
    await app?.close();
  } catch {
    // nothing to do; the harness reaps leftovers on the next launch
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // temp dir; a leftover is harmless
  }
}

console.log("");
console.log(
  exit === 0
    ? "VERIFY OK: an invoked skill leaves the tool group, renders as its own chip naming skill and scope, and opens that SKILL.md."
    : "VERIFY FAILED."
);
process.exit(exit);
