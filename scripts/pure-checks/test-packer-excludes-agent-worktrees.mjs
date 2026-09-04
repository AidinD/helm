/**
 * No agent worktree ends up inside the installer - at ANY depth.
 *
 * ## What this is guarding
 *
 * Build 0.2.78 shipped an installed Helm that would not start and could not say
 * why: GUI-subsystem Electron has nowhere to print, so the exe exited 1 with no
 * window and nothing in the event log. The cause was `.claude/worktrees/...`
 * being packed while an agent was working inside it. electron-builder writes the
 * asar header from a directory scan and streams the contents in a second pass,
 * so one file changing size between the two put all 834 files after it at the
 * wrong offset - including src/main.js. See DECISIONS.md, 2026-08-20.
 *
 * Two fixes came out of that. `scripts/verifyAsar.mjs` re-hashes every packed
 * file against the header, which turns the failure into a refused build, and it
 * is the one that generalises. The other was an exclusion, `!.claude/**\/*`, and
 * it named the directory that happened to bite rather than the class.
 *
 * ## Which is why this check exists
 *
 * Measured in the v0.2.139 installer on 2026-09-01: 109 files from
 * `node_modules/keel/.claude/worktrees/silly-khayyam-855151` were inside the
 * asar. A root-anchored exclusion never matched them. Nothing was corrupt - the
 * verifier passed - but a live worktree in a dependency is the same loaded gun,
 * and Helm's repo is public, so whatever sits in one is downloadable by anyone.
 *
 * The check is on the pattern rather than on a built archive, deliberately:
 * asserting against `dist/` only works after a build, on the machine that built
 * it, and would pass on any checkout where nobody happens to have a worktree
 * open. This fails the moment the pattern goes back to being root-anchored.
 *
 * Run: node scripts/e2e/test-packer-excludes-agent-worktrees.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const files = pkg.build?.files ?? [];
ok(files.length > 0, "the packer has a file list to check", `${files.length} patterns`);

// The exclusions that must hold at any depth, because the directories they name
// are written by tooling that can run in a dependency as easily as here.
const MUST_BE_DEPTH_INDEPENDENT = [".claude"];

for (const dir of MUST_BE_DEPTH_INDEPENDENT) {
  const negations = files.filter((p) => p.startsWith("!") && p.includes(`${dir}/`));
  ok(negations.length > 0, `${dir}/ is excluded from the package at all`, negations.join(", "));
  // A pattern anchored at the root - "!.claude/**/*" - is the bug. electron-builder
  // uses minimatch, where a leading "**/" is what makes a segment match at depth.
  const anchoredOnly = negations.length > 0 && negations.every((p) => !p.startsWith(`!**/${dir}/`));
  ok(
    !anchoredOnly,
    `and the exclusion matches ${dir}/ inside dependencies too, not only at the repo root`,
    anchoredOnly ? `only root-anchored: ${negations.join(", ")}` : negations.join(", ")
  );
}

// The integrity check is the general fix and must stay wired to the one hook
// that runs before NSIS and before publish - the only seam where refusing means
// the broken installer never exists.
{
  const afterPack = path.join(repoRoot, "scripts", "afterPack.mjs");
  ok(fs.existsSync(afterPack), "the afterPack hook is still present");
  const configured = JSON.stringify(pkg.build?.afterPack ?? "");
  ok(/afterPack/.test(configured), "and electron-builder is still pointed at it", configured);
  const src = fs.existsSync(afterPack) ? fs.readFileSync(afterPack, "utf8") : "";
  ok(/verifyAsar/.test(src.replace(/^\s*\/\/.*$/gm, "")), "and it still runs the asar verifier");
}

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: a live agent worktree cannot be packed, wherever it sits.");
