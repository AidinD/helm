// Check the frameless header: the window has no OS title bar, the header row is
// the drag handle, and its three buttons work.
//
// Worth its own test because the failure mode is nasty. Get the drag region
// wrong and the window cannot be moved at all; forget the no-drag exception and
// every button in the header stops responding to clicks, with nothing in the
// console to say why.

import { launch } from "../checks-lib/harness.mjs";

let failures = 0;

/** @param {string} label @param {() => void} fn */
function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${label}`);
    console.error(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

const app = await launch();

try {
  await app.waitForSelector("header .brand");

  const header = JSON.parse(
    await app.eval(`JSON.stringify({
      drag: getComputedStyle(document.querySelector('header')).webkitAppRegion,
      buttonDrag: getComputedStyle(document.querySelector('#settingsGear')).webkitAppRegion,
      controls: [...document.querySelectorAll('.window-controls button')].map(b => b.dataset.window),
      brand: document.querySelector('header .brand h1').textContent
    })`)
  );

  check("the header row is the drag handle", () => {
    if (header.drag !== "drag") {
      throw new Error(`header app-region is "${header.drag}"; the window would be unmovable`);
    }
  });

  check("but its buttons are still clickable", () => {
    if (header.buttonDrag !== "no-drag") {
      throw new Error(
        `a header button has app-region "${header.buttonDrag}" - it would swallow clicks silently`
      );
    }
  });

  check("all three window buttons are present", () => {
    if (header.controls.join(",") !== "minimize,maximize,close") {
      throw new Error(`found ${JSON.stringify(header.controls)}`);
    }
  });

  check("the wordmark is still there", () => {
    if (!/Helm/.test(header.brand)) {
      throw new Error(`brand reads "${header.brand}"`);
    }
  });

  const bridge = JSON.parse(
    await app.eval(`JSON.stringify({
      minimize: typeof window.helm.minimizeWindow,
      maximize: typeof window.helm.toggleMaximizeWindow,
      close: typeof window.helm.closeWindow
    })`)
  );
  check("the preload exposes the three window operations", () => {
    for (const [name, type] of Object.entries(bridge)) {
      if (type !== "function") {
        throw new Error(`${name} is ${type}`);
      }
    }
  });

  const maximised = JSON.parse(
    String(await app.eval(`window.helm.toggleMaximizeWindow().then((r) => JSON.stringify(r))`))
  );
  check("maximise actually reaches the main process", () => {
    if (typeof maximised?.maximized !== "boolean") {
      throw new Error(`got ${JSON.stringify(maximised)}`);
    }
  });
  await app.eval(`window.helm.toggleMaximizeWindow()`);

  const errors = await app.getConsole?.();
  if (Array.isArray(errors)) {
    const bad = errors.filter((e) => /error/i.test(String(e.level ?? e.type ?? "")));
    check("no console errors from the change", () => {
      if (bad.length > 0) {
        throw new Error(bad.map((e) => e.text).join("; "));
      }
    });
  }

  await app.screenshot("scripts/e2e/screenshots/frameless-header.png");
  console.log("  --   screenshot: scripts/e2e/screenshots/frameless-header.png");
} finally {
  await app.close();
}

console.log(failures === 0 ? "\nFrameless header OK." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
