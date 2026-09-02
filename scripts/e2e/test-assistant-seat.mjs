// LIVE-EXEMPT: it launches the app but starts no session, so nothing reaches a model.
//
// The assistant seat exists, is not one of the coordinator pool, and is on the dashboard.
//
// the captain, 2026-09-02: "jag har skapat en assistent och jag vill ha det som en stående
// widget/space i helm. Precis som en first mate är idag." The design and its reasoning are in
// DECISIONS.md, entry "An assistant seat is not a first mate with a different manual".
//
// This check drives the REAL app, because the seat's whole point is being somewhere he can go.
// The store having a record and the dashboard having a card are two different claims, and
// this session has already shipped a correct payload behind a page that never showed it,
// twice. The tier's policy is checked separately and purely in test-assistant-tier.mjs.
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

// Its own stores, so the run never touches the real mates.json or config.json.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-assistant-seat-"));
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");

const { launch } = await import("./harness.mjs");

let app = null;
try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- the store ---------------------------------------------------------------------------
  const listed = await app.eval(`window.helm.listMates()`);
  ok(listed?.ok === true, "mates:list answers");
  ok(!!listed?.assistant, "and it carries an assistant seat, created on first ask rather than needing a setup step");
  ok(listed?.assistant?.name === "Assistent", `the seat has its fixed name rather than a random one (${listed?.assistant?.name})`);
  ok(listed?.assistant?.kind === "assistant", "and is marked as its own kind of seat");
  ok(listed?.assistant?.slot === null, "with no slot - it is singular, not one of a numbered pool");

  // The exclusion that keeps every existing reader honest. `active` is what forty places mean
  // by "the mates", and buildFirstMateMcpConfig falls back to active[0] - the assistant
  // sorting into that array would hand a plain first-mate launch this seat's identity.
  const activeIds = (listed?.active || []).map((m) => m.mateId);
  ok(!activeIds.includes(listed?.assistant?.mateId), "the seat is NOT in `active` - that array still means coordinators only");
  ok((listed?.active || []).length >= 1, `and the coordinator pool is still there (${(listed?.active || []).length} of them)`);
  ok((listed?.active || []).every((m) => (m.kind || "coordinator") === "coordinator"), "with nothing but coordinators in it");

  // Idempotent: asking twice must not mint a second seat.
  const again = await app.eval(`window.helm.listMates()`);
  ok(again?.assistant?.mateId === listed?.assistant?.mateId, "asking again returns the same seat rather than creating another");
  const assistants = (again?.all || []).filter((m) => m.kind === "assistant" && m.status === "active");
  ok(assistants.length === 1, `exactly one active assistant exists in the store (${assistants.length})`);

  // --- the dashboard -----------------------------------------------------------------------
  const seen = await app.eval(
    `(async () => {
      navigateToPage("dashboard");
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const w = [...document.querySelectorAll(".wd")].find((el) => (el.textContent || "").includes("Assistent"));
        if (w) {
          return { present: true, text: (w.textContent || "").slice(0, 400) };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return { present: false, text: [...document.querySelectorAll(".wd-head, .wd-title")].map((e) => e.textContent).join(" | ").slice(0, 400) };
    })()`
  );
  ok(seen.present, `the seat has a widget on the dashboard without being added by hand (${seen.present ? "" : seen.text})`);

  // It renders the seat, not the stores. The seat's own account of what would be wrong to
  // build put a dashboard first: "a widget that renders store state is a worse version of the
  // store". So the card must be a way IN, and must not be reproducing Tend or the board.
  if (seen.present) {
    ok(!/overdue|drift|cadence/i.test(seen.text), "and it does not render people-store state - that has an app");
    ok(!/\bin review\b/i.test(seen.text), "nor the task board's");
  }

  const errs = app.getConsoleErrors();
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs[0].text.slice(0, 200) : ""}`);
} catch (err) {
  fails += 1;
  console.log(`FAIL - the check threw: ${err && err.message}`);
} finally {
  if (app) {
    await app.close();
  }
  delete process.env.HELM_MATES_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // temp dir; a leftover is harmless
  }
}

// --- the launch actually treats it as the assistant ----------------------------------------
// Source-level, because proving it needs a real session start and this check spends nothing.
// The ORDER is the whole of the wiring: the seat is also meta-home rooted and also has a
// mateId, so it matches the first-mate condition exactly. Reversed, it would silently launch
// as a coordinator - strict MCP with no stores, and a manual telling it to dispatch the work
// it exists to do the thinking part of.
{
  const src = fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
  const assistantAt = src.indexOf("if (seatedAssistant) {");
  const firstMateAt = src.indexOf("} else if (isMetaHomeRoot(cwd) && firstMateId) {");
  ok(assistantAt > 0, "session:start has an assistant branch");
  ok(assistantAt > 0 && firstMateAt > assistantAt, "and it is tested BEFORE the first-mate branch, which it would otherwise match");
  const branch = src.slice(assistantAt, firstMateAt);
  ok(/buildAssistantMcpConfig/.test(branch), "the branch gives it the curated store config");
  ok(/ASSISTANT_ALLOWED_TOOLS/.test(branch), "pre-approves those stores' tools");
  ok(/launchTier = TIER_ASSISTANT/.test(branch), "runs it on its own tier, so the guard's refusal says something true");
  ok(/strictMcpConfig = true/.test(branch), "and stays STRICT - the stores were added by name, and strict is what keeps the rest of the machine out");
  ok(/assistantInstructions\(\)/.test(branch), "and hands it its own manual rather than the coordinator's");
  // The seat is resolved without going through the coordinator list, or it could not be found
  // at all once that list started excluding it.
  ok(/assistantSeat\(\)/.test(src), "the seat is resolved through its own accessor");
}

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: one standing assistant seat, outside the coordinator pool, on the dashboard, and launched as itself."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
