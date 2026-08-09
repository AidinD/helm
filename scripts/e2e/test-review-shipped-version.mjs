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
  // `git tag --contains <sha> --sort=v:refname` lists the tags that contain that ONE commit,
  // ascending; the helper takes the first v* as that commit's earliest-containing release,
  // and the WHOLE fix's version is the LATEST of those across all its commits. Per-commit
  // tag lists let us prove that, and prove the answer does not depend on commit order.
  const TAGS = {
    // an early commit: first shipped in v0.1.609
    aaaaaaa: "some-annotation\nv0.1.609\nv0.1.624\nv0.2.0\n",
    // the fix's tip commit: not in a release until v0.1.624
    ccccccc: "v0.1.624\nv0.2.0\n",
    // a commit no release contains yet (valid hex so it survives SHA validation)
    ddddddd: "",
  };
  const asked = [];
  const runFor = (map) => (_p, args) => {
    // args: ["tag", "--contains", <sha>, "--sort=v:refname"]
    const sha = args[2];
    asked.push(sha);
    return map[sha] ?? "";
  };

  // Two released commits, tip LAST: the whole fix shipped in the LATER tag (v0.1.624), not
  // the earlier one - the fix is only fully present once its tip is in a release.
  const tipLast = shippedVersionForCommits(here, ["aaaaaaa old", { sha: "ccccccc" }], { run: runFor(TAGS) });
  ok(tipLast.version === "v0.1.624", `the version is the LATEST of each commit's earliest release, i.e. once the whole fix is in (${JSON.stringify(tipLast.version)})`);

  // SAME commits, order reversed: the answer must not change (order-independent - the bug
  // the earlier .at(-1) had, since the record source is oldest-first but the log fallback is
  // newest-first).
  asked.length = 0;
  const tipFirst = shippedVersionForCommits(here, [{ sha: "ccccccc" }, "aaaaaaa old"], { run: runFor(TAGS) });
  ok(tipFirst.version === "v0.1.624", `reversing the commit order gives the same version (${JSON.stringify(tipFirst.version)})`);
  ok(asked.includes("aaaaaaa") && asked.includes("ccccccc"), `every commit is checked, not just one by position (${JSON.stringify(asked)})`);

  // One commit of the fix is not in any release yet -> the WHOLE fix is not shipped.
  const partly = shippedVersionForCommits(here, ["aaaaaaa old", { sha: "ddddddd" }], { run: runFor(TAGS) });
  ok(partly.version === null && partly.error === null, "if any commit of the fix is unreleased, no version is claimed (and it is not an error)");

  // No tag contains it yet -> null, not an error state.
  const unreleased = shippedVersionForCommits(here, ["deadbee"], { run: () => "" });
  ok(unreleased.version === null && unreleased.error === null, "fully unreleased work shows no version and is not an error");

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
    ? "VERIFY OK: the shipped version is the latest of each commit's earliest containing release (order-independent, null if any commit is unreleased), resolved per-project, and wired IPC->preload->chip."
    : "VERIFY FAILED."
);
process.exit(exit);
