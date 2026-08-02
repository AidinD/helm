// The test runner Helm did not have.
//
// Until 2026-08-02 there was no `npm test` and no runner script: "the suite" was
// whatever anyone remembered to run. That is exactly how four tests ended up
// failing, or passing for the wrong reason, without anyone noticing - flagged by
// the pre-release review as the gap that let the other gaps hide.
//
//   node scripts/run-tests.mjs --fast    only the tests that don't launch Electron
//   node scripts/run-tests.mjs           everything (slow: one app launch per file)
//   node scripts/run-tests.mjs docs jot  only files whose name matches a term
//
// Fast tests run concurrently (they are pure node). App tests run ONE AT A TIME on
// purpose: each launches a real Electron window and several pin a fixed debug port,
// so running them in parallel makes them fight over ports and focus.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eDir = path.join(here, "e2e");
const repo = path.join(here, "..");

const args = process.argv.slice(2);
const fastOnly = args.includes("--fast");
const terms = args.filter((a) => !a.startsWith("--"));

// A test "launches the app" if it imports the CDP harness.
const all = fs
  .readdirSync(e2eDir)
  .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
  .filter((f) => terms.length === 0 || terms.some((t) => f.includes(t)))
  .map((f) => {
    const src = fs.readFileSync(path.join(e2eDir, f), "utf8");
    return { file: f, launches: /harness\.mjs/.test(src) };
  });

const fast = all.filter((t) => !t.launches);
const slow = fastOnly ? [] : all.filter((t) => t.launches);

// --- a syntax gate first: cheapest possible check, and the renderer is 14k lines
const SYNTAX_TARGETS = ["src/main.js", "src/renderer/renderer.js", "src/preload.cjs"];

function run(cmd, cmdArgs, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: repo, shell: false, windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve({ code: 124, out: out + "\n[timed out]" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const failures = [];
const started = process.hrtime.bigint();
const secs = () => Number(process.hrtime.bigint() - started) / 1e9;

console.log("--- syntax ---");
for (const target of SYNTAX_TARGETS) {
  const r = await run(process.execPath, ["--check", target], 30000);
  console.log(`${r.code === 0 ? "ok  " : "FAIL"}  ${target}`);
  if (r.code !== 0) {
    failures.push({ file: target, out: r.out });
  }
}
if (failures.length) {
  // A syntax error makes every app test fail for the same uninformative reason.
  console.log("\nSyntax errors - stopping before the suite.");
  for (const f of failures) {
    console.log(f.out.slice(0, 800));
  }
  process.exit(1);
}

console.log(`\n--- ${fast.length} fast tests (concurrent) ---`);
const fastResults = await Promise.all(
  fast.map(async (t) => ({ t, r: await run(process.execPath, [path.join("scripts", "e2e", t.file)], 120000) }))
);
for (const { t, r } of fastResults) {
  console.log(`${r.code === 0 ? "ok  " : "FAIL"}  ${t.file}`);
  if (r.code !== 0) {
    failures.push({ file: t.file, out: r.out });
  }
}

if (slow.length) {
  console.log(`\n--- ${slow.length} app tests (one at a time, ~15-30s each) ---`);
  let i = 0;
  for (const t of slow) {
    i += 1;
    const r = await run(process.execPath, [path.join("scripts", "e2e", t.file)], 300000);
    console.log(`${r.code === 0 ? "ok  " : "FAIL"}  [${i}/${slow.length}] ${t.file}`);
    if (r.code !== 0) {
      failures.push({ file: t.file, out: r.out });
    }
  }
}

// Count what RAN, not what exists - in --fast mode the app tests were never
// started, and reporting them as passed is the kind of green that means nothing.
const ran = fast.length + slow.length;
const skipped = all.length - ran;
console.log(
  `\n=== ${ran - failures.length}/${ran} passed in ${secs().toFixed(0)}s` +
    (skipped ? ` (${skipped} app tests NOT run - use \`npm test\` for the full sweep)` : "") +
    " ==="
);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`\n########## ${f.file}`);
    // The tail is where the assertion lines and the verdict are.
    console.log(f.out.split("\n").slice(-25).join("\n"));
  }
}
process.exit(failures.length ? 1 : 0);
