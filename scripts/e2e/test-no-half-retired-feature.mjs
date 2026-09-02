// A retirement is complete across all four layers, or it is not a retirement.
//
// Non-repo "domain" projects were retired on 2026-09-02. The reason they needed retiring is
// the point of this check: the registration control had vanished from the renderer at some
// earlier date, and everything behind it stayed. `registerDomain` and `dialog:pickDomainFolder`
// were still handled in main, still bridged in the preload, still implemented in domains.js -
// so reading any one of those files told you the feature existed, and it had been impossible
// to use for weeks. The linter's first run found it; nothing else had.
//
// So this does not assert "the code is gone" as a tidiness rule. It asserts that the four
// layers AGREE, because the defect was disagreement between them:
//
//   domains.js  no writer
//   main.js     no handler, and the import narrowed to what is left
//   preload     no bridge
//   renderer    no caller, and no comment promising one
//
// Putting any single piece back turns this red, which is what makes the decision durable
// rather than a note somebody has to remember. The read path is asserted to SURVIVE in the
// same breath, because retiring the reader would have been a different and larger decision:
// an existing registry, written by hand or by an older build, still resolves as a project.
import fs from "node:fs";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
// Comments are stripped before asserting absence. Without this, commenting the feature out -
// or the explanatory note this retirement deliberately leaves behind - would read as the
// feature still being here. That confusion is failure 2 on the review checklist.
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const domains = code("src/lib/domains.js");
const main = code("src/main.js");
const preload = code("src/preload.cjs");
const renderer = code("src/renderer/renderer.js");

// --- the writers are gone, the reader is not ----------------------------------------------
ok(!/export function registerDomain/.test(domains), "domains.js has no registerDomain");
ok(!/export function removeDomain/.test(domains), "and no removeDomain");
ok(/export function loadDomains/.test(domains), "but loadDomains SURVIVES - an existing registry still resolves as a project");
ok(!/writeJsonAtomicSync|writeDomains/.test(domains), "and nothing in it can write, including a helper left behind with no caller");

// --- main answers no domain channel, and its import says so -------------------------------
for (const channel of ["domains:register", "domains:remove", "domains:list", "dialog:pickDomainFolder"]) {
  ok(!main.includes(`"${channel}"`), `main.js does not handle "${channel}"`);
}
ok(/import \{ loadDomains \} from ".\/lib\/domains.js"/.test(main), "and main.js imports ONLY loadDomains, so the narrowing is visible at the top of the file");
ok(/loadDomains\(\)/.test(main), "which it still calls, or the surviving read would be dead too");

// --- the bridge is gone -------------------------------------------------------------------
for (const bridge of ["registerDomain", "removeDomain", "listDomains", "pickDomainFolder"]) {
  ok(!new RegExp(`\\b${bridge}\\s*:`).test(preload), `the preload does not bridge ${bridge}`);
}

// --- the renderer neither calls it nor promises it -----------------------------------------
ok(!/promptRegisterDomain/.test(renderer), "the renderer has no promptRegisterDomain");
ok(!/dashboardSelectedChip/.test(renderer), "nor the write-only variable that belonged to it");
for (const bridge of ["registerDomain", "pickDomainFolder", "listDomains", "removeDomain"]) {
  ok(!new RegExp(`window\\.helm\\.${bridge}\\b`).test(renderer), `and does not call window.helm.${bridge}`);
}

// --- the prose does not describe a mechanism that is gone ----------------------------------
// This is the failure class the retirement belongs to, so the check covers the retirement's
// OWN paperwork. A comment that still says "no async listDomains here, to keep the palette
// instant" describes a tradeoff against a bridge that no longer exists, which is a smaller
// version of exactly the problem being closed.
const rendererProse = read("src/renderer/renderer.js");
ok(
  !/no async listDomains here/.test(rendererProse),
  "no comment still weighs a tradeoff against a bridge that was removed"
);
// The explanatory notes are REQUIRED, not merely tolerated: without them the next reader sees
// absence and cannot tell a decision from an omission, which is how this feature decayed the
// first time.
ok(/retired/i.test(read("src/lib/domains.js")), "domains.js says the read-only state is a decision, not an accident");
ok(/retired/i.test(read("src/main.js")), "and main.js says why its handlers are absent");

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: the domain feature is retired at every layer, the read path survives, and no prose promises the rest."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
