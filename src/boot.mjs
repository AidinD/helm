// The app's entry point, and the only thing standing between a missing dependency and a
// window that never appears.
//
// WHAT IT IS FOR
// Helm imports `keel` from three places, and `src/lib/atomicWrite.js` - which almost every
// module in the app reaches through - is one of them. keel is declared as a `file:` path to a
// sibling repository, and npm links a missing `file:` dependency to a dangling symlink and
// exits 0. So an install can succeed completely and the app still cannot start.
//
// What that looked like before this file existed: `main.js` threw while its own imports were
// being resolved, before a single line of it ran. No window, no dialog, no notification - the
// process exited and the icon simply did nothing when clicked. A first-time user hit exactly
// that shape with a different dependency and had no way to find out why (card 6c84414b).
//
// A module cannot catch the failure of its own static imports. That is the entire reason this
// file exists rather than a try/catch inside main.js: the import has to happen from somewhere
// that has already loaded successfully.
//
// WHAT IT DELIBERATELY DOES NOT DO
// Fix, retry, or work around anything. A missing dependency is a broken install and the honest
// answer is to say so. It also does not decide how keel should be delivered - published,
// vendored, or lazily imported - which is a real decision with real trade-offs and is tracked
// separately. Whatever is chosen, an install that goes wrong should explain itself.
//
// The normal path costs one dynamic import and nothing else: when main.js loads, this file has
// no further involvement in the run.
import { app, dialog } from "electron";

/** Turn a module-resolution failure into the sentence a person can act on. */
function explain(error) {
  const message = String(error?.message || error || "unknown error");
  const missing = message.match(/Cannot find (?:package|module) '([^']+)'/);
  if (!missing) {
    return {
      title: "Helm could not start",
      body: `Something went wrong while loading the app.\n\n${message}`,
      hint: null,
    };
  }
  const pkg = missing[1];
  // The `file:` siblings are the ones that go missing without npm complaining, so they get a
  // specific instruction. Anything else is a plain missing dependency.
  const sibling = { keel: "AidinD/keel", "@jot/core": "AidinD/jot" }[pkg];
  return {
    title: "Helm could not start",
    body: sibling
      ? `The package "${pkg}" is not installed.\n\nIt is not on npm - it lives in a sibling repository (${sibling}) and is linked from disk, so "npm install" reports success even when it is missing.\n\nClone it next to this one and run "npm install" again.`
      : `The package "${pkg}" is not installed.\n\nRun "npm install" in the Helm folder and start it again.`,
    hint: pkg,
  };
}

try {
  await import("./main.js");
} catch (error) {
  const { title, body, hint } = explain(error);
  // stderr FIRST, and unconditionally. A dialog is for the person holding the mouse; a launcher,
  // a test harness or a terminal needs the same fact in a form it can read, and one of those is
  // how this will usually be seen.
  console.error(`[boot] ${title}: ${hint ? `missing ${hint}` : "see below"}`);
  // The INSTRUCTION goes to stderr too, not only into the dialog. A terminal, a launcher and a
  // test harness all get stderr and none of them get a message box, and "keel is missing" without
  // "npm install will not fix it, clone the sibling" is half an answer - the wrong half, because
  // the obvious next step is the one that does not work.
  console.error(body.split("\n").filter(Boolean).map((l) => `[boot] ${l}`).join("\n"));
  console.error(String(error?.stack || error));
  // A DIALOG OR A GUARANTEED EXIT - not both, and the honest thing is to say which and why.
  //
  // A native message box blocks the message loop while it is up, so a timer meant to close it
  // never fires: Promise.race looks like it solves this and does not. Measured - a broken
  // install started this way sat for the full sixty seconds of the caller's timeout and came
  // back with no exit status at all. A hang wearing an error message is worse than the silent
  // failure this file was written to replace, because now something IS on screen and the
  // process still never ends.
  //
  // So the dialog is for a person, and an unattended launch is identified rather than guessed
  // at: the markers below are set by this repo's own harness and by CI. Anything else is
  // treated as somebody sitting there, which is the safe default - the cost of being wrong is
  // a dialog nobody sees, against a process nobody can end.
  const unattended = Boolean(process.env.CI || process.env.HELM_E2E_HIDDEN || process.env.HELM_E2E_PORT);
  if (!unattended) {
    try {
      await app.whenReady();
      dialog.showErrorBox(title, body);
    } catch {
      // No display or no Electron session. The stderr above is then the whole report, which is
      // why it goes first and carries the instruction as well as the fact.
    }
  }
  // Non-zero, so anything that spawned this knows. app.exit rather than app.quit: quit runs the
  // normal shutdown path, and there is no app to shut down.
  app.exit(1);
}
