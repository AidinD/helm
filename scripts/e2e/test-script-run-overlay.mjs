// Drives the SCRIPT RUN OVERLAY itself, in the real app, with real child
// processes (task 8bfae7a0).
//
// Why this exists next to test-repo-scripts.mjs: that test calls the IPC
// (listRepoScripts / runRepoScript) and passes. The mechanism was never broken.
// What Aidin reported was "terminalen är inte tydlig, vet inte ens om den
// funkar" - a black empty box with the word "running…" in it. A test that
// exercises the layer below the complaint cannot see that, which is the exact
// failure pattern recorded in DECISIONS.md: my tests pass while the feature is
// unusable, because they test what I already reasoned about.
//
// So every assertion here reads what is ON SCREEN.
//
// Run: node scripts/e2e/test-script-run-overlay.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./harness.mjs";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-overlay-"));
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(
  path.join(repo, "package.json"),
  JSON.stringify(
    {
      name: "overlay-demo",
      scripts: {
        talks: 'node -e "console.log(\'BUILD ARTEFACT READY\')"',
        silent: 'node -e "process.exit(0)"',
        breaks: 'node -e "process.exit(3)"',
      },
    },
    null,
    2
  ),
  "utf8"
);
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9586";

const J = JSON.stringify;
// Read the overlay as a user sees it: header status + the transcript text.
const readOverlay = () =>
  app.eval(`(() => {
    const box = document.querySelector(".script-run-box");
    if (!box) { return null; }
    return {
      title: box.querySelector(".script-run-title")?.textContent || "",
      cwd: box.querySelector(".script-run-cwd")?.textContent || "",
      status: box.querySelector(".script-run-status")?.textContent || "",
      statusClass: box.querySelector(".script-run-status")?.className || "",
      out: box.querySelector(".script-run-out")?.textContent || "",
      stopDisabled: !!box.querySelector(".script-run-actions button")?.disabled,
    };
  })()`);

const waitForFinish = async (timeoutMs = 20000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const o = await readOverlay();
    if (o && !/^(starting|running)/.test(o.status)) {
      return o;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return await readOverlay();
};
const closeOverlay = () => app.eval(`(() => { document.querySelector(".script-run-overlay")?.remove(); return 1; })()`);

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- 1. THE COMPLAINT: the box must not open blank -----------------------
  await app.eval(`(() => { showScriptRunOverlay(${J(repo)}, "talks"); return 1; })()`);
  const opened = await readOverlay();
  ok(!!opened, "the overlay opens");
  ok(
    opened.out.includes("> npm run talks"),
    `it echoes the command immediately, like a terminal prompt (${J(opened.out.slice(0, 60))})`
  );
  ok(opened.out.includes(repo), "and says which folder it runs in");
  ok(opened.out.trim().length > 0, "so the box is NEVER blank at the moment it opens - the original complaint");

  // --- 2. real run, real output -------------------------------------------
  const done = await waitForFinish();
  ok(done.out.includes("BUILD ARTEFACT READY"), `the script's own output is shown (${J(done.out.slice(-120))})`);
  ok(/done in \d+s/.test(done.status), `it says it finished, in words and with a duration (${done.status})`);
  ok(done.statusClass.includes("ok"), "and is marked as a success");
  ok(done.out.includes("done in"), "the outcome is repeated at the END of the transcript, where a long build leaves you");
  ok(done.stopDisabled, "Stop is disabled once it is over");
  await closeOverlay();

  // --- 3. a script that prints NOTHING is the worst case -------------------
  // This is the case that looked broken: nothing to read, no clue whether it
  // ran. The transcript must still have a beginning and an end of its own,
  // independent of anything the script chose to print.
  await app.eval(`(() => { showScriptRunOverlay(${J(repo)}, "silent"); return 1; })()`);
  const silent = await waitForFinish();
  ok(silent.out.startsWith("> npm run silent"), "a silent script's transcript still opens with the command");
  ok(
    /> done in \d+s\s*$/.test(silent.out),
    `and still closes with the outcome, so the panel is readable end to end (${J(silent.out.slice(-40))})`
  );
  ok(/done in \d+s/.test(silent.status), `and reports success (${silent.status})`);
  await closeOverlay();

  // --- 4. failure must be readable without knowing exit codes --------------
  await app.eval(`(() => { showScriptRunOverlay(${J(repo)}, "breaks"); return 1; })()`);
  const broke = await waitForFinish();
  ok(/failed after \d+s/.test(broke.status), `a failure says "failed", not just a number (${broke.status})`);
  ok(broke.status.includes("exit code 3"), "with the exit code kept in brackets for when it matters");
  ok(broke.statusClass.includes("fail"), "and is marked as a failure");
  await closeOverlay();

  // --- 5. the menu must say what each name RUNS ----------------------------
  const menu = await app.eval(`(async () => {
    const pill = await repoScriptsPill(${J(repo)});
    if (!pill) { return null; }
    document.body.append(pill);
    pill.click();
    const rows = [...document.querySelectorAll("#contextMenu .item")].map(el => ({
      label: el.childNodes[0]?.textContent || "",
      hint: el.querySelector(".item-hint")?.textContent || "",
    }));
    pill.remove();
    closeContextMenu();
    return rows;
  })()`);
  ok(Array.isArray(menu) && menu.length === 3, `the Scripts pill lists all three scripts (${menu?.length})`);
  ok(
    menu.every((r) => r.hint.length > 0),
    `every entry shows the command it will run, not just its name (${J(menu?.map((r) => r.hint))})`
  );
  ok(
    menu.find((r) => r.label === "breaks")?.hint.includes("node -e"),
    "so picking one is an informed click"
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
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
console.log(
  fails === 0
    ? "\nVERIFY OK: the run overlay says what it is running, that it is alive, and how it ended."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
