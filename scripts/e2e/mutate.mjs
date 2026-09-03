// Mutation testing, as one helper instead of a fresh script every time.
//
// The discipline this encodes is the one that has found the most real defects here: break the
// code deliberately and watch the check go red. A check nobody has watched fail is not
// evidence, and several guards in this suite were green against broken code until somebody
// mutated them.
//
// It exists because the same 30 lines were written by hand a dozen times in one day, and got
// three DIFFERENT things wrong in the process - each of which made a run lie:
//
//   NON-UNIQUE ANCHOR   `String.replace` takes the FIRST match. An anchor that appears more
//                       than once mutated an unrelated call site, the guard stayed green, and
//                       it was reported as worthless when it was fine. Anchors are required to
//                       be unique here, and a duplicate is an error rather than a coin flip.
//
//   BROKEN MUTANT       a mutation that leaves the file unparseable makes every check fail for
//                       the wrong reason, which reads exactly like a working guard. The mutant
//                       is syntax-checked before the run counts.
//
//   NO-OP MUTATION      an anchor that is not present at all replaces nothing, the run is
//                       green, and that looks identical to a guard that does not catch the
//                       defect. Refused up front.
//
// And the thing every hand-rolled version got right but only by remembering: the original is
// restored in a `finally` and verified by hash, because these files are shared with other
// sessions and a half-mutated source left behind is worse than no mutation run at all.
//
// SURVIVED IS THE FINDING. A mutation that does not turn the check red is the whole point of
// running one: it says the guard does not cover that defect. This reports survivors as the
// headline rather than burying them, and exits non-zero, so a mutation run cannot be read as
// "fine" when nothing was actually being protected.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * @typedef {object} Mutation
 * @property {string} label   What this breaks, in a few words. Printed as-is.
 * @property {string} file    Repo-relative path to mutate.
 * @property {string} from    The exact text to replace. MUST occur exactly once.
 * @property {string} to      What to put there.
 */

/**
 * Run each mutation, run the checks, restore, and report which mutations SURVIVED.
 *
 * @param {object} args
 * @param {string} args.repo        Absolute path to the repository root.
 * @param {string[]} args.checks    Repo-relative test files to run for each mutation.
 * @param {Mutation[]} args.mutations
 * @param {Record<string,string>} [args.env] Extra environment for the checks.
 * @returns {{survived: Mutation[], killed: Mutation[], refused: {mutation: Mutation, why: string}[]}}
 */
export function runMutations({ repo, checks, mutations, env = {} }) {
  const originals = new Map();
  const survived = [];
  const killed = [];
  const refused = [];

  const readFile = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
  const writeFile = (rel, body) => fs.writeFileSync(path.join(repo, rel), body);

  const runChecks = () => {
    const failures = [];
    for (const check of checks) {
      const r = spawnSync(process.execPath, [path.join(repo, check)], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      const lines = String(r.stdout || "").split("\n").filter((l) => l.startsWith("FAIL"));
      if (r.status !== 0) {
        failures.push({ check, count: lines.length, first: (lines[0] || "(no FAIL line - it may have thrown)").slice(0, 160) });
      }
    }
    return failures;
  };

  try {
    for (const m of mutations) {
      let source;
      try {
        source = readFile(m.file);
      } catch (err) {
        refused.push({ mutation: m, why: `cannot read ${m.file}: ${err.message}` });
        continue;
      }
      if (!originals.has(m.file)) {
        originals.set(m.file, source);
      }

      // Uniqueness, before anything else. This is the failure that reports a good guard as bad.
      const hits = source.split(m.from).length - 1;
      if (hits === 0) {
        refused.push({ mutation: m, why: "the anchor does not appear in the file - the mutation would change nothing, and a green run would mean nothing" });
        continue;
      }
      if (hits > 1) {
        refused.push({ mutation: m, why: `the anchor appears ${hits} times - replace() would take the first, which may not be the one you mean. Make it unique.` });
        continue;
      }

      writeFile(m.file, source.replace(m.from, m.to));

      // A mutant that does not parse fails every check for the wrong reason - but ONLY files
      // node can parse get this gate. The first version ran `node --check` on everything and
      // refused a perfectly good mutation of a YAML workflow with an unknown-extension error.
      // Found by using this helper on real work rather than on its own fixture, and worth
      // saying: refusing a VALID mutation is the same class of lie as accepting a broken one,
      // because the run reports nothing while looking like it reported something.
      if (/\.(js|mjs|cjs)$/.test(m.file)) {
        const parsed = spawnSync(process.execPath, ["--check", path.join(repo, m.file)], { encoding: "utf8" });
        if (parsed.status !== 0) {
          writeFile(m.file, source);
          refused.push({ mutation: m, why: `the mutated file does not parse, so a red run would prove nothing: ${String(parsed.stderr || "").split("\n")[1] || ""}`.trim() });
          continue;
      }
      }

      const failures = runChecks();
      writeFile(m.file, source);

      if (failures.length === 0) {
        survived.push(m);
      } else {
        killed.push({ ...m, failures });
      }
    }
  } finally {
    // Restored whatever happened, and verified rather than assumed - these files are shared
    // with other sessions and a half-mutated source is worse than no run at all.
    for (const [rel, body] of originals) {
      writeFile(rel, body);
      const back = readFile(rel);
      if (sha(back) !== sha(body)) {
        throw new Error(`RESTORE FAILED for ${rel} - the file on disk does not match what was read. Fix it by hand before doing anything else.`);
      }
    }
  }

  return { survived, killed, refused };
}

/**
 * Run them and print a report. Returns the process exit code to use: non-zero if any mutation
 * survived or was refused, because both mean the run did not prove what it looks like it did.
 */
export function reportMutations(result) {
  const { survived, killed, refused } = result;
  for (const k of killed) {
    const f = k.failures[0];
    console.log(`KILLED   ${k.label}`);
    console.log(`         ${f.check}: ${f.count} failing - ${f.first.replace(/^FAIL\s*-\s*/, "")}`);
  }
  for (const r of refused) {
    console.log(`REFUSED  ${r.mutation.label}`);
    console.log(`         ${r.why}`);
  }
  for (const s of survived) {
    console.log(`SURVIVED ${s.label}`);
    console.log(`         nothing went red, so no check covers this defect`);
  }
  console.log("");
  const bad = survived.length + refused.length;
  console.log(
    bad === 0
      ? `all ${killed.length} mutation(s) killed - every one of these defects is covered`
      : `${killed.length} killed, ${survived.length} SURVIVED, ${refused.length} refused - a survivor is a gap in the checks, not a pass`
  );
  return bad === 0 ? 0 : 1;
}
