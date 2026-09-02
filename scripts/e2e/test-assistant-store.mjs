// The assistant seat's own two files: every tool, every refusal, and the two
// properties that are easy to claim and hard to have.
//
// WHY THIS CHECK EXISTS AT ALL. The seat runs on a tier whose hook denies every
// file-writing tool by NAME and exempts MCP tools, so this server is the only way
// it can write its goals file or its daily log (DECISIONS.md 2026-09-02). The
// route that lost was a destination-aware guard, and it lost on a specific
// argument: a write that lands in an allowed folder but breaks the STORE's rules
// passes a path check with no error anywhere. So the refusals below are not
// hygiene - they are the entire reason this surface exists instead of a guard
// exemption, and a green suite with them missing would be a green suite on the
// wrong design.
//
// Two of them get more than a happy-path assertion:
//   - TRAVERSAL is checked at both layers separately (the day-shape gate AND the
//     containment gate), because a test that only drives the public API stays
//     green when either one is broken - the other catches it, and "something
//     refused it" is not the same as "both gates work".
//   - CONCURRENT APPEND is checked with real parallel processes. The log is the
//     seat's memory substitute, and the classic read-modify-write would lose a
//     sibling's paragraph with nothing anywhere saying so.
//
// Pure node, no Electron, so it runs in the fast lane.
//
// Run: node scripts/e2e/test-assistant-store.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const toolsPath = path.join(repo, "src", "mcp", "assistantStoreTools.js");
const serverPath = path.join(repo, "src", "mcp", "assistantStoreServer.js");
const temps = [];

function freshStore(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `helm-assistant-${label}-`));
  temps.push(root);
  // The seam. Without it this whole check would run against his real goals and
  // the seat's real log, which is not a store you can regenerate.
  process.env.HELM_ASSISTANT_STORE_DIR = root;
  return root;
}

const pad = (n) => String(n).padStart(2, "0");
function dayOffset(n) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Set the env var BEFORE the module loads, so nothing in it can capture a
// directory from the real environment at import time.
freshStore("boot");
const store = await import(pathToFileURL(toolsPath).href);
const { readGoals, writeGoals, appendLog, readLog, changesSince } = store;
const { isValidDay, isDirectChildOf, resolveDayFile, logDir, goalsFile, todayStamp, resolveStoreDir } = store;

const TODAY = todayStamp();

// --- an empty store answers honestly ----------------------------------------
{
  const dir = freshStore("empty");
  ok(resolveStoreDir() === dir, "the env seam points the store at the fixture, not at the real folder");
  const g = readGoals();
  ok(g.exists === false && g.content === "", "an absent GOALS.md reports itself absent rather than as an empty document");
  const l = readLog();
  ok(l.exists === false && Array.isArray(l.availableDays) && l.availableDays.length === 0, "an absent day reports itself absent and lists no days");
  ok(/log is empty/i.test(l.note || ""), `and says the record is empty rather than just returning nothing (${l.note})`);
  const c = changesSince({ since: dayOffset(-3) });
  ok(c.days.length === 0 && c.goals.exists === false, "changes-since on an empty store returns nothing changed instead of erroring");
}

// --- goals: read, write, and the refusals that make this a store ------------
{
  const dir = freshStore("goals");
  const file = goalsFile(dir);

  ok(!!writeGoals({ content: "" }).error, "an empty goals write is refused - there is no legitimate 'blank his goals'");
  ok(!!writeGoals({ content: "   \n  \n" }).error, "and so is a whitespace-only one");
  const noHeading = writeGoals({ content: "just some prose with no heading at all" });
  ok(!!noHeading.error && /heading/i.test(noHeading.error), `a document with no top-level heading is refused as a botched rewrite (${noHeading.error?.slice(0, 60)})`);
  ok(!fs.existsSync(file), "and none of those refusals created the file");

  const full = ["# Goals", "", "## Horizon", "", "- Find something better. Confirmed " + TODAY + ".", "- Ship the thing.", "", "## Standing constraints", "", "- Done is a joint decision.", ""].join("\n");
  const wrote = writeGoals({ content: full });
  ok(wrote.ok === true, "a whole-document write succeeds");
  ok(fs.readFileSync(file, "utf8").endsWith("\n"), "the file ends with a newline, matching every other store here");
  const read = readGoals();
  ok(read.exists === true && read.content.includes("Done is a joint decision"), "and reading it back returns what was written");
  ok(typeof read.modifiedAt === "string" && read.modifiedAt.length > 0, "read_goals returns the modifiedAt that write_goals wants back");

  // The invariant a destination-aware guard could not have enforced: this write is
  // in an allowed folder, so a path check would have taken it silently.
  const shrunk = writeGoals({ content: "# Goals\n" });
  ok(!!shrunk.error && /allowShrink/.test(shrunk.error), `a write that cuts the document by more than half is refused (${shrunk.error?.slice(0, 80)})`);
  ok(readGoals().content.includes("Standing constraints"), "and the document is untouched - a refused write is not a half-write");
  const deliberate = writeGoals({ content: "# Goals\n\n- One line, deliberately.\n", allowShrink: true });
  ok(deliberate.ok === true, "the same write goes through when the caller says it means it, so deleting a section is still possible");

  // The lost-update guard. mtime is set explicitly rather than trusting the clock
  // to tick between two writes in the same millisecond.
  const stamped = readGoals();
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(file, past, past);
  const stale = writeGoals({ content: "# Goals\n\n- Written from a stale read.\n", ifUnchangedSince: stamped.modifiedAt, allowShrink: true });
  ok(!!stale.error && /changed since you read it/i.test(stale.error), `a write from a stale read is refused rather than dropping the other editor (${stale.error?.slice(0, 70)})`);
  ok(readGoals().content.includes("One line, deliberately"), "and the other editor's version survives");
  const current = readGoals();
  const fresh = writeGoals({ content: "# Goals\n\n- Written from a current read.\n", ifUnchangedSince: current.modifiedAt, allowShrink: true });
  ok(fresh.ok === true, "and the same guard lets a current read through");
}

// --- the log: append, read, and one heading per day -------------------------
{
  const dir = freshStore("log");
  ok(!!appendLog({ text: "" }).error, "an empty log entry is refused - it is indistinguishable from having written nothing");
  ok(!!appendLog({ text: "   " }).error, "and so is a whitespace-only one");

  const first = appendLog({ text: "Designed the store surface." });
  ok(first.ok === true && first.date === TODAY && first.created === true, `an append with no date creates today's file (${first.date})`);
  const dayFile = path.join(logDir(dir), `${TODAY}.md`);
  ok(fs.existsSync(dayFile), "at log/YYYY-MM-DD.md, matching the real store's layout exactly");
  const second = appendLog({ text: "Corrected myself on the goals file.", heading: "Later the same day" });
  ok(second.ok === true && second.created === false, "a second append adds to the same day rather than starting a new file");
  const text = fs.readFileSync(dayFile, "utf8");
  ok(text.split("\n").filter((l) => l === `# ${TODAY}`).length === 1, "the day carries exactly one top-level heading");
  ok(text.includes("## Later the same day"), "an optional heading lands as a `## ` section");
  ok(text.includes("Designed the store surface.") && text.includes("Corrected myself"), "and both entries are still there");

  const yesterday = dayOffset(-1);
  ok(appendLog({ date: yesterday, text: "Backfilled." }).ok === true, "a past day can be written, which is what a correction written the next morning needs");
  const back = readLog({ date: yesterday });
  ok(back.exists === true && back.content.includes("Backfilled."), "and reading that day back returns it");
  const tomorrow = dayOffset(1);
  const future = appendLog({ date: tomorrow, text: "Has not happened." });
  ok(!!future.error && /future/i.test(future.error), `a future-dated entry is refused - it would show up as work that already happened (${future.error?.slice(0, 60)})`);
  ok(!fs.existsSync(path.join(logDir(dir), `${tomorrow}.md`)), "and no file is created for it");

  const missing = readLog({ date: dayOffset(-40) });
  ok(missing.exists === false && missing.availableDays.includes(TODAY), "a day with no entry names the days that DO exist, so 'nothing happened' and 'nothing was written' stay different answers");
}

// --- REFUSALS: nothing outside those two files ------------------------------
{
  const dir = freshStore("refuse");
  fs.mkdirSync(logDir(dir), { recursive: true });

  // The persona file is in the same folder and is NOT the seat's to write. `../CLAUDE`
  // resolves exactly onto it, which is the traversal that matters here rather than a
  // theoretical one.
  const persona = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(persona, "# the persona, not the seat's to write\n", "utf8");
  // An absolute path somewhere else entirely, with a canary at the exact file a
  // naive `${date}.md` join would have written.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "helm-assistant-outside-"));
  temps.push(outside);
  const canary = path.join(outside, "canary.md");
  fs.writeFileSync(canary, "untouched\n", "utf8");

  const badDays = [
    "..",
    "../CLAUDE",
    "../../GOALS",
    "log/2026-09-02",
    "2026-09-02.md",
    "2026-9-2",
    "2026-13-45",
    "2026-02-30",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    path.join(outside, "canary"),
    "",
    "today",
  ];
  for (const day of badDays) {
    // "" means "today" by design for read/append, so it is only a refusal for the
    // window read, where a missing `since` has no sensible default.
    if (day !== "") {
      const r = readLog({ date: day });
      ok(!!r.error, `read_log refuses ${JSON.stringify(day)}`);
      const a = appendLog({ date: day, text: "should never land" });
      ok(!!a.error, `append_log refuses ${JSON.stringify(day)}`);
    }
    const c = changesSince({ since: day });
    ok(!!c.error, `changes_since refuses ${JSON.stringify(day)}`);
  }
  ok(fs.readFileSync(persona, "utf8").startsWith("# the persona"), "the persona file next door is untouched by any of it");
  ok(fs.readFileSync(canary, "utf8") === "untouched\n", "and so is a file at an absolute path outside the store");
  ok(fs.readdirSync(logDir(dir)).length === 0, "no refused append left a file in the log folder");
  ok(fs.readdirSync(dir).sort().join(",") === "CLAUDE.md,log", `and nothing new appeared in the store folder (${fs.readdirSync(dir).join(",")})`);

  // BOTH LAYERS, SEPARATELY. Driving only the public API above leaves either gate
  // free to break silently, because the other one still refuses.
  ok(isValidDay("2026-09-02") === true, "layer 1: a real day is a day");
  for (const bad of ["..", "../x", "2026-9-2", "2026-13-45", "2026-02-30", "2026-09-02.md", "", null, undefined, 20260902]) {
    ok(isValidDay(bad) === false, `layer 1: isValidDay rejects ${JSON.stringify(bad)}`);
  }
  const logs = logDir(dir);
  ok(isDirectChildOf(logs, path.join(logs, "2026-09-02.md")) === true, "layer 2: a real day file is inside the log folder");
  ok(isDirectChildOf(logs, path.resolve(logs, "..", "CLAUDE.md")) === false, "layer 2: the persona file one level up is NOT inside it");
  ok(isDirectChildOf(logs, path.join(logs, "nested", "2026-09-02.md")) === false, "layer 2: a nested path is not a log file either - the log is flat");
  ok(isDirectChildOf(logs, canary) === false, "layer 2: an absolute path elsewhere is not inside it");
  ok(isDirectChildOf(logs, logs) === false, "layer 2: the folder itself is not a file in it");
  // Same folder, two Windows spellings. A raw string compare misses this, which is
  // the mismatch that made every path-keyed cache in this repo miss on 2026-08-12.
  ok(isDirectChildOf(logs.replace(/\\/g, "/").toUpperCase(), path.join(logs, "2026-09-02.md")) === true, "layer 2: containment folds case and separators, so one spelling of the folder is not a hole");
  ok(!!resolveDayFile(dir, "../CLAUDE").error, "resolveDayFile refuses rather than repairing the path");
  ok(resolveDayFile(dir, "2026-09-02").file === path.join(logs, "2026-09-02.md"), "and resolves a real day to the file it should");
}

// --- what changed since a given day ----------------------------------------
{
  const dir = freshStore("changes");
  const d4 = dayOffset(-4);
  const d3 = dayOffset(-3);
  const d1 = dayOffset(-1);
  appendLog({ date: d4, text: "Four days ago - before the window." });
  appendLog({ date: d3, text: "Three days ago - the boundary day." });
  appendLog({ date: d1, text: "Yesterday." });
  appendLog({ text: "Today." });
  // Invented fixture content in the store's own shape. Real goal text would put a
  // person's situation into the repo, which is a rule here for a reason - and it
  // would tell you nothing extra about whether the date scan works.
  writeGoals({ content: `# Goals\n\n- Finish the second thing: confirmed ${d1}, still the priority.\n- An older line, stamped 2020-01-02, outside every window in this check.\n` });

  const c = changesSince({ since: d3 });
  const dates = c.days.map((d) => d.date);
  ok(dates.join(",") === [d3, d1, TODAY].join(","), `only the days from \`since\` onwards come back, oldest first (${dates.join(",")})`);
  ok(dates.includes(d3), "`since` is INCLUSIVE - an entry written late on the day you last looked is still news");
  ok(!dates.includes(d4), "and the day before the window is not in it");
  ok(c.days.find((d) => d.date === d1).text.includes("Yesterday."), "each day comes back with its text");
  ok(c.missingDays.includes(dayOffset(-2)), `the gap in the record is named, not just the days that exist (${c.missingDays.join(",")})`);
  ok(c.gapsEnumerated === true, "and the check says whether it enumerated the gaps at all");
  ok(c.today === TODAY, "the answer states which day it considers today");

  ok(c.goals.changedInWindow === true, "GOALS.md is reported as changed in the window");
  const lines = c.goals.datedLines.map((l) => l.text).join(" | ");
  ok(/still the priority/.test(lines), `and the line carrying a date in the window is surfaced (${lines.slice(0, 70)})`);
  ok(!/An older line/.test(lines), "while a line whose date is older than the window is not");
  ok(/lead|not versioned|convention/i.test(c.note || ""), "the answer says out loud that the goals half is a lead rather than a textual diff");

  const thin = changesSince({ since: d3, includeText: false });
  ok(thin.days.length === 3 && thin.days.every((d) => d.text === undefined), "includeText:false returns the shape without the prose");

  // A goals file that moved with nothing dated in it is a REPORTED condition, not
  // a silent one: the convention is to stamp the line you changed, and a write that
  // skipped it leaves no way to see what moved.
  writeGoals({ content: "# Goals\n\n- Rewritten with no date stamp anywhere.\n", allowShrink: true });
  const unstamped = changesSince({ since: d3 });
  ok(unstamped.goals.changedInWindow === true && unstamped.goals.datedLines.length === 0, "a goals write with no date stamp still shows as changed");
  ok(/did not stamp/i.test(unstamped.goals.note || ""), `and the answer says the stamp is missing (${unstamped.goals.note})`);

  // An old file must not read as changed just because it is there.
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  fs.utimesSync(goalsFile(dir), old, old);
  ok(changesSince({ since: d3 }).goals.changedInWindow === false, "an untouched goals file is reported as unchanged");

  const ahead = changesSince({ since: dayOffset(3) });
  ok(ahead.days.length === 0 && /after today/i.test(ahead.note || ""), "a `since` in the future returns nothing with a reason, rather than an error");

  // A long day is truncated with the tool to call for the rest, not silently cut.
  const big = "x".repeat(20000);
  appendLog({ date: d1, text: big });
  const budgeted = changesSince({ since: d1 });
  const bigDay = budgeted.days.find((d) => d.date === d1);
  ok(bigDay.truncated === true && bigDay.text.length === 12000, `a long day is truncated at a stated budget (${bigDay.text.length})`);
  ok(/assistant_read_log/.test(bigDay.note || ""), "and names the tool that returns the rest");
}

// --- a concurrent append never clobbers a sibling ---------------------------
{
  const dir = freshStore("concurrent");
  // No `day` captured here on purpose: pinning one and reading only its file is what made this
  // block report a loss that had not happened. Each child files under the day it computes at
  // write time, so the assertions below read whatever day files exist.
  const runner = path.join(dir, "append-one.mjs");
  fs.writeFileSync(
    runner,
    [
      "// Written by test-assistant-store.mjs: one append, in its own process.",
      `import { appendLog } from ${JSON.stringify(pathToFileURL(toolsPath).href)};`,
      "const res = appendLog({ text: `entry ${process.argv[2]}` });",
      "process.exit(res.ok ? 0 : 1);",
    ].join("\n"),
    "utf8"
  );
  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [runner, String(i)], {
          env: { ...process.env, HELM_ASSISTANT_STORE_DIR: dir },
          stdio: "ignore",
        });
        child.on("exit", (code) => resolve(code));
        child.on("error", () => resolve(-1));
      })
    )
  );
  ok(
    results.every((c) => c === 0),
    `all ${N} concurrent appends reported success (${results.join(",")})`
  );
  // Read EVERY day file, not just today's. `day` is captured once when this test starts,
  // while each child computes its own day at write time - so a run that straddles midnight
  // puts a writer's entry in tomorrow's file, and a single-file read reports that as lost.
  // That flake looks exactly like the data-loss bug this block exists to catch, which is the
  // worst kind: it teaches you to re-run until it passes. Reported once from a loaded CI
  // simulation as "8 reported success, 7 landed"; the store was then driven with 80 real
  // concurrent process writes under load with no loss at all, which is what pointed here.
  const dayFiles = fs.readdirSync(logDir(dir)).filter((f) => f.endsWith(".md"));
  const bodies = dayFiles.map((f) => fs.readFileSync(path.join(logDir(dir), f), "utf8"));
  const content = bodies.join("\n");
  const landed = Array.from({ length: N }, (_, i) => `entry ${i}`).filter((line) => content.includes(line));
  ok(
    landed.length === N,
    `and all ${N} entries are on disk - a read-modify-write would have lost the losers (${landed.length}/${N} across ${dayFiles.length} day file${dayFiles.length === 1 ? "" : "s"})`
  );
  // One heading PER FILE, since a midnight straddle legitimately produces two files and each
  // of them must still have been created exactly once.
  const headingCounts = bodies.map((body, i) => body.split("\n").filter((l) => l === `# ${dayFiles[i].replace(/\.md$/, "")}`).length);
  ok(
    headingCounts.every((n) => n === 1),
    `with exactly one day heading in each day file (${headingCounts.join(",")}), so the exclusive create really is exclusive`
  );
}

// --- the real MCP surface, over stdio ---------------------------------------
{
  const dir = freshStore("stdio");
  fs.mkdirSync(logDir(dir), { recursive: true });
  fs.writeFileSync(goalsFile(dir), "# Goals\n\n- Something to read.\n", "utf8");

  function talk(requests) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [serverPath], {
        env: { ...process.env, HELM_ASSISTANT_STORE_DIR: dir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      const wanted = requests.filter((r) => r.id !== undefined).length;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`the MCP server did not answer in time (stderr: ${err.slice(0, 400)})`));
      }, 20000);
      child.stderr.on("data", (d) => (err += d));
      child.stdout.on("data", (d) => {
        out += d;
        const replies = out.split("\n").filter(Boolean);
        if (replies.length >= wanted) {
          clearTimeout(timer);
          child.kill();
          resolve(replies.map((l) => JSON.parse(l)));
        }
      });
      child.on("error", reject);
      for (const r of requests) {
        child.stdin.write(JSON.stringify(r) + "\n");
      }
    });
  }

  const replies = await talk([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "assistant_read_goals", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "assistant_append_log", arguments: { date: "../CLAUDE", text: "should never land" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "assistant_write_goals", arguments: { content: "" } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "write_file", arguments: { path: "anything", content: "x" } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "assistant_append_log", arguments: { text: "Wrote the store surface." } } },
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "assistant_changes_since", arguments: { since: TODAY } } },
  ]);
  const payload = (id) => JSON.parse(replies.find((r) => r.id === id)?.result?.content?.[0]?.text || "{}");

  const init = replies.find((r) => r.id === 1)?.result;
  ok(init?.serverInfo?.name === "assistant", `the server names itself the same as its mcp-config key (${init?.serverInfo?.name})`);
  ok(String(init?.instructions || "").includes(dir), "and the handshake says WHICH folder it is pointed at - a relocated store otherwise looks identical to an empty one");
  ok(String(init?.instructions || "").includes(TODAY), "and what it thinks today is, since a stale idea of today files an entry under the wrong day");

  const tools = replies.find((r) => r.id === 2)?.result?.tools || [];
  const names = tools.map((t) => t.name).sort();
  ok(
    names.join(",") === ["assistant_append_log", "assistant_changes_since", "assistant_read_goals", "assistant_read_log", "assistant_write_goals"].join(","),
    `exactly the five tools, and no general file write (${names.join(",")})`
  );
  ok(!tools.some((t) => /write_file|read_file|edit|path/i.test(t.name)), "nothing here takes a file path as its subject - that is the design, not an omission");
  // The prefix is what buys the write access. The tier guard strips `mcp__<server>__`
  // and decides from the bare name, exempting a short list of store prefixes, so a
  // tool renamed out of `assistant_` would read as a generic write and be denied -
  // and the seat would lose the exact capability this server exists to give it.
  ok(
    tools.every((t) => t.name.startsWith("assistant_")),
    `every tool keeps the \`assistant_\` prefix the tier guard exempts (${names.filter((n) => !n.startsWith("assistant_")).join(",") || "all of them"})`
  );
  for (const [tool, required] of [
    ["assistant_write_goals", "content"],
    ["assistant_append_log", "text"],
    ["assistant_changes_since", "since"],
  ]) {
    const schema = tools.find((t) => t.name === tool)?.inputSchema;
    ok((schema?.required || []).includes(required), `${tool} declares ${required} required, so the CLI itself refuses an omission`);
  }
  const changesDesc = String(tools.find((t) => t.name === "assistant_changes_since")?.description || "");
  ok(/inclusive/i.test(changesDesc), "the changes tool states that `since` is inclusive - a caller cannot infer that");
  ok(/lead|not a textual diff/i.test(changesDesc), "and that the goals half is a lead rather than a diff");

  ok(payload(3).content?.includes("Something to read."), "read_goals over the wire returns the document");
  ok(!!payload(4).error, `a traversal date is refused over the wire too, not only in-process (${String(payload(4).error).slice(0, 60)})`);
  ok(!fs.existsSync(path.join(dir, "CLAUDE.md")), "and the persona file was not created by it");
  ok(!!payload(5).error, "an empty goals write is refused over the wire");
  ok(/Unknown tool/.test(String(payload(6).error)) && /assistant_read_goals/.test(String(payload(6).error)), "an unknown tool is refused by name and told what does exist");
  ok(payload(7).ok === true && payload(7).date === TODAY, "an append over the wire lands in today's file");
  ok(payload(8).days?.some((d) => d.date === TODAY && /Wrote the store surface/.test(d.text || "")), "and changes_since immediately reflects it");
}

for (const t of temps) {
  try {
    fs.rmSync(t, { recursive: true, force: true });
  } catch {
    /* a temp we cannot remove is not a test failure */
  }
}
console.log(
  exit === 0
    ? "\nVERIFY OK: the seat can write its goals and its log, both traversal gates hold independently, concurrent appends all land, and nothing else in the folder is reachable."
    : "\nVERIFY FAILED"
);
process.exit(exit);
