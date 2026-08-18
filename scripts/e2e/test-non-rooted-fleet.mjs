// Two things the captain found in one screenshot on 2026-08-02, both about sessions that
// are NOT rooted in a project.
//
// 1. "Träning och kost finns i needs you men inte i captain."
//    Its Fleet node was parked in the archivedSecondMates overlay before un-archive
//    learned to clear it, so the later fix helped future archives and did nothing for
//    the entry already on disk. The session was live and visible in the queue, and
//    invisible in Captain, with no control anywhere able to un-park it - the same
//    "parked with no un-park" shape as the docs-drift bug.
//
// 2. "Archive verkar inte visa rätt alternativ."
//    The menu offered "Save handoff to HANDOFF.md" for a session it should have filed
//    BY TOPIC. The cause was not the handoff logic - the backend checks for the
//    meta-home properly and files by topic. It was the LABEL: the menu asked "does it
//    have a cwd?" and his life-domain sessions are all rooted AT the meta-home, so
//    they do. The behaviour was right and the label was wrong, which is worse than a
//    plain bug: he concluded the feature was missing.
//
// Run: node scripts/e2e/test-non-rooted-fleet.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./harness.mjs";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-nonroot-"));
const configPath = path.join(tmp, "config.json");
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });
process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9390";

const J = JSON.stringify;
const readCfg = () => (fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {});

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const ready = await (async () => {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      if (await app.eval(`typeof archiveMenuItems === "function"`)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
  ok(ready, "the renderer loaded");

  // ---- 2. THE LABEL -------------------------------------------------------
  // The predicate the label depends on, driven with the meta-home the app is
  // actually running against.
  const labels = await app.eval(`(() => {
    const home = state.orchestratorHome;
    const mk = (cwd) => archiveMenuItems({ title: "t", cwd }, { plainArchive: () => {} })[0].label;
    return {
      home,
      none: mk(null),
      metaHome: mk(home),
      metaHomeBackslashes: mk(String(home).replace(/\\//g, "\\\\")),
      metaHomeTrailingSlash: mk(String(home) + "/"),
      metaHomeUpper: mk(String(home).toUpperCase()),
      realRepo: mk("D:/Repo/Tools/helm"),
    };
  })()`);
  ok(!!labels.home, `the app knows its meta-home (${J(labels.home)})`);
  ok(/by topic/.test(labels.none), `no folder at all -> by topic (${J(labels.none)})`);
  ok(
    /by topic/.test(labels.metaHome),
    `a session rooted AT the meta-home -> by topic, which is what it actually does (${J(labels.metaHome)})`
  );
  ok(/by topic/.test(labels.metaHomeBackslashes), "the same with Windows backslashes");
  ok(/by topic/.test(labels.metaHomeTrailingSlash), "the same with a trailing slash");
  ok(/by topic/.test(labels.metaHomeUpper), "the same in a different case - Windows paths are case-insensitive");
  ok(
    /HANDOFF\.md/.test(labels.realRepo),
    `a real project still says HANDOFF.md (${J(labels.realRepo)})`
  );

  // The label must agree with the BACKEND, which is the thing that decides. Ask it.
  const backend = await app.eval(`(async () => {
    const home = state.orchestratorHome;
    const a = await window.helm.saveHandoff(home, "probe from the test", "Kombucha test");
    const b = await window.helm.saveHandoff(null, "probe from the test", "Training test");
    return { metaHomeTopicKeyed: a?.topicKeyed === true, noneTopicKeyed: b?.topicKeyed === true, cat: a?.category };
  })()`);
  ok(
    backend.metaHomeTopicKeyed === true,
    `the backend really does file a meta-home-rooted handoff by topic (${J(backend)})`
  );
  ok(backend.noneTopicKeyed === true, "and a folderless one too");
  ok(
    /by topic/.test(labels.metaHome) === backend.metaHomeTopicKeyed,
    "so the LABEL and the BEHAVIOUR now agree - that disagreement was the whole bug"
  );

  // ---- 2b. THE TOPIC PICKER -----------------------------------------------
  // When the classifier can't pick a topic the save is refused and the renderer
  // must ASK. Drive the real menu: it has to render the existing topics, offer a
  // clearly-labelled new one, and resolve with what was clicked.
  const picked = await app.eval(`(async () => {
    const p = pickHandoffTopic(
      { existing: ["training-coaching", "kombucha"], suggestion: "traning-och-kost-hevy", error: "The topic classifier did not answer within 120s." },
      "Träning och kost (Hevy)"
    );
    const menu = document.getElementById("contextMenu");
    const labels = [...menu.querySelectorAll(".item")].map(el => el.textContent);
    const hidden = menu.classList.contains("hidden");
    const row = [...menu.querySelectorAll(".item")].find(el => el.textContent.startsWith("training-coaching"));
    row.click();
    return { labels, hidden, chosen: await p };
  })()`);
  ok(picked.hidden === false, "the picker actually opens");
  ok(
    picked.labels.some((l) => l.includes("training-coaching")),
    `it lists the existing topics to choose from (${J(picked.labels)})`
  );
  ok(
    picked.labels.some((l) => l.includes("New topic: traning-och-kost-hevy")),
    "the title-derived name is offered, but labelled as a NEW topic rather than taken silently"
  );
  ok(
    picked.labels.some((l) => l.includes("did not answer")),
    "and it says why it is asking - the classifier failing used to be invisible"
  );
  ok(picked.chosen === "training-coaching", `clicking a topic resolves it (${J(picked.chosen)})`);

  const dismissed = await app.eval(`(async () => {
    const p = pickHandoffTopic({ existing: ["training-coaching"], suggestion: "x" }, "t");
    closeContextMenu();
    return await p;
  })()`);
  ok(dismissed === null, `dismissing the menu resolves null rather than hanging the archive (${J(dismissed)})`);

  // ---- 2c. A NON-SUMMARY MUST NOT BECOME A HANDOFF ------------------------
  // The third handoff file on his disk contained, in full: "You've hit your
  // session limit · resets 9:40pm (Europe/Stockholm)". The summarize turn had
  // exited cleanly with the CLI's own notice as the assistant's reply, so
  // nothing downstream saw a failure and a whole session's knowledge was
  // replaced by a status line.
  const summaries = await app.eval(`(() => ({
    limit: validateSummary("You've hit your session limit · resets 9:40pm (Europe/Stockholm)"),
    empty: validateSummary(""),
    real: validateSummary("x".repeat(400)),
  }))()`);
  ok(
    !summaries.limit.text && /ran out of usage/.test(summaries.limit.error || ""),
    `a usage-limit notice is refused, and says so in plain words (${J(summaries.limit)})`
  );
  ok(!summaries.empty.text, "an empty reply is refused too");
  ok(summaries.real.text?.length === 400, "a real summary passes through untouched");

  // ---- 1. THE PARKED NODE -------------------------------------------------
  const target = await app.eval(`(async () => {
    const res = await window.helm.getSessions();
    const s = (res?.sessions || []).find(x => x.sessionId && !x.isArchived);
    return s ? { sessionId: s.sessionId, cliSessionId: s.cliSessionId || null, title: s.title } : null;
  })()`);
  if (!target) {
    console.log("SKIP - no live session on this machine to park");
  } else {
    // Park the node of a session that is NOT archived: the exact state he was in.
    const cfg = readCfg();
    fs.writeFileSync(
      configPath,
      J({ ...cfg, archivedSecondMates: [...(cfg.archivedSecondMates || []), `sess_${target.sessionId}`, "sm_a_real_second_mate"] }),
      "utf8"
    );
    const parked = await app.eval(`window.helm.pruneStaleArchivedFleetNodes()`);
    ok(parked?.ok === true, `the prune runs (${J(parked?.error || "ok")})`);
    ok(
      (parked.removed || []).includes(`sess_${target.sessionId}`),
      `it un-parks the node of a session that is not archived (${J(parked.removed)})`
    );
    const after = readCfg();
    ok(
      !(after.archivedSecondMates || []).includes(`sess_${target.sessionId}`),
      "and the overlay on disk no longer hides it"
    );
    ok(
      (after.archivedSecondMates || []).includes("sm_a_real_second_mate"),
      `a REAL second mate's parking is left alone - that is a separate, deliberate decision (${J(after.archivedSecondMates)})`
    );

    // It must NOT un-park a node whose session really is archived - that parking is
    // doing its job.
    await app.eval(`window.helm.archiveSession(${J(target.sessionId)}, true)`);
    const cfg2 = readCfg();
    fs.writeFileSync(configPath, J({ ...cfg2, archivedSecondMates: [`sess_${target.sessionId}`] }), "utf8");
    const second = await app.eval(`window.helm.pruneStaleArchivedFleetNodes()`);
    ok(
      (second.removed || []).length === 0,
      `an archived session's node stays parked (${J(second.removed)})`
    );
    await app.eval(`window.helm.archiveSession(${J(target.sessionId)}, false)`);

    // An id for a session we cannot see at all is left parked: absence is not proof
    // the session is live, and un-parking on a failed read would resurrect nodes.
    const cfg3 = readCfg();
    fs.writeFileSync(configPath, J({ ...cfg3, archivedSecondMates: ["sess_00000000-0000-4000-8000-000000000000"] }), "utf8");
    const third = await app.eval(`window.helm.pruneStaleArchivedFleetNodes()`);
    ok((third.removed || []).length === 0, `an unknown session id is left parked, not guessed at (${J(third.removed)})`);
  }

  const errs = app.getConsoleErrors();
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs[0].text.slice(0, 200) : ""}`);
} catch (e) {
  fails++;
  console.error("ERR", e.stack || e.message);
} finally {
  if (app) {
    await app.close();
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
console.log(
  fails === 0
    ? "\nVERIFY OK: a meta-home-rooted session is labelled by what it actually does, and a stale fleet parking heals itself."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
