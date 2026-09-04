// Every persona says what it does, where you choose it.
//
// Task 1ffbe001: "Gå igenom personas och beskriv vad de gör." The descriptions existed all
// along - every persona carries a blurb, and listPersonas already sent it to the renderer -
// and the picker threw it away, offering five bare names. buildMenuItems has had a slot for
// exactly this since it was written: "for a menu of NAMES that stand for something else, the
// name alone makes the menu a guess."
//
// Coordinator is the one that needed writing: it is the ABSENCE of a persona, so no object
// carried a blurb, and it is the one seen most - the default for every fresh mate and what a
// respawn resets to.
//
// Run:  node scripts/e2e/test-persona-descriptions.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-persona-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9507";
const { launch } = await import("../checks-lib/harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- the catalog itself: every persona has a blurb -------------------------
  const catalog = await app.eval(`(async () => {
    const list = await window.helm.listPersonas();
    return {
      keys: list.map((p) => p.key),
      missingBlurb: list.filter((p) => !p.blurb || !String(p.blurb).trim()).map((p) => p.key),
      shortest: Math.min(...list.map((p) => String(p.blurb || "").length)),
      coordinator: personaBlurb(null),
      unknown: personaBlurb("no-such-persona"),
      labels: list.map((p) => p.label),
    };
  })()`);

  ok(catalog.keys.length >= 4, `the catalog has the personas (${catalog.keys.join(", ")})`);
  ok(catalog.missingBlurb.length === 0, `every one of them describes itself (${catalog.missingBlurb.join(", ") || "none missing"})`);
  ok(catalog.shortest > 30, `and the descriptions are real sentences, not one-word labels (shortest ${catalog.shortest} chars)`);
  ok(
    catalog.coordinator.length > 30 && /default/i.test(catalog.coordinator),
    `Coordinator - the absence of a persona, and the one seen most - has a description too (${JSON.stringify(catalog.coordinator.slice(0, 60))})`
  );
  ok(catalog.unknown === "", "an unknown key describes nothing rather than inventing something");

  // --- the picker shows them ------------------------------------------------
  const picker = await app.eval(`(async () => {
    await ensurePersonaCatalog();
    const mate = { mateId: "m-probe", name: "Probe", sessionId: null, persona: "red-team" };
    const row = fleetPersonaEl(mate);
    document.body.append(row);
    const btn = row.querySelector(".fleet-persona-btn");
    const title = btn.title;
    btn.click();
    await new Promise((r) => setTimeout(r, 250));
    const menu = document.getElementById("contextMenu");
    const items = [...menu.querySelectorAll(".item")].map((i) => ({
      label: i.querySelector(".item-desc") ? i.textContent.replace(i.querySelector(".item-desc").textContent, "") : i.textContent,
      desc: i.querySelector(".item-desc")?.textContent || "",
      block: i.querySelector(".item-desc") ? getComputedStyle(i.querySelector(".item-desc")).display : null,
      wraps: i.querySelector(".item-desc") ? getComputedStyle(i.querySelector(".item-desc")).whiteSpace : null,
    }));
    const width = menu.getBoundingClientRect().width;
    const overflows = menu.getBoundingClientRect().right > window.innerWidth;
    closeContextMenu();
    row.remove();
    return { title, items, width, overflows };
  })()`);

  ok(picker.items.length >= 5, `the picker offers Coordinator plus every persona (${picker.items.length} options)`);
  ok(
    picker.items.every((i) => i.desc.length > 20),
    `each option carries its description, not just a name (${picker.items.map((i) => i.desc.length).join(", ")})`
  );
  ok(
    picker.items.every((i) => i.block === "block"),
    `the description sits UNDER the label rather than as a right-floated tail (${picker.items[0]?.block})`
  );
  ok(
    picker.items.every((i) => i.wraps === "normal"),
    `and wraps, so a sentence does not run into the label (${picker.items[0]?.wraps})`
  );
  ok(picker.items.some((i) => /✓/.test(i.label)), "the current persona is still marked");
  ok(picker.width > 200 && picker.width <= 380, `the menu is wide enough to read and still bounded (${Math.round(picker.width)}px)`);
  ok(!picker.overflows, "and does not run off the right edge of the window");

  // The closed button is the one place that could answer "what is this mate doing".
  ok(/^Red team - /.test(picker.title), `the tooltip leads with what the mate IS (${JSON.stringify(picker.title.slice(0, 40))})`);
  ok(/adversarial/i.test(picker.title), "including the description");
  ok(/choose|switch/i.test(picker.title), "and still says what clicking does");

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors) {
    console.log("   ", e.text.slice(0, 160));
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
    ? "VERIFY OK: every persona describes itself where it is chosen, Coordinator included, and the closed picker says what the mate currently is."
    : "VERIFY FAILED."
);
process.exit(exit);
