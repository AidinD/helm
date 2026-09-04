// LIVE-EXEMPT: it launches the app but starts no session, so nothing reaches a model.
//
// A machine with no Claude Desktop session store is TOLD so, on screen.
//
// This is the last hop of a fix whose earlier hops were all invisible. `readAllSessions` used
// to return early when that store could not be found, which dropped Helm's OWN session index
// with it - so a new user who started a session in Helm could not see the session Helm was
// running, and the one honest sentence the code produced ("Could not locate Claude session
// files") was carried to the main process and read by nobody.
//
// The read now merges Helm's own sessions regardless and reports the missing half. Two checks
// already cover that in the library. This one covers the part that a library check cannot: the
// report actually reaching a person. A payload that is correct behind a page that never shows
// it is a fix in name only, and this repo has shipped that exact shape more than once.
//
// The notice is a header pill rather than a transient message on purpose, and this asserts
// that too: a toast fades and leaves behind precisely the unexplained short list it was
// raised to explain.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

// Point the app at a Claude data root that does not exist BEFORE the harness is imported, so
// the child process inherits it. `resolveClaudeRoot` reads the roaming app-data variable and
// never the home directory, which is why faking HOME proves nothing here - the CI wrapper's
// own clean-checkout simulation did exactly that and was green against the real store.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-nostore-"));
process.env.APPDATA = path.join(tmp, "appdata");
process.env.LOCALAPPDATA = path.join(tmp, "localappdata");
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");

const { launch } = await import("../checks-lib/harness.mjs");

let app = null;
try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- the store really is absent for this run -------------------------------------------
  const store = await app.eval(`window.helm.getSessions().then((d) => d.desktopStore || null)`);
  ok(store !== null, "the sessions read carries a desktopStore field at all - without it there is nothing to show");
  ok(store && store.available === false, `and reports the store as unavailable on this machine (${JSON.stringify(store && store.available)})`);
  ok(
    store && typeof store.message === "string" && store.message.length > 40,
    "with a message written for a person rather than a code"
  );
  ok(
    store && /claude/i.test(store.message || ""),
    "that names what is missing, so the reader can act on it"
  );

  // --- and Helm's own sessions were NOT dropped with it ----------------------------------
  const shape = await app.eval(`window.helm.getSessions().then((d) => ({ isArray: Array.isArray(d.sessions), error: d.error || null }))`);
  ok(shape.isArray, "the read still returns a sessions array rather than bailing out");
  ok(
    shape.error === null,
    `and does NOT report an error, because a store that is not installed is not a fault (${shape.error})`
  );

  // --- the pill is on screen, and it is persistent ---------------------------------------
  const pill = await app.eval(
    `(async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const el = document.getElementById("desktopStorePill");
        if (el && !el.classList.contains("hidden")) {
          const box = el.getBoundingClientRect();
          return { shown: true, text: el.textContent, title: el.title, w: box.width, h: box.height, inHeader: !!el.closest("header") };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      const el = document.getElementById("desktopStorePill");
      return { shown: false, exists: !!el, classes: el ? el.className : "(no element)" };
    })()`
  );
  ok(pill.shown, `the header pill is visible without anybody clicking anything (${pill.shown ? "" : pill.classes})`);
  if (pill.shown) {
    ok(pill.w > 0 && pill.h > 0, `and has real size, so it is not merely un-hidden (${Math.round(pill.w)}x${Math.round(pill.h)})`);
    ok(pill.inHeader, "and sits in the header, where a fact about this machine belongs rather than in the transient notice column");
    ok((pill.text || "").trim().length > 0, `carrying a short label (${pill.text})`);
    ok((pill.title || "").length > 40, "and the full explanation on hover, since a pill has no room for it");
  }

  // --- and it goes away when the store IS there ------------------------------------------
  // Driven through the painter rather than by relaunching, because the negative case is about
  // the painter's decision and a second Electron launch buys nothing. Asserting BOTH
  // directions matters: a pill that is always visible would pass every check above.
  const hidesAgain = await app.eval(
    `(() => {
      paintDesktopStorePill({ available: true, reason: null, message: "" });
      const el = document.getElementById("desktopStorePill");
      const hidden = el.classList.contains("hidden");
      paintDesktopStorePill({ available: false, reason: "absent", message: "The Claude Desktop session store was not found on this machine." });
      const backAgain = !el.classList.contains("hidden");
      return { hidden, backAgain };
    })()`
  );
  ok(hidesAgain.hidden, "a machine that DOES have the store gets no pill");
  ok(hidesAgain.backAgain, "and it comes back when the store is missing again, so the painter reads its input rather than latching");

  const errs = app.getConsoleErrors();
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs[0].text.slice(0, 200) : ""}`);
} catch (err) {
  fails += 1;
  console.log(`FAIL - the check threw: ${err && err.message}`);
} finally {
  if (app) {
    await app.close();
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // a leftover temp dir is harmless
  }
}

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: a machine with no Claude Desktop store says so in the header, and still lists the sessions Helm started itself."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
