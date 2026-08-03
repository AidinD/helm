// An image dropped on the prompt is attached, and a file drop never navigates the app
// away from itself.
//
// Task 90251904 - "kan inte drag and droppa bilder in till prompten längre". It had
// never worked: nothing in the renderer handled `drop`, and git history has no such
// handler ever existing. So Chromium's default took over, and its default for a file
// dropped on a page is to NAVIGATE to it - the app window replaces itself with the
// image. That is worse than nothing happening, which is why the non-image case must be
// swallowed too.
//
// Driven in the REAL app with a synthetic DataTransfer, because the interesting part is
// what the browser does with the event, not what our function does with a fake one.
//
// Run:  node scripts/e2e/test-composer-image-drop.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-drop-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9471";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.eval(`(() => { navigateToPage("chat"); return true; })()`);
  await app.waitForSelector("#chatPage .composer-shell textarea", 10000);

  const before = await app.eval(`document.location.href`);

  const res = await app.eval(`(async () => {
    const ta = document.querySelector("#chatPage .composer-shell textarea");
    // A 1x1 PNG, as a real File in a real DataTransfer.
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMB/6X0AwAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const file = new File([bytes], "dropped-probe.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);

    const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(over);
    const hadAffordance = ta.classList.contains("drop-target");
    const overPrevented = over.defaultPrevented;

    const drop = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(drop);
    const dropPrevented = drop.defaultPrevented;
    // The save round-trips through main.
    await new Promise((r) => setTimeout(r, 1500));

    // A NON-image file must also be swallowed, or the window navigates to it.
    const dt2 = new DataTransfer();
    dt2.items.add(new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" }));
    const drop2 = new DragEvent("drop", { dataTransfer: dt2, bubbles: true, cancelable: true });
    ta.dispatchEvent(drop2);

    const chips = document.querySelectorAll("#chatPage .attachment-chip, #chatPage .composer-attachment, #chatPage [data-attachment]");
    return {
      hadAffordance,
      overPrevented,
      dropPrevented,
      affordanceCleared: !ta.classList.contains("drop-target"),
      nonImagePrevented: drop2.defaultPrevented,
      attachmentsText: document.querySelector("#chatPage .composer-shell")?.parentElement?.textContent || "",
      chips: chips.length,
    };
  })()`);

  ok(res.overPrevented, "dragover is prevented - without that the drop event never arrives");
  ok(res.hadAffordance, "and the box shows it will take the image");
  ok(res.affordanceCleared, "which clears again after the drop");
  ok(res.dropPrevented, "the drop is handled, so Chromium does not navigate the window to the file");
  ok(res.nonImagePrevented, "a non-image file drop is swallowed too - the same navigation hazard");
  ok(/dropped-probe\.png/.test(res.attachmentsText) || res.chips > 0, `the image is attached to the composer (${JSON.stringify(res.attachmentsText.slice(-90))})`);

  const after = await app.eval(`document.location.href`);
  ok(after === before, `the app did not navigate away from itself (${before} -> ${after})`);

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors) {
    console.log("   ", e.text.slice(0, 140));
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    await app?.close();
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: an image dropped on the prompt is attached, a non-image drop is swallowed, and the window never navigates to the dropped file."
    : "VERIFY FAILED."
);
process.exit(exit);
