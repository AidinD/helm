// The four fixes from Aidin's review of the docs-drift nudge (task 0831417b,
// 2026-07-28). His verdict: "jag vet inte hur jag ska använda den" - of four rows
// on his board exactly ONE was actionable.
//
//   asteroid-wars 252 behind   -> work repo, on leave, can't act
//   loom 15 behind             -> actionable, his own
//   Mina Dokument/Claude       -> "unknown" - but it has NO version control at all
//   meta-snackables-mhe        -> "unknown" - work repo
//
// The underlying reporting failure was mine: I checked that the nudge found REAL
// drift and never asked whether the rows were ACTIONABLE. So:
//   1. no version control  -> not shown at all, and not counted as a failed look
//   2. park a project      -> stop nudging, reversibly
//   3. genuinely unreadable-> say WHICH project and why, not "2 of 14"
//   4. dormant projects    -> age out, or the list only ever grows
//
// Run: node scripts/e2e/test-docs-nudge-noise.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launch } from "./harness.mjs";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-nudge-"));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });

// A real repo whose docs are far behind.
const drifting = path.join(tmp, "drifting");
fs.mkdirSync(drifting, { recursive: true });
git(drifting, "init", "-q");
git(drifting, "config", "user.email", "t@t.t");
git(drifting, "config", "user.name", "t");
fs.writeFileSync(path.join(drifting, "PLAN.md"), "# plan\n");
git(drifting, "add", "-A");
git(drifting, "commit", "-qm", "docs");
for (let i = 0; i < 12; i++) {
  fs.writeFileSync(path.join(drifting, `f${i}.txt`), `${i}`);
  git(drifting, "add", "-A");
  git(drifting, "commit", "-qm", `c${i}`);
}

// Docs, but no version control at all - Aidin's notes folder.
const noVcs = path.join(tmp, "notes-no-vcs");
fs.mkdirSync(noVcs, { recursive: true });
fs.writeFileSync(path.join(noVcs, "DECISIONS.md"), "# decisions\n");

const configPath = path.join(tmp, "config.json");
process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = "9380";

const J = JSON.stringify;

try {
  // --- pure logic first: the candidate filter (fix 2 + fix 4) --------------
  const { docsNudgeCandidates, staleProjectsAsync, DOCS_NUDGE_ACTIVE_DAYS } = await import("../../src/lib/docsStaleness.js");
  const now = Date.UTC(2026, 7, 2);
  const day = 24 * 60 * 60 * 1000;
  const entries = [
    { key: "d:\\repo\\loom", cwd: "D:\\Repo\\loom", touchedAt: now - 2 * day },
    { key: "d:\\repo\\asteroid", cwd: "D:\\Repo\\asteroid", touchedAt: now - 5 * day },
    { key: "d:\\repo\\abandoned", cwd: "D:\\Repo\\abandoned", touchedAt: now - 400 * day },
    { key: "d:\\repo\\nodate", cwd: "D:\\Repo\\nodate", touchedAt: 0 },
  ];

  const plain = docsNudgeCandidates(entries, { now });
  ok(plain.candidates.length === 3, `a project untouched for over a year drops out (${plain.candidates.length} of 4 kept)`);
  ok(plain.dormant === 1, `and is counted, not silently dropped (${plain.dormant})`);
  ok(
    plain.candidates.includes("D:\\Repo\\nodate"),
    "a project with an UNKNOWN last-activity is kept - a gap in the record is not evidence of abandonment"
  );
  ok(DOCS_NUDGE_ACTIVE_DAYS === 60, `the window is stated once, in the lib (${DOCS_NUDGE_ACTIVE_DAYS} days)`);

  const withPark = docsNudgeCandidates(entries, { now, parked: ["D:\\Repo\\Asteroid"] });
  ok(withPark.parked === 1, `a parked project is excluded (${withPark.parked})`);
  ok(
    !withPark.candidates.some((c) => /asteroid/i.test(c)),
    "and really is gone from the sweep"
  );
  ok(
    withPark.candidates.length === plain.candidates.length - 1,
    "parking removes exactly one, not a whole category"
  );
  // Case: he types a path, sessions record another spelling. Windows does not care.
  const casePark = docsNudgeCandidates(entries, { now, parked: ["d:\\REPO\\LOOM"] });
  ok(casePark.parked === 1, "parking matches regardless of how the path is capitalised");

  // --- fix 1 + fix 3 against real folders ---------------------------------
  const swept = await staleProjectsAsync([drifting, noVcs]);
  ok(swept.rows.length === 1, `only the versioned, drifting repo produces a row (${swept.rows.length})`);
  ok(swept.unchecked === 0, `the folder with no version control is NOT "couldn't be checked" (${swept.unchecked})`);
  ok(swept.unversioned === 1, `it is accounted for separately (${swept.unversioned})`);

  // --- the UI (fix 3's naming, and the footnote) ---------------------------
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const named = await app.eval(`(async () => {
    const host = document.createElement("div");
    host.append(await widgetBodyDocsDrift(null, null, async () => ({
      ok: true, rows: [], considered: 5, unchecked: 2, parked: 1, dormant: 3, dormantDays: 60,
      uncheckedPaths: [
        { path: "D:/Repo/broken", name: "broken", reason: "fatal: bad object HEAD" },
        { path: "D:/Repo/gone", name: "gone", reason: "ENOENT" },
      ],
    })));
    return host.textContent;
  })()`);
  ok(/broken/.test(named) && /gone/.test(named), `each unreadable project is NAMED, not counted (${J(named.slice(0, 90))})`);
  ok(!/2 of 5/.test(named), "so the useless '2 of 5 couldn't be checked' line is gone");
  ok(/couldn't read/i.test(named), "and each says it couldn't be read rather than implying it is current");
  ok(/1 parked/.test(named) && /3 untouched for over 60 days/.test(named), `what was left out is stated (${J(named.slice(-80))})`);

  // --- the row has to offer an ACTION -------------------------------------
  // Aidin, twice: "jag vet inte hur jag ska använda den", then "jag vet
  // fortfarande inte vad jag ska göra med denna? Borde det finnas en fix-knapp?"
  // A row that reports a number and offers no way to act on it is noise, however
  // accurate the number is. The Reconcile button writes the job into the composer
  // rather than sending it: this spends real money in a repo.
  const actionable = await app.eval(`(async () => {
    const host = document.createElement("div");
    host.append(await widgetBodyDocsDrift(null, null, async () => ({
      ok: true, considered: 1, unchecked: 0, parked: 0, dormant: 0,
      rows: [{ path: "D:/Repo/Tools/loom", name: "loom", commitsSince: 15, threshold: 8, sessionId: null }],
      uncheckedPaths: [],
    })));
    return {
      buttons: [...host.querySelectorAll("button")].map((b) => b.textContent),
      prompt: docsReconcilePrompt({ commitsSince: 15 }),
    };
  })()`);
  ok(
    actionable.buttons.includes("Reconcile"),
    `a drifting row offers a way to fix it, not just a number (${J(actionable.buttons)})`
  );
  ok(
    actionable.buttons.includes("Park"),
    "and parking is still there for a repo he cannot act on"
  );
  ok(
    /15 commits/.test(actionable.prompt),
    `the job names the actual size of the drift (${J(actionable.prompt.slice(0, 80))})`
  );
  ok(
    /git log/.test(actionable.prompt) && /DECISIONS\.md/.test(actionable.prompt) && /PLAN\.md/.test(actionable.prompt),
    "and spells out how to find the range and what goes in each file - a vague prompt just moves the not-knowing one step right"
  );
  ok(
    /NOT a changelog/i.test(actionable.prompt),
    "including the trap: DECISIONS.md is not a changelog of commits, git already has those"
  );

  // A project that could not be READ gets no Reconcile button: there is nothing
  // to reconcile against, and offering the action would spend money to find out.
  const unreadableRow = await app.eval(`(async () => {
    const host = document.createElement("div");
    host.append(await widgetBodyDocsDrift(null, null, async () => ({
      ok: true, rows: [], considered: 1, unchecked: 1, parked: 0, dormant: 0,
      uncheckedPaths: [{ path: "D:/Repo/broken", name: "broken", reason: "fatal: bad object HEAD" }],
    })));
    return [...host.querySelectorAll("button")].map((b) => b.textContent);
  })()`);
  ok(
    !unreadableRow.includes("Reconcile"),
    `an unreadable project is not offered a fix (${J(unreadableRow)})`
  );

  // The safety net must survive: a payload with a COUNT but no names still must
  // not render as the all-clear. This is the property the old test protected.
  const countOnly = await app.eval(`(async () => {
    const host = document.createElement("div");
    host.append(await widgetBodyDocsDrift(null, null, async () => ({ ok: true, rows: [], considered: 9, unchecked: 3, uncheckedPaths: [] })));
    return host.textContent;
  })()`);
  ok(
    /3 of 9/.test(countOnly) && !/Docs are current/i.test(countOnly),
    `a count with no names still never claims all-clear (${J(countOnly)})`
  );

  // --- park round trip, through the real IPC -------------------------------
  const before = await app.eval(`window.helm.parkedDocsProjects()`);
  ok((before?.parked || []).length === 0, "nothing is parked to begin with");
  const parkRes = await app.eval(`window.helm.parkDocsProject(${J(drifting)}, true)`);
  ok(parkRes?.ok === true && parkRes.parked === 1, `parking succeeds and reports the new total (${J(parkRes)})`);
  const after = await app.eval(`window.helm.parkedDocsProjects()`);
  ok((after?.parked || []).length === 1, `the parked project is listed so it can be undone (${J(after?.parked)})`);
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  ok((cfg.parkedDocsProjects || []).length === 1, "it survives a restart (it is in config, not memory)");

  const unpark = await app.eval(`window.helm.parkDocsProject(${J(drifting)}, false)`);
  ok(unpark?.ok === true && unpark.parked === 0, `un-parking puts it back (${J(unpark)})`);
  const bad = await app.eval(`window.helm.parkDocsProject(null, true)`);
  ok(bad?.ok === false, "parking with no path is refused rather than writing junk");

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
    ? "\nVERIFY OK: the nudge shows only rows he can act on, names what it couldn't read, and says what it left out."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
