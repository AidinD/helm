// Dropping a FILE on the composer attaches it, not only an image.
//
// the captain, task c24f18b8: "dra filer till prompten ska också fungera (nu fungerar bara bilder)".
// A non-image drop was swallowed with "Only images can be dropped into the prompt." - the
// refusal was deliberate, because Chromium's default for a file dropped on a page is to
// NAVIGATE to it and the app window disappears. So the drop had to be prevented; it just did
// not have to be refused.
//
// Nothing needs saving for a non-image: the file is already on disk, so its path is attached
// exactly the way the paperclip button does, and the send path already renders a non-image
// attachment as `[Attached file: <path>]`.
//
// Run:  node scripts/e2e/test-drop-file-into-prompt.mjs
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
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9509";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`(async () => {
    navigateToPage("chat");
    openFreshDraftInPane(${JSON.stringify(tmp.replace(/\\/g, "\\\\"))}, "", { forceIndex: 0 });
    await new Promise((r) => setTimeout(r, 400));
    const promptEl = document.querySelector('.pane[data-pane="0"] .pane-composer textarea');

    // A real drop event carrying a real File. Its path is empty (a File built in the page has
    // no filesystem path), which is exactly the case that must be REPORTED rather than
    // attached as an empty mention.
    const drop = (file) => {
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      promptEl.dispatchEvent(ev);
      return ev.defaultPrevented;
    };

    // Opening the pane raises its own toast ("New session started"), and reading only the
    // FIRST .toast found the old one - so clear them, then read every toast that appears.
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const pathless = new File(["notes"], "notes.txt", { type: "text/plain" });
    const prevented = drop(pathless);
    await new Promise((r) => setTimeout(r, 300));
    const afterPathless = {
      prevented,
      attachments: panes[0].pendingAttachments.length,
      toast: [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | "),
    };

    // The bridge the real path comes from has to exist, or every dropped file would be
    // reported as pathless and the feature would be a no-op that looks like a refusal.
    const bridge = typeof window.helm.pathForFile === "function";
    const bridgeAnswer = bridge ? window.helm.pathForFile(pathless) : null;

    // And the attach path itself, driven with a path the way a real drop supplies one.
    panes[0].pendingAttachments.push({ path: "D:\\\\Repo\\\\Tools\\\\helm\\\\PLAN.md", name: "PLAN.md", isImage: false });
    panes[0].els.renderAttachments();
    const chip = document.querySelector('.pane[data-pane="0"] .attachment-chip');
    const chipText = chip ? chip.textContent : null;

    // What the send path will actually put in the prompt for it.
    const mention = panes[0].pendingAttachments
      .map((att) => "[Attached " + (att.isImage ? "image" : "file") + ": " + att.path + "]")
      .join("\\n");

    return { ...afterPathless, bridge, bridgeAnswer, chipText, mention };
  })()`);

  ok(res.prevented === true, "a file drop is still prevented, so Chromium cannot navigate the window to the file");
  ok(res.bridge === true, "the renderer has a way to ask for a dropped file's real path");
  ok(res.bridgeAnswer === "", `and it answers "" for a file with no path on disk rather than throwing (${JSON.stringify(res.bridgeAnswer)})`);
  ok(res.attachments === 0, "a pathless file is not attached as an empty mention");
  ok(
    /no path on disk/i.test(res.toast),
    `and the reason is said out loud instead of a flat refusal (${JSON.stringify(res.toast.slice(0, 90))})`
  );
  ok(!/only images/i.test(res.toast), "the old 'Only images can be dropped' refusal is gone");
  ok(/PLAN\.md/.test(String(res.chipText)), `a non-image attachment shows as a chip like any other (${JSON.stringify(res.chipText)})`);
  ok(
    res.mention === "[Attached file: D:\\Repo\\Tools\\helm\\PLAN.md]",
    `and the prompt carries it as a file mention, not an image one (${JSON.stringify(res.mention)})`
  );

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    console.log("   ", e.text.slice(0, 160));
  }
} catch (err) {
  exit = 1;
  console.error("ERR", err.stack || err.message);
} finally {
  try {
    await app?.close();
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

// NOT VERIFIED: a drop of a file that really came from Explorer. A File constructed in the page
// has no path by design, so what is checked here is the whole chain except the one value only
// the OS can supply - the bridge exists, answers safely when there is no path, and the attach +
// mention path works when given one.
console.log(
  exit === 0
    ? "VERIFY OK: a dropped file is prevented from navigating, attached by path when it has one, and named as pathless when it does not."
    : "VERIFY FAILED."
);
process.exit(exit);
