// Auto-update is switched ON, and the thing it depends on is really reachable.
//
// This exists because auto-update was OFF for months on a belief nobody re-checked.
// initAutoUpdate returned early unless GH_TOKEN was set, on the stated grounds that
// AidinD/helm is private. It is public. So every packaged build shipped unable to update
// itself and logged "auto-update parked" instead - a feature that was present, documented,
// and doing nothing.
//
// Two halves, and the second is the one that would have caught it:
//
//   1. The wiring. No credential gate, dev still exempt, every updater event handled.
//      Source-level, because reaching the real branch needs a packaged app.
//   2. The feed. An UNAUTHENTICATED fetch of the exact URL electron-updater reads. A
//      source-level check alone would have stayed green through the entire outage, since
//      the code was correct for the world it believed it was in.
//
// Run:  node scripts/e2e/test-auto-update.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

// --- 1. the wiring --------------------------------------------------------
console.log("-- the wiring --");
const src = fs.readFileSync(path.join(REPO, "src", "lib", "autoUpdate.js"), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// THE regression. Any early return keyed on a credential puts this back where it was.
ok(!/GH_TOKEN/.test(code), "no credential gate in the code path - the repo is public, so a token check can only switch this off");
ok(!/\bparked\b/i.test(code), 'and nothing "parks" it any more');

// The one guard that MUST survive: dev has no packaged app to replace, and importing
// electron-updater there was the reason the dependency could be absent in dev at all.
ok(/!app\.isPackaged/.test(code), "dev is still exempt - there is no packaged app to replace and the import must not run");
const guardIdx = code.indexOf("!app.isPackaged");
const importIdx = code.indexOf('import("electron-updater")');
ok(guardIdx > 0 && importIdx > 0 && guardIdx < importIdx, "and the guard comes BEFORE the dynamic import, which is the whole point of it being dynamic");

// Parity with Jot and Nib: every outcome logged. Logging only errors is what made "nothing
// newer" and "never ran" the same silence.
for (const evt of ["checking-for-update", "update-available", "update-not-available", "download-progress", "update-downloaded", "error"]) {
  ok(code.includes(`"${evt}"`), `the ${evt} event is handled, so a launch log says what happened`);
}

// And it has to be CALLED. A module that is correct and never invoked looks exactly like
// one that works, which is the same shape as the outage above.
const mainSrc = fs.readFileSync(path.join(REPO, "src", "main.js"), "utf8");
const mainCode = mainSrc.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
ok(/\binitAutoUpdate\(\)/.test(mainCode), "main.js actually calls initAutoUpdate()");
ok(/import\s*\{[^}]*initAutoUpdate/.test(mainCode) || /initAutoUpdate\s*\}/.test(mainCode), "and imports it, rather than the call being dead");

// --- 2. where it points ---------------------------------------------------
console.log("\n-- where it points --");
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const publish = [].concat(pkg.build?.publish || []);
ok(publish.length === 1, `exactly one publish target (${publish.length})`);
const target = publish[0] || {};
ok(target.provider === "github", `published to github (${target.provider})`);
ok(target.owner === "AidinD" && target.repo === "helm", `at AidinD/helm (${target.owner}/${target.repo})`);
ok(!!pkg.dependencies?.["electron-updater"], "electron-updater is a RUNTIME dependency - in devDependencies it would be absent from the packaged app");

// --- 3. the feed, for real and without credentials ------------------------
console.log("\n-- the feed, unauthenticated --");
const base = `https://github.com/${target.owner}/${target.repo}/releases/latest/download`;
let res = null;
try {
  res = await fetch(`${base}/latest.yml`, { headers: { "user-agent": "helm-update-test" }, redirect: "follow" });
} catch (err) {
  // Offline is not a failure of the app. Reported as a SKIP so it is named at the end of
  // the run rather than passing quietly - a network check that silently succeeds when it
  // could not run is the same defect class as the outage this file exists to catch.
  console.log(`SKIPPED - could not reach GitHub (${err?.message || err}); the wiring checks above still ran.`);
  process.exit(exit);
}

// A reachable-but-refusing GitHub is a REAL failure: it means the feed needs credentials
// after all, which is exactly the world the old code assumed.
ok(res.status === 200, `the release feed reads with NO credentials (HTTP ${res.status}${res.status === 404 ? " - repo private or no release?" : ""})`);
if (res.status === 200) {
  const text = await res.text();
  const version = /(^|\n)version:\s*(.+)/.exec(text)?.[2]?.trim();
  const file = /(^|\n)path:\s*(.+)/.exec(text)?.[2]?.trim();
  ok(/^\d+\.\d+\.\d+/.test(version || ""), `it advertises a comparable version (${version})`);
  ok(!!file && /\.exe$/i.test(file), `and names an installer (${file})`);
  // The feed pointing at an asset that cannot be fetched fails LATER, mid-download, which
  // is worse than failing here.
  if (file) {
    const head = await fetch(`${base}/${file}`, { method: "HEAD", headers: { "user-agent": "helm-update-test" }, redirect: "follow" });
    ok(head.status === 200, `the installer it names is downloadable too (HTTP ${head.status})`);
    ok(Number(head.headers.get("content-length") || 0) > 1_000_000, `and is a real artifact, not an error page (${head.headers.get("content-length")} bytes)`);
  }
}

console.log(
  exit === 0
    ? "\nVERIFY OK: auto-update has no credential gate, dev stays exempt, every outcome is logged, and the release feed really is readable without credentials."
    : "\nVERIFY FAILED."
);
process.exit(exit);
