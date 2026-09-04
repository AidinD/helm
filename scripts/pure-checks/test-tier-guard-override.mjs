/**
 * The tier guard needs a way out, and it must not be one the guarded session can take.
 *
 * The policy is a positive list, which guarantees false blocks - nine were measured and
 * fixed before it shipped, and the next one turns up mid-work. Until now the only way
 * past one was to edit the source and restart Helm. A guard with no escape hatch is a
 * guard that gets deleted at the first irritation, and then everything built around it
 * was built for nothing.
 *
 * So the hatch exists. Everything here is about the three properties that make it a hatch
 * rather than a hole:
 *
 *   IT CANNOT BE OPENED FROM INSIDE. Read from Helm's own process environment, never from
 *   a file. A supervised agent can write files; a guard it can switch off by editing a
 *   config value is decoration. This is the property that matters, and the one a future
 *   edit is most likely to break for convenience.
 *
 *   IT IS NEVER SILENT. A guard that is off without saying so is worse than no guard,
 *   because everything downstream still reads as supervised.
 *
 *   IT MEANS ONE THING. Exactly "1". A stray or empty value must read as off, not as an
 *   intention somebody half-expressed.
 *
 * The hook is driven for real - spawned, fed a payload, its answer read - rather than
 * asserted against its source. What it decides is the whole point of it.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

let failures = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    failures += 1;
  }
};

const HOOK = new URL("../../src/hooks/tierGuardHook.mjs", import.meta.url).pathname.replace(/^\//, "");
const WRITE_CALL = JSON.stringify({ tool_name: "Write", tool_input: { file_path: "x.txt" }, session_id: "s" });

// execFileSync only hands back stderr when the child throws, and this hook always exits
// 0 - so the quiet path needs its stderr captured to a file to be readable at all.
function runHook(env) {
  const errFile = new URL("./.tier-override-stderr.tmp", import.meta.url).pathname.replace(/^\//, "");
  const fd = fs.openSync(errFile, "w");
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [HOOK], {
      input: WRITE_CALL,
      encoding: "utf8",
      env: { ...process.env, HELM_TIER_OVERRIDE: "", ...env },
      stdio: ["pipe", "pipe", fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  const stderr = fs.readFileSync(errFile, "utf8");
  fs.rmSync(errFile, { force: true });
  return { stdout, stderr };
}

const denied = (r) => r.stdout.includes('"permissionDecision":"deny"');

// --- the guard still guards -------------------------------------------------------
{
  const r = runHook({ HELM_TIER: "first-mate" });
  ok(denied(r), "with no override, a first mate is still refused a write");
  ok(r.stderr.trim() === "", "and says nothing on stderr while it is enforcing");
}

// --- the hatch opens --------------------------------------------------------------
{
  const r = runHook({ HELM_TIER: "first-mate", HELM_TIER_OVERRIDE: "1" });
  ok(!denied(r), "with the override set, the same call is allowed");
  ok(/OVERRIDDEN/.test(r.stderr), "and it says so, loudly", r.stderr.trim().slice(0, 58));
  ok(/NOT being checked/.test(r.stderr), "in words that name the consequence rather than the flag");
}

// --- it means exactly one thing ----------------------------------------------------
{
  for (const value of ["0", "", "true", "yes", "on", " 1", "1 "]) {
    const r = runHook({ HELM_TIER: "first-mate", HELM_TIER_OVERRIDE: value });
    ok(denied(r), `HELM_TIER_OVERRIDE=${JSON.stringify(value)} does NOT open the hatch`);
  }
}

// --- and it cannot be opened from inside ------------------------------------------
// The property everything rests on. It is a statement about WHERE a value is read from,
// which running the hook cannot show: the hook cannot tell whether its env came from
// Helm's process or from a file somebody edited.
//
// The first version searched the WHOLE file for `process.env.HELM_TIER_OVERRIDE` and for
// the absence of a lowercase "config" near the name. Both passed when the pass-through
// was deliberately switched to loadConfig() - the first matched a different line that
// still had it, and "loadConfig" is not "config". A check over the whole haystack says
// nothing about one needle, so this pins the single line that decides it.
{
  const main = fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
  // Comments stripped first. The reasoning around this line names config.json repeatedly,
  // and a check that can be satisfied by prose is satisfied by prose.
  const code = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const passThrough = code.split("\n").filter((l) => l.includes('{ HELM_TIER_OVERRIDE: "1" }'));
  ok(passThrough.length === 1, "exactly one line hands the override to a launch", `${passThrough.length} found`);

  const line = passThrough[0] || "";
  ok(/process\.env\.HELM_TIER_OVERRIDE === "1"/.test(line), "and it reads Helm's own process env", line.trim().slice(0, 66));
  // The failure this exists to prevent: moving it to config for convenience, handing the
  // switch to every agent that can write a file. Case-insensitive, because the first
  // attempt missed `loadConfig` by looking for a lowercase c.
  ok(!/config/i.test(line), "and never a file a guarded session could edit", line.trim().slice(0, 66));
}

// --- being off has to keep announcing itself ---------------------------------------
{
  const main = fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
  ok(/tierGuardOverridden: process\.env\.HELM_TIER_OVERRIDE === "1"/.test(main), "the app reports whether the guard is off");

  const renderer = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  ok(/data\.tierGuardOverridden && !tierGuardWarned/.test(renderer), "and the window says so when it is");
  ok(/The tier guard is OFF/.test(renderer), "in plain words");
  ok(/tierGuardWarned = true/.test(renderer), "once per Helm run, not once per poll - a warning nobody reads is not a warning");
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: the guard has a way out that only the captain can open, and it never opens quietly.");
