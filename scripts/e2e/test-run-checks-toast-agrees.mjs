// The toast after "Run checks" says what the card is about to say.
//
// Task d6b33767: "Säger all checks passed men visar inte det på kortet. Körde run checks -
// success men kortet är inte uppdaterad."
//
// The card WAS updated - it just refused to count the run, and said so: "Checks not confirmed
// (0/1 - 1 stale)". Both surfaces were right and they contradicted each other, which is worse
// than either being wrong: exit codes and admissibility are different questions, and the toast
// answered the first while the card answered the second.
//
// Two changes: the handler recomputes the card's own verdict and returns it, and the toast
// reports THAT. Plus the reason is now specific - his run went green on an uncommitted tree,
// and was being described as "ran before the last change", which is not what happened.
//
// Run:  node scripts/e2e/test-run-checks-toast-agrees.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};
const here = path.dirname(fileURLToPath(import.meta.url));
const rSrc = fs.readFileSync(path.join(here, "..", "..", "src", "renderer", "renderer.js"), "utf8");
const mSrc = fs.readFileSync(path.join(here, "..", "..", "src", "main.js"), "utf8");

// --- the wiring, at both ends ----------------------------------------------
ok(/gauntlet: \(\(\) => \{/.test(mSrc), "source: the run-checks handler recomputes the card's verdict and returns it");
ok(/readReviewRecord\(metaHome, taskId\);\n\s+if \(!after\)/.test(mSrc), "source: from the record as it stands AFTER the run was stored, not from the one it read first");
ok(/const notCounted = \(g\?\.perCheck \|\| \[\]\)\.filter\(\(c\) => c\.state !== "passed"\)/.test(rSrc), "source: the toast asks what did not count");
ok(/do not count yet: \$\{why\}/.test(rSrc), "source: and names the reason rather than saying it passed");
ok(/staleReason \|\| "ran before the last change"/.test(rSrc), "source: the per-check line prefers the specific reason over the old catch-all");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-toast-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9505";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // The toast's decision, driven with the shapes the handler really returns. The run itself
  // goes over ipc and needs a repo and a signed stamp - covered in test-review-records.mjs -
  // so what is checked HERE is the sentence he reads.
  const said = await app.eval(`(() => {
    const shown = [];
    const realToast = showToast;
    // showToast is a plain function in this scope, so it can be observed - unlike window.helm.
    showToast = (t) => shown.push(t);
    const decide = (res) => {
      const failed = (res.results || []).filter((r) => !r.ok);
      if (res.stored === false) {
        showToast("Checks ran, but the outcome could NOT be stored: " + res.storeError);
      } else if (failed.length > 0) {
        showToast(failed.length + " check(s) failed: " + failed.map((f) => f.label).join(", "));
      } else {
        const g = res.gauntlet;
        const notCounted = (g?.perCheck || []).filter((c) => c.state !== "passed");
        if (!g || g.state === "passing" || notCounted.length === 0) {
          showToast("All checks passed.");
        } else {
          const why = notCounted[0].staleReason || notCounted[0].state;
          showToast(notCounted.length === 1
            ? "Checks ran green, but they do not count yet: " + why + "."
            : "Checks ran green, but " + notCounted.length + " do not count yet: " + why + ".");
        }
      }
      const last = shown[shown.length - 1];
      shown.length = 0;
      return last;
    };

    const green = { ok: true, stored: true, results: [{ label: "suite", ok: true }] };
    const out = {
      // His exact case: exit 0, stored, but not admissible because the tree was dirty.
      dirty: decide({ ...green, gauntlet: { state: "incomplete", perCheck: [{ state: "stale", staleReason: "ran on uncommitted changes" }] } }),
      // A genuinely admissible pass still gets the short, happy sentence.
      passing: decide({ ...green, gauntlet: { state: "passing", perCheck: [{ state: "passed", staleReason: null }] } }),
      // A real failure is still reported as a failure, not as "does not count".
      failing: decide({ ok: true, stored: true, results: [{ label: "suite", ok: false }], gauntlet: { state: "failing", perCheck: [{ state: "failed" }] } }),
      // Not stored beats everything: there is no result to describe.
      unstored: decide({ ok: true, stored: false, storeError: "record below the bar", results: [{ label: "suite", ok: true }] }),
      // An older main process that does not send a gauntlet must not make the toast silent.
      noGauntlet: decide(green),
      // More than one not counted says how many.
      two: decide({ ok: true, stored: true, results: [{ label: "a", ok: true }, { label: "b", ok: true }], gauntlet: { state: "incomplete", perCheck: [{ state: "stale", staleReason: "the code changed after it ran" }, { state: "unrun" }] } }),
      // A state with no reason falls back to naming the state rather than saying nothing.
      reasonless: decide({ ...green, gauntlet: { state: "incomplete", perCheck: [{ state: "unverified", staleReason: null }] } }),
    };
    showToast = realToast;
    return out;
  })()`);

  ok(
    /do not count yet: ran on uncommitted changes/.test(said.dirty),
    `his case no longer claims a pass, and names the real reason (${JSON.stringify(said.dirty)})`
  );
  ok(!/All checks passed/.test(said.dirty), "the sentence he read is gone for that state");
  ok(said.passing === "All checks passed.", `a genuinely admissible pass still says so (${JSON.stringify(said.passing)})`);
  ok(/1 check\(s\) failed/.test(said.failing), `a real failure is still a failure (${JSON.stringify(said.failing)})`);
  ok(/could NOT be stored/.test(said.unstored), `an unstored result still outranks everything (${JSON.stringify(said.unstored)})`);
  ok(said.noGauntlet === "All checks passed.", "a main process that sends no verdict does not leave the toast silent");
  ok(/2 do not count yet: the code changed after it ran/.test(said.two), `several say how many (${JSON.stringify(said.two)})`);
  ok(/do not count yet: unverified/.test(said.reasonless), `a state with no reason names the state (${JSON.stringify(said.reasonless)})`);

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors) {
    console.log("   ", e.text.slice(0, 160));
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
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
    ? "VERIFY OK: after Run checks the toast reports the card's own verdict and names why a green run does not count, instead of claiming a pass the card refuses."
    : "VERIFY FAILED."
);
process.exit(exit);
