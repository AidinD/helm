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

const { launch } = await import("../checks-lib/harness.mjs");

let app = null;
try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- the store ---------------------------------------------------------------------------
  // MADE, not found. Nothing mints the assistant seat any more (removed 2026-09-05, "You say
  // what a seat is, and nothing is minted behind your back") - so the check adds a coordinator
  // to the pool and promotes it itself, the same way test-you-say-what-a-seat-is.mjs does. The
  // extra coordinator is not decoration: promoting one takes it OUT of the pool, and this file
  // still asserts the pool is there and that the seat is excluded from `active` - without it
  // those assertions would be measuring a pool of one.
  await app.eval(`window.helm.addMate()`);
  const beforePromote = await app.eval(`window.helm.listMates()`);
  const toPromote = (beforePromote?.active || [])[(beforePromote?.active || []).length - 1];
  const promoted = await app.eval(`window.helm.setSeatAssistant(${JSON.stringify(toPromote?.mateId)}, true)`);
  ok(promoted?.ok === true, `a coordinator can be promoted to the assistant seat (${promoted?.error || "ok"})`);

  const listed = await app.eval(`window.helm.listMates()`);
  ok(listed?.ok === true, "mates:list answers");
  ok(!!listed?.assistant, "and it carries an assistant seat, made by promoting a coordinator");
  // REVERSED 2026-09-05, and the reversal is the change rather than a relaxation. The name was
  // fixed because the seat was the only one of its kind and the name was how he and other
  // sessions referred to it. Both halves stopped being true: identity is a tag now, so nothing
  // finds this seat by name, and a Swedish name in an otherwise English app was the second
  // thing he objected to.
  //
  // What the old assertion protected is asserted instead: it has a real name, drawn from the
  // same pool as every other seat. A name that expires on every respawn is not an identifier,
  // so a fixed-name lookup must not come back as a convenience.
  ok(!!listed?.assistant?.name, `the seat has a name (${JSON.stringify(listed?.assistant?.name)})`);
  ok(listed?.assistant?.name !== "Assistent", "and it is not the old fixed Swedish one");
  // A TAG since 2026-09-05, not a kind. The seat is no longer a category of its own - there is
  // one kind of seat, and what this one IS it carries.
  ok(
    (listed?.assistant?.tags || []).includes("assistant"),
    `and carries the tag that says what it is (${JSON.stringify(listed?.assistant?.tags)})`
  );
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
  const assistants = (again?.all || []).filter((m) => (m.tags || []).includes("assistant") && m.status === "active");
  ok(assistants.length === 1, `exactly one active assistant exists in the store (${assistants.length})`);

  // --- the dashboard -----------------------------------------------------------------------
  //
  // FOUND BY ID, NOT BY NAME, and that is the whole repair. This searched the board for the
  // text "Assistent" - the fixed Swedish name the seat carried until 2026-09-05, when it
  // started drawing from the pool like every other seat. So it hunted for a string nothing
  // renders any more and reported "the seat has a widget on the dashboard without being added
  // by hand" as a failure, about a widget that was on the board the whole time. The scheduled
  // app lane said so for two nights.
  //
  // mates.js says this out loud, two lines above the name it draws: "A name is not an
  // identifier here and must not become one again ... anything holding a name is holding
  // something that expires." This check was holding one. The widget's binding is the mateId,
  // so that is what to look for; the name is then asserted as DISPLAY, which is the only thing
  // a name is for here.
  const seatId = listed?.assistant?.mateId || null;
  const seatName = listed?.assistant?.name || null;
  ok(!!seatId, `there is a seat to look for (${seatName})`);
  const seen = await app.eval(
    `(async () => {
      navigateToPage("dashboard");
      const wanted = ${JSON.stringify(seatId)};
      const deadline = Date.now() + 20000;
      // FROM THE DOM, because a fresh board's layout is never written down: widgetLayout()
      // returns the default when nothing is saved and does not persist it, so reading
      // state.config for the ids finds an empty list while the widgets are on screen.
      // The ids cover both spellings - w-assistant is the legacy singleton, w-seat-<id> is
      // what a seat's widget is called since the three kinds became one.
      const bound = () =>
        [...document.querySelectorAll(".wd")].find((el) => {
          const id = el.dataset.widgetId || "";
          return id === "w-assistant" || id === "w-seat-" + wanted || id === "w-mate-" + wanted;
        }) || null;
      while (Date.now() < deadline) {
        const w = bound();
        if (w) {
          return { present: true, text: (w.textContent || "").slice(0, 400) };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return { present: false, text: [...document.querySelectorAll(".wd-head, .wd-title")].map((e) => e.textContent).join(" | ").slice(0, 400) };
    })()`
  );
  ok(seen.present, `the seat has a widget on the dashboard without being added by hand (${seen.present ? "" : seen.text})`);
  // And the card says WHICH seat it is. Separate from the assertion above on purpose: a widget
  // that renders while naming nobody is the state that made the old check's failure look like
  // an absence, and it is worth telling those two apart by name.
  ok(
    seen.present && !!seatName && seen.text.includes(seatName),
    `and it names the seat rather than rendering a nameless card (${JSON.stringify(seen.text.slice(0, 120))})`
  );

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

  // The seat's OWN store is attached by Helm, not looked up in the user's config, and the
  // difference matters: Tend, Jot and Nib are his apps in sibling repositories, while this one
  // is Helm's own file in this repository. Looking it up would have meant the seat cannot
  // write its goals or its log until a line is added to ~/.claude.json by hand.
  const cfgFn = src.slice(src.indexOf("function buildAssistantMcpConfig"), src.indexOf("function buildFirstMateMcpConfig"));
  ok(/base\.mcpServers\.assistant = \{/.test(cfgFn), "Helm attaches the assistant store itself - no user config entry needed for it");
  ok(/process\.execPath/.test(cfgFn) && /ELECTRON_RUN_AS_NODE/.test(cfgFn), "through Electron as a node runtime, so it needs no `node` on PATH and survives packaging");
  ok(/HELM_ASSISTANT_STORE_DIR/.test(cfgFn), "and is told its data directory rather than re-deriving the meta-home this process already resolved");
  ok(!/"tend", "jot", "nib", "assistant"/.test(src), "so `assistant` is NOT in the list of the user's own store servers");
  ok(/"mcp__assistant"/.test(src), "but its tools are still pre-approved, or the seat would hit a prompt it cannot answer");
  ok(/launching WITHOUT these stores/.test(cfgFn), "and a store of HIS that is not configured is named out loud rather than silently absent");

  // TWO ASSERTIONS, NOT ONE. Everything above says the seat RESOLVED - it exists, it is its
  // own kind, it has a widget. None of it says the seat kept its TOOLS, and after the
  // 2026-09-05 allowlist split those are different questions with different failure modes.
  // Narrowing the wrong branch would leave a seat that resolves perfectly and quietly cannot
  // do half its job, which nothing errors on: an unoffered tool is simply never called.
  ok(
    /const ASSISTANT_ALLOWED_TOOLS = \[\.\.\.STANDING_SEAT_TOOLS/.test(src),
    "the seat still builds on the STANDING set, so it keeps the two tools that reach across projects"
  );
  ok(
    /STANDING_SEAT_TOOLS = withServer\(helmToolsForSeat\("standing"/.test(src),
    "and that set comes from the shared rule rather than a second hand-maintained list"
  );
  ok(
    /PROJECT_SEAT_TOOLS = withServer/.test(src) && !/allowedTools = ASSISTANT_ALLOWED_TOOLS;[^]{0,400}PROJECT_SEAT_TOOLS/.test(src.slice(assistantAt, firstMateAt)),
    "while a project seat gets its own narrower set - the two are not the same array wearing two names"
  );
}

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: one standing assistant seat, outside the coordinator pool, on the dashboard, and launched as itself."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
