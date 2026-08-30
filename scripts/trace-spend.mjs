// What did the last N minutes of Helm actually cost, and WHO spent it?
//
// Written 2026-08-30 after two passive drains were found by hand, one of which had been
// running for months: auto-compact re-doing the same work every fifteen minutes, and a
// model-fit judge that cost more than the work it judged. Both were invisible because
// Helm's own usage log recorded almost none of it - 634 compactions against 5 logged rows.
//
// So this does not read Helm's log. It reads the TRANSCRIPTS, which are written by the CLI
// itself and cannot be skipped by a mechanism that forgot to book its own spend. Every
// `claude` process leaves one, whoever started it and whatever it was for.
//
//   node scripts/trace-spend.mjs            the last 30 minutes
//   node scripts/trace-spend.mjs 120        the last two hours
//   node scripts/trace-spend.mjs 30 --full  every session listed, not just the top ten
//
// Read the "started by" column: anything not YOU is Helm spending on its own behalf.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const minutes = Number(process.argv.find((a) => /^\d+$/.test(a)) || 30);
const full = process.argv.includes("--full");
const since = Date.now() - minutes * 60_000;

const root = path.join(os.homedir(), ".claude", "projects");

/**
 * Who started a session, inferred from what the CLI wrote rather than from Helm's own
 * bookkeeping - which is the whole point, since the bookkeeping is what was wrong.
 */
function classify(firstUser) {
  // ONLY the first user message decides. The first version of this also looked for
  // compaction markers anywhere in the transcript, which classified every long session
  // that had ever been compacted - including this tool's own author's - as "auto-compact",
  // and reported 280 million tokens of spend that nobody had spent. A session that WAS
  // compacted is not a session that IS a compaction.
  const head = firstUser.trim();
  if (/^\/compact/.test(head)) {
    return "auto-compact";
  }
  if (/^Task: [\s\S]{0,400}?Model used:/m.test(head) || /Judge whether this model\+effort choice/.test(head)) {
    return "model-fit judge (removed 2026-08-30)";
  }
  if (/Classify this session's current status/.test(head)) {
    return "status classifier";
  }
  if (/You are reading a transcript of a meeting/.test(head)) {
    return "meeting transcription";
  }
  return "you";
}

const rows = [];
for (const proj of fs.readdirSync(root)) {
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(root, proj));
  } catch {
    continue;
  }
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) {
      continue;
    }
    const p = path.join(root, proj, f);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.mtimeMs < since) {
      continue;
    }

    let lines;
    try {
      lines = fs.readFileSync(p, "utf8").split("\n");
    } catch {
      continue;
    }

    // Only the turns INSIDE the window - a long-lived session must not have its whole
    // history charged to the last half hour.
    let firstUser = "";
    let model = "";
    let calls = 0;
    const t = { write: 0, read: 0, out: 0 };
    for (const line of lines) {
      if (!line) {
        continue;
      }
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!firstUser) {
        const c = o?.message?.content;
        if (o?.type === "user" && typeof c === "string") {
          firstUser = c;
        } else if (o?.type === "user" && Array.isArray(c)) {
          firstUser = c.find((x) => x?.type === "text")?.text || "";
        }
      }
      const at = o.timestamp ? Date.parse(o.timestamp) : null;
      if (at !== null && at < since) {
        continue;
      }
      const u = o?.message?.usage;
      if (u) {
        calls++;
        t.write += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        t.read += u.cache_read_input_tokens || 0;
        t.out += u.output_tokens || 0;
        if (o?.message?.model) {
          model = o.message.model;
        }
      }
    }
    if (calls === 0) {
      continue;
    }
    rows.push({
      id: f.slice(0, 8),
      proj: proj.slice(0, 34),
      who: classify(firstUser),
      model: (model || "?").replace("claude-", ""),
      calls,
      ...t,
      prompt: firstUser.replace(/\s+/g, " ").slice(0, 58),
    });
  }
}

rows.sort((a, b) => b.write + b.read - (a.write + a.read));

console.log(`Everything the CLI ran in the last ${minutes} minutes, from the transcripts.`);
console.log("");
if (rows.length === 0) {
  console.log("  nothing ran.");
  process.exit(0);
}

const byWho = {};
for (const r of rows) {
  byWho[r.who] = byWho[r.who] || { write: 0, read: 0, out: 0, n: 0 };
  byWho[r.who].write += r.write;
  byWho[r.who].read += r.read;
  byWho[r.who].out += r.out;
  byWho[r.who].n++;
}

console.log("  started by                              runs      written         read       output");
for (const [who, v] of Object.entries(byWho).sort((a, b) => b[1].write - a[1].write)) {
  console.log(
    `  ${who.padEnd(38)} ${String(v.n).padStart(4)}  ${v.write.toLocaleString().padStart(11)}  ${v.read.toLocaleString().padStart(11)}  ${v.out.toLocaleString().padStart(11)}`
  );
}

console.log("");
// FRESH input is the honest comparison. "read" is cache reuse: real, much cheaper, and it
// grows with the length of a conversation rather than with what a mechanism decided to do -
// so summing the two into one figure makes a long chat look like a runaway cost.
const freshMine = (byWho["you"] || { write: 0 }).write;
const freshTheirs = Object.entries(byWho)
  .filter(([w]) => w !== "you")
  .reduce((n, [, v]) => n + v.write, 0);
console.log(`  fresh input YOU asked for:        ${freshMine.toLocaleString()}`);
console.log(`  fresh input Helm spent by itself: ${freshTheirs.toLocaleString()}${freshMine > 0 ? `   (${Math.round((freshTheirs / freshMine) * 100)}% of yours)` : ""}`);
console.log("  (the read column is cache reuse - real, but far cheaper, and it grows with conversation length)");

console.log("");
console.log("  the individual runs:");
for (const r of (full ? rows : rows.slice(0, 10))) {
  console.log(
    `    ${r.id}  ${r.who.padEnd(38)} ${r.model.padEnd(24)} ${String(r.calls).padStart(3)} call(s)  write ${String(r.write).padStart(8)}  read ${String(r.read).padStart(8)}`
  );
  console.log(`              ${r.prompt}`);
}
if (!full && rows.length > 10) {
  console.log(`    ... and ${rows.length - 10} more - pass --full to see them all.`);
}
