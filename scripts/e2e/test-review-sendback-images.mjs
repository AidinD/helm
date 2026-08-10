// Task 1116b7ef: "man ska kunna lägga till bilder när man send back en review."
// Drives the real reviews:sendBack IPC against a temp Jot board: a review task
// is sent back to in-progress WITH a base64 image, and we assert the image file
// lands under Jot's own jot-images/<taskId>/ dir, its relative path is appended
// to the task's images array, the note is appended to the description, and the
// status moved to in-progress. Also asserts the renderer's Send back dialog
// carries an image-attach zone (via customPrompt's extraEl) and that setTaskStatus
// with no images behaves exactly as before.
//
// Run:  node scripts/e2e/test-review-sendback-images.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-sendback-"));
const jotDir = path.join(tmp, "jot");
fs.mkdirSync(jotDir, { recursive: true });
const TASK = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const todos = {
  categories: [{ id: "cat1", name: "Helm", domain: "private" }],
  todos: [{ id: TASK, text: "A task in review", status: "review", categoryId: "cat1", description: "orig", images: [], createdAt: 1, updatedAt: 1 }],
};
fs.writeFileSync(path.join(jotDir, "todos.json"), JSON.stringify(todos), "utf8");

// 1x1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

process.env.JOT_DATA_DIR = jotDir;
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9573";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // The dialog carries an image zone (extraEl wiring).
  const dialog = await app.eval(`(() => {
    const z = sendBackImageZone();
    return { hasEl: !!z.el, hasBar: !!z.el.querySelector(".sendback-images-bar"), startsEmpty: z.images.length === 0 };
  })()`);
  ok(dialog.hasEl && dialog.hasBar, "the Send back dialog builds an image-attach zone");
  ok(dialog.startsEmpty, "which starts with no images attached");

  // Task 1116b7ef came back: paste must work "på samma sätt som i jot eller i chattfönstret".
  // A plain div never receives paste, so the zone now exposes attachPasteTo (the dialog wires
  // it onto the focused note textarea) and makes the box itself focusable. Drive a REAL paste
  // event carrying a PNG onto the wired field and confirm the image is attached.
  const paste = await app.eval(`(async () => {
    const z = sendBackImageZone();
    const field = document.createElement("textarea");
    document.body.append(field);
    z.attachPasteTo(field);
    const bin = atob(${JSON.stringify(PNG_B64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) { arr[i] = bin.charCodeAt(i); }
    const file = new File([arr], "pasted.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    field.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 250));
    const out = {
      hasAttach: typeof z.attachPasteTo === "function",
      focusable: z.el.getAttribute("tabindex") === "0",
      images: z.images.length,
      thumbs: z.el.querySelectorAll(".sendback-thumb").length,
    };
    field.remove();
    return out;
  })()`);
  ok(paste.hasAttach, "the zone exposes attachPasteTo, so the dialog can wire the focused note field");
  ok(paste.focusable, "the box itself is focusable (tabindex=0), so a paste onto the box works too");
  ok(paste.images === 1 && paste.thumbs === 1, `pasting an image into the wired note field attaches it (images=${paste.images}, thumbs=${paste.thumbs})`);

  // And the dialog actually wires it: customPrompt hands its field to onField, and the Send
  // back call site passes onField -> imgZone.attachPasteTo. Source-checked because the real
  // dialog's field is created inside customPrompt.
  const rsrc = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  ok(/onField\?\.\(field\)/.test(rsrc), "customPrompt hands its focused field to onField");
  ok(/onField:\s*\(field\)\s*=>\s*imgZone\.attachPasteTo\(field\)/.test(rsrc), "the Send back dialog wires the note field's paste into the image zone");

  // The real IPC: send back with one image.
  const res = await app.eval(`window.helm.sendReviewBack(${JSON.stringify(TASK)}, "[Aidin 2026-08-09] please fix the wrap", [{ base64: ${JSON.stringify(PNG_B64)}, ext: "png" }])`);
  ok(res?.ok === true, `reviews:sendBack succeeded (${JSON.stringify(res?.error || "")})`);

  const saved = JSON.parse(fs.readFileSync(path.join(jotDir, "todos.json"), "utf8"));
  const todo = saved.todos.find((t) => t.id === TASK);
  ok(todo?.status === "in-progress", `the task moved to in-progress (${todo?.status})`);
  ok(/please fix the wrap/.test(todo?.description || ""), "the note was appended to the description");
  ok(Array.isArray(todo?.images) && todo.images.length === 1, `one image path was recorded on the task (${JSON.stringify(todo?.images)})`);

  const rel = todo.images[0];
  ok(/jot-images/.test(rel) && rel.includes(TASK), `the image path is under jot-images/<taskId> (${rel})`);
  const abs = path.join(jotDir, rel);
  ok(fs.existsSync(abs), `the image file actually exists on disk (${abs})`);
  ok(fs.statSync(abs).size > 0, "and is non-empty (the bytes were written, not just the path)");

  // A second send-back appends, not replaces.
  await app.eval(`window.helm.sendReviewBack(${JSON.stringify(TASK)}, "second note", [{ base64: ${JSON.stringify(PNG_B64)}, ext: "png" }])`);
  const saved2 = JSON.parse(fs.readFileSync(path.join(jotDir, "todos.json"), "utf8")).todos.find((t) => t.id === TASK);
  ok(saved2.images.length === 2, `a second send-back APPENDS its image rather than replacing (${saved2.images.length})`);

  // No-image send-back still works (the plain path).
  const plain = await app.eval(`window.helm.sendReviewBack(${JSON.stringify(TASK)}, "note only", [])`);
  ok(plain?.ok === true, "a send-back with no images still succeeds");
  const saved3 = JSON.parse(fs.readFileSync(path.join(jotDir, "todos.json"), "utf8")).todos.find((t) => t.id === TASK);
  ok(saved3.images.length === 2, "and does not add a phantom image");

  const consoleErrors = app.getConsoleErrors();
  ok(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
} catch (err) {
  ok(false, `unexpected failure: ${err.message}`);
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(exit === 0 ? "VERIFY OK: a review can be sent back with images that land on the Jot card." : "VERIFY FAILED.");
process.exit(exit);
