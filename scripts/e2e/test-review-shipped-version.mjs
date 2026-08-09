// A review record shows which released version its fix is out in - if versioned.
//
// Task 860b4661: "review - borde visa vilken version fixen finns ute i om versionerad".
// The version a fix shipped in is the EARLIEST released tag that contains the fix's last
// commit (once the newest commit of a fix is in a release, the whole fix is). This is a
// per-project git-tag read, so it works for any tagged repo and returns nothing for one
// that does not tag - which is exactly "if versioned".
//
// The git call is injected so this is deterministic and needs no repo.
//
// Run:  node scripts/e2e/test-review-shipped-version.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shippedVersionForCommits } from "../../src/lib/reviewDiff.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

// An existing folder (the function guards on fs.existsSync before shelling out).
const here = os.tmpdir();

try {
  // `git tag --contains --sort=v:refname` lists containing tags ascending; the helper takes
  // the first v* as the earliest release. The fake records which sha it was asked about so
  // we can prove it uses the LAST commit.
  let askedSha = null;
  const fakeRun = (_p, args) => {
    // args: ["tag", "--contains", <sha>, "--sort=v:refname"]
    askedSha = args[2];
    // Ascending, with a stray non-version tag that must be ignored.
    return "some-annotation\nv0.1.609\nv0.1.624\nv0.2.0\n";
  };

  const res = shippedVersionForCommits(here, ["aaaaaaa first", { sha: "bbbbbbb" }, "ccccccc last"], { run: fakeRun });
  ok(res.version === "v0.1.609", `the EARLIEST containing release is chosen (${JSON.stringify(res.version)})`);
  ok(askedSha === "ccccccc", `it asks about the LAST commit of the fix (${JSON.stringify(askedSha)})`);

  // No tag contains it yet -> null, not an error state.
  const unreleased = shippedVersionForCommits(here, ["deadbee"], { run: () => "" });
  ok(unreleased.version === null && unreleased.error === null, "unreleased work shows no version and is not an error");

  // No commit pinned -> null with a reason.
  const noCommit = shippedVersionForCommits(here, [], { run: () => "should-not-run" });
  ok(noCommit.version === null && !!noCommit.error, "a record pinning no commit yields null with a reason");

  // A repo path that does not exist -> null (nothing to read).
  const gone = shippedVersionForCommits(path.join(here, "definitely-not-here-" + Math.random().toString(36).slice(2)), ["abc1234"], { run: () => "v9.9.9" });
  ok(gone.version === null, "a missing project folder yields null");

  // git failing (not a repo, git absent) -> null, swallowed.
  const errored = shippedVersionForCommits(here, ["abc1234"], {
    run: () => {
      throw new Error("fatal: not a git repository");
    },
  });
  ok(errored.version === null, "a git failure is swallowed to null, never thrown");

  // Wiring: the IPC, its preload bridge and the renderer chip must all exist, or the value
  // never reaches the page.
  const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const mainSrc = read("../../src/main.js");
  const preloadSrc = read("../../src/preload.cjs");
  const rendererSrc = read("../../src/renderer/renderer.js");
  ok(/ipcMain\.handle\("reviews:shippedVersion"/.test(mainSrc), "main exposes the reviews:shippedVersion IPC");
  ok(/shippedVersionForCommits/.test(mainSrc), "and it uses the tag helper");
  ok(/getShippedVersion:\s*\(taskId\)\s*=>\s*ipcRenderer\.invoke\("reviews:shippedVersion"/.test(preloadSrc), "preload bridges getShippedVersion");
  ok(/getShippedVersion\(rec\.taskId\)/.test(rendererSrc), "the review record renders the shipped-version chip from the IPC");
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
}

console.log(
  exit === 0
    ? "VERIFY OK: the shipped version is the earliest release tag containing the fix's last commit, resolved per-project, null when unreleased, and wired IPC->preload->chip."
    : "VERIFY FAILED."
);
process.exit(exit);
