// E2E (real launched Helm, dev/npm start): the dev-build marker. Dev and the
// installed app read separate data dirs (repo root vs ~/.helm), so their
// fleet/sessions differ by design; the badge is what keeps the two windows from
// being confused. In a dev run (app.isPackaged === false) the DEV pill shows and
// body.dev-build is set (header accent stripe). The packaged case is the trivial
// negative: isDevBuild() -> !app.isPackaged -> false -> the `if (dev)` block is
// skipped, so the badge stays hidden.
//
// Run:  node scripts/e2e/test-dev-build-badge.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[dev-badge-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await wait(600);

  const r = await app.eval(`(async () => {
    const isDev = await window.helm.isDevBuild();
    const badge = document.getElementById("devBadge");
    const cs = badge ? getComputedStyle(badge) : null;
    return {
      isDev,
      badgeExists: !!badge,
      badgeText: badge?.textContent || "",
      badgeHidden: badge ? badge.classList.contains("hidden") : true,
      badgeVisible: cs ? cs.display !== "none" && cs.visibility !== "hidden" : false,
      bodyHasDevClass: document.body.classList.contains("dev-build"),
    };
  })()`);
  assert(r.isDev === true, "isDevBuild() reports true for an npm-start (unpackaged) run");
  assert(r.badgeExists && r.badgeText === "DEV", "the DEV badge element exists with the right label");
  assert(r.badgeHidden === false && r.badgeVisible === true, "the DEV badge is shown (not hidden) in a dev run");
  assert(r.bodyHasDevClass === true, "body.dev-build is set (drives the header accent stripe)");

  // (No screenshot here. It asserted nothing - the four checks above fully prove the
  // badge - yet it wrote a stray scripts/e2e/_dev-badge.png and, worse, the harness's
  // CDP capture "can occasionally hang" (its own doc) and is meant to be treated as
  // best-effort; unguarded, its 10s timeout failed this whole test while every real
  // assertion had passed. Removed rather than wrapped in try/catch: there is no reason
  // to write the PNG at all.)

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    log("  err:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: dev build is unmistakably badged (DEV pill + header stripe)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
