/**
 * The linter runs, is clean, and is still asking the two questions it was added for.
 *
 * ## Why the repo has one now
 *
 * The crew tier guard shipped on 2026-08-31 with `runIteration` reading a `guard` it was
 * never given. A free variable, so every crew iteration threw ReferenceError before it
 * spawned anything and the whole goal-run feature was dead from the moment it landed.
 * `--fast` was 125/125 green throughout, and it was found by reading a run record.
 *
 * test-no-undefined-calls.mjs had already written the conclusion in its own header: this
 * repo has no lint of any kind, so a class of error a linter catches in milliseconds could
 * only be caught by running the app.
 *
 * On its first run eslint found a second instance of exactly that shape, untouched in
 * `fireRoutine`: `launchId` was declared inside the `try` and used in the `catch`, so the
 * cleanup that catch exists for - "a misconfigured routine leaves a dead launching entry
 * behind on every scheduled fire, forever", in its own words - had never once run. Two
 * ReferenceErrors of the same family, one of them years-old, both invisible to 265 checks.
 *
 * ## What this check is for
 *
 * `npm run lint` being clean is worth pinning, but it is the weaker half. The stronger half
 * is that the CONFIGURATION still asks the right questions: a linter quietly downgraded to
 * warnings, or pointed at the wrong globals, reports clean while seeing nothing - which is
 * indistinguishable from a healthy repo and is how a guard stops guarding.
 *
 * Run: node scripts/e2e/test-lint-clean.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");

// --- the config still asks the two questions ------------------------------------------------
{
  const { default: config } = await import(path.join(repo, "eslint.config.mjs").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
  const blocks = config.filter((b) => b.rules);
  ok(blocks.length >= 2, `the config covers more than one environment (${blocks.length} rule blocks)`);
  for (const block of blocks) {
    const files = (block.files || []).join(", ");
    ok(block.rules["no-undef"] === "error", `no-undef is an ERROR, not a warning, for ${files}`);
    const unused = block.rules["no-unused-vars"];
    ok(Array.isArray(unused) ? unused[0] === "error" : unused === "error", `no-unused-vars is an ERROR for ${files}`);
  }
  // Getting the environment wrong is how a linter starts lying in the expensive direction:
  // browser globals in Node would hide a genuine undefined.
  const node = blocks.find((b) => (b.files || []).some((f) => f.startsWith("src/**")));
  const renderer = blocks.find((b) => (b.files || []).some((f) => f.startsWith("src/renderer/")));
  ok(!!node && !!renderer, "the Node tree and the renderer are configured separately");
  ok(!!node && !node.languageOptions.globals.document, "the Node tree does not get browser globals");
  ok(!!renderer && !renderer.languageOptions.globals.__dirname, "and the renderer does not get Node globals");
  // renderer.js is a classic script, not a module - its own header says so, and every
  // cross-file reference in it would read as undefined under sourceType "module".
  ok(!!renderer && renderer.languageOptions.sourceType === "script", "the renderer is linted as a classic script, which is what it is");
}

// --- every disable directive says WHY -----------------------------------------------------------
{
  // A bare `eslint-disable-next-line no-unused-vars` is a silent exception. The two in this
  // repo are deliberate and both carry the reason after `--`; requiring that is what stops
  // the next one being added without one.
  const bad = [];
  for (const dir of ["src", "scripts", "worker"]) {
    const root = path.join(repo, dir);
    if (!fs.existsSync(root)) {
      continue;
    }
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") {
            walk(full);
          }
          continue;
        }
        if (!/\.(js|mjs)$/.test(entry.name)) {
          continue;
        }
        const text = fs.readFileSync(full, "utf8");
        for (const line of text.split(/\r?\n/)) {
          // Anchored at the START of the comment, so prose ABOUT a directive - including
          // the sentence a few lines above this loop - is not mistaken for one. A real
          // directive is the whole comment; a mention of one is not.
          if (!/^\s*(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b/.test(line)) {
            continue;
          }
          if (!/--\s*\S/.test(line)) {
            bad.push(`${path.relative(repo, full)}: ${line.trim().slice(0, 90)}`);
          }
        }
      }
    };
    walk(root);
  }
  for (const b of bad) {
    console.log(`     ${b}`);
  }
  ok(bad.length === 0, "every eslint-disable states its reason after `--`");
}

// --- and it is actually clean ---------------------------------------------------------------------
{
  // The binary, resolved rather than invoked through npx. `npx eslint` on a machine that has
  // not installed it goes to the registry to fetch it, and with no terminal to answer for it
  // that turned a 13-second check into one that hit the runner's 120-second timeout on every
  // push - a red pure lane for a day, whose cause was a MISSING TOOL rather than a lint error.
  // A check that cannot tell those two apart is worse than one that does not run.
  const bin = path.join(repo, "node_modules", ".bin", process.platform === "win32" ? "eslint.cmd" : "eslint");
  if (!fs.existsSync(bin)) {
    // Said in the runner's own self-skip form, so it is reported as skipped and named at the
    // end of a run rather than counted as a pass. A lane that has not linted must not look
    // like a lane that linted and found nothing.
    console.log("SKIPPED - eslint is not installed here, so this check cannot say whether the tree is clean. Run npm install, or install eslint in the job that runs this.");
    process.exit(0);
  }
  let output = "";
  let failed = false;
  try {
    // Default formatter: `compact` was dropped from core eslint, and asking for one that is
    // not installed fails in a way that reads exactly like a lint failure.
    output = execFileSync(bin, ["."], { cwd: repo, encoding: "utf8", shell: true, windowsHide: true });
  } catch (err) {
    failed = true;
    output = `${err.stdout || ""}${err.stderr || ""}`;
  }
  if (failed) {
    console.log(output.trim().split(/\r?\n/).slice(0, 20).join("\n"));
  }
  ok(!failed, "npm run lint is clean");
}

console.log("");
console.log(exit === 0 ? "VERIFY OK: the linter runs, is clean, and still asks the questions it was added for." : "VERIFY FAILED.");
process.exit(exit);
