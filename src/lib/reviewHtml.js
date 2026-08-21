/**
 * Renders a WHOLE review as a self-contained HTML page - the record's claims, its
 * gaps, its checks and their real outcomes, the manual steps, the independent
 * reviewer's verdict, and only then the diff.
 *
 * the captain, task ccbf82e2: "i review lades present diff till. Jag vill inte presentera
 * diffen i en html likt summary page - jag vill presentera hela reviewn så den blir
 * mer lättläst." The first version of this file rendered the patch and nothing else,
 * which got the artifact wrong: the diff is the part that is ALREADY readable in the
 * app's own viewer, and the part that is hard to read on a cramped panel is the card
 * body - warnings, evidence, gaps, checks, steps, verdict - which is exactly what a
 * full-width page with real typography helps with. So the page is the review, and the
 * diff is its last section.
 *
 * Pure string building, no DOM - so it runs in the main process and is written
 * straight to disk. Deliberately NOT the renderer's card builder: that one makes live
 * DOM for an Electron window; this produces a standalone file that opens in the OS
 * browser and survives outside the app.
 *
 * Also serves the commit-centric rows (`kind: "commit"`) - work with no Jot task and
 * therefore no record. That page states the absence plainly instead of rendering a
 * confident empty card, for the same reason the in-app row does.
 */
import { intentSourceNote } from "./intent.js";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Just enough markdown for an agent-written verdict: headings, bullets, numbered
 * items, fenced and inline code, bold, and paragraphs.
 *
 * Escaping happens FIRST, on the raw text, and every tag below is emitted by this
 * function itself - so no span of the input can become markup. That ordering is the
 * whole safety argument, and it is why this does not reach for a markdown library:
 * the file being rendered is agent-authored, and the smaller the surface that turns
 * it into HTML, the smaller the thing that has to be right.
 */
function mdToHtml(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let list = null; // "ul" | "ol" | null
  let para = [];
  let fence = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const closePara = () => {
    if (para.length > 0) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, (_m, b) => `<strong>${b}</strong>`);

  for (const raw of lines) {
    const line = esc(raw);
    const fenceMatch = /^\s*```/.test(raw);
    if (fenceMatch) {
      if (fence === null) {
        closePara();
        closeList();
        fence = [];
      } else {
        out.push(`<pre class="md-code">${fence.join("\n")}</pre>`);
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      fence.push(line);
      continue;
    }
    const heading = raw.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closePara();
      closeList();
      const level = Math.min(heading[1].length + 2, 6); // #  -> h3, so it sits under the page's h2s
      out.push(`<h${level}>${inline(esc(heading[2]))}</h${level}>`);
      continue;
    }
    const bullet = raw.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      closePara();
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(esc(bullet[1]))}</li>`);
      continue;
    }
    const numbered = raw.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      closePara();
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(esc(numbered[1]))}</li>`);
      continue;
    }
    if (!raw.trim()) {
      closePara();
      closeList();
      continue;
    }
    para.push(line);
  }
  if (fence !== null) {
    // An unterminated fence still renders as code rather than swallowing the tail.
    out.push(`<pre class="md-code">${fence.join("\n")}</pre>`);
  }
  closePara();
  closeList();
  return out.join("\n");
}

/** Split a unified patch (possibly several `git show` blocks concatenated) into per-file chunks. */
function splitDiffIntoFiles(diffText) {
  const lines = String(diffText || "").split(/\r?\n/);
  const files = [];
  let current = null;
  for (const line of lines) {
    if (/^diff --git /.test(line)) {
      if (current) {
        files.push(current);
      }
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      current = { path: m ? m[2] : line.slice(11), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    files.push(current);
  }
  return files;
}

function lineClass(line) {
  if (/^\+\+\+|^---/.test(line)) {
    return "hunk";
  }
  if (line.startsWith("+")) {
    return "add";
  }
  if (line.startsWith("-")) {
    return "rem";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (/^diff --git |^index |^new file|^deleted file|^similarity index|^rename (from|to)/.test(line)) {
    return "meta";
  }
  return "ctx";
}

function fileBlockHtml(file, index) {
  const body = file.lines.map((l) => `<span class="dl ${lineClass(l)}">${esc(l) || "&nbsp;"}</span>`).join("\n");
  // Only the first few open by default. The diff is the LAST section of this page now,
  // so having it unfurl to thousands of lines would bury everything above it on any
  // scrollbar-driven sense of "how much is there".
  return `<details class="file" ${index < 4 ? "open" : ""}>
  <summary>${esc(file.path)}</summary>
  <pre class="patch">${body}</pre>
</details>`;
}

function section(title, inner, cls = "") {
  if (!inner) {
    return "";
  }
  return `<section class="${cls}"><h2>${esc(title)}</h2>${inner}</section>`;
}

function bulletList(items, render = (x) => esc(x)) {
  if (!items || items.length === 0) {
    return "";
  }
  return `<ul>${items.map((i) => `<li>${render(i)}</li>`).join("")}</ul>`;
}

/**
 * Entries are either a plain string or {claim, detail}.
 *
 * The two halves used to be glued into ONE line with an em dash, which made every
 * entry as long as its longest possible explanation - so the page was complete and
 * unreadable at the same time, and the reader had no way to skip the part he did not
 * need. The captain, 2026-08-20: "man kanske kan ha en explain knapp bredvid som kan
 * förklara i en ruta och/eller en expander med en längre beskrivning per punkt."
 *
 * So the claim is always visible and the detail sits behind a native <details>. No
 * script, works in a saved file, and the short version is what you get by default.
 * Nothing is dropped - the honest long half is one click away instead of gone.
 */
function evidenceText(item) {
  if (typeof item === "string") {
    return esc(item);
  }
  const claim = item?.claim || "";
  const detail = item?.detail || "";
  if (!detail) {
    return esc(claim);
  }
  if (!claim) {
    return esc(detail);
  }
  return `<details class="why"><summary>${esc(claim)}</summary><div class="why-body">${esc(detail)}</div></details>`;
}

function chipHtml(text, cls = "") {
  return `<span class="chip ${cls}">${esc(text)}</span>`;
}

function when(ms) {
  if (!ms) {
    return "";
  }
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

/** One declared check and what actually happened when it ran. */
function checkHtml(c) {
  const tone =
    c.state === "passed" ? "ok" : c.state === "failed" ? "bad" : c.state === "unusable" || c.state === "unverified" ? "bad" : "warn";
  const said =
    c.state === "passed"
      ? `passed (exit ${c.exitCode}) · ${when(c.ranAt)}`
      : c.state === "failed"
        ? `FAILED (exit ${c.exitCode}) · ${when(c.ranAt)}`
        : c.state === "unrun"
          ? "never run"
          : c.state === "stale"
            ? `stale — ${c.staleReason || "the run no longer describes this code"}`
            : c.state === "unusable"
              ? "cannot fail, or declares no command — a green result from it means nothing"
              : "not stamped by the app — it is not a result at all, pass or fail";
  return `<div class="check ${tone}">
    <div class="check-head"><b>${esc(c.label)}</b> ${chipHtml(said, tone)}</div>
    ${c.cmd ? `<pre class="cmd">${esc(c.cmd)}</pre>` : ""}
    ${c.tail ? `<pre class="tail">${esc(String(c.tail).slice(-4000))}</pre>` : ""}
  </div>`;
}

const STYLE = `
  :root {
    --bg: #12141a; --panel: #1b1e27; --text: #e6e8ef; --muted: #9aa0b0;
    --green: #3ddc84; --red: #ff6b6b; --accent: #7aa2ff; --amber: #f4c95d;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.65 -apple-system, Segoe UI, Roboto, sans-serif; padding: 32px 24px 80px; }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 6px; line-height: 1.3; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
  .chips { display: flex; gap: 8px; margin-bottom: 24px; flex-wrap: wrap; }
  .chip { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; background: #262b38; color: var(--muted); white-space: nowrap; }
  .chip.ok { background: #16301f; color: var(--green); }
  .chip.bad { background: #3a1c1e; color: var(--red); }
  .chip.warn { background: #35301c; color: var(--amber); }
  .chip.add { color: var(--green); } .chip.rem { color: var(--red); }
  section { background: var(--panel); border-radius: 12px; padding: 18px 22px; margin-bottom: 16px; }
  section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 12px; }
  section.warn { background: #2c2419; border-left: 3px solid var(--amber); }
  section.danger { background: #2c1c1e; border-left: 3px solid var(--red); }
  section.lead { background: transparent; padding: 0 2px; margin-bottom: 24px; }
  section.lead p { font-size: 18px; line-height: 1.6; margin: 0; }
  /* Whose words the ask is in. Qualifies the sentence above it, so it must not compete
     with it - dimmer and smaller, the same relationship the card uses. */
  .provenance { font-size: 12.5px; color: var(--muted); margin: 6px 0 0; }
  ul, ol { margin: 0; padding-left: 22px; }
  li { margin-bottom: 7px; }
  p { margin: 0 0 12px; }
  .muted { color: var(--muted); }
  /* Progressive disclosure: the claim is the line, the explanation is one click in.
     Native <details>, so this works in a saved file with no script. The marker is
     styled rather than hidden - a line that expands has to LOOK like one, or the
     detail is there and nobody finds it. */
  details.why { display: block; }
  details.why > summary { cursor: pointer; list-style: none; display: block; }
  details.why > summary::-webkit-details-marker { display: none; }
  details.why > summary::after { content: " explain"; color: var(--muted); font-size: 12px; border: 1px solid #2a3040; border-radius: 3px; padding: 0 5px; margin-left: 7px; white-space: nowrap; }
  details.why[open] > summary::after { content: " hide"; }
  details.why > summary:hover::after { border-color: #3d465c; }
  details.why > summary:focus-visible { outline: 2px solid #5b7cfa; outline-offset: 2px; }
  .why-body { color: var(--muted); margin: 6px 0 2px; padding-left: 2px; border-left: 2px solid #262b38; padding-left: 10px; }
  code { background: #0d0f14; border-radius: 4px; padding: 1px 5px; font-family: Consolas, monospace; font-size: 13.5px; }
  pre.cmd, pre.tail, pre.md-code { background: #0d0f14; border-radius: 6px; padding: 10px 12px; overflow-x: auto; font-family: Consolas, monospace; font-size: 12.5px; line-height: 1.5; margin: 8px 0 0; }
  pre.tail { color: var(--muted); max-height: 320px; overflow-y: auto; }
  .check { padding: 12px 0; border-top: 1px solid #262b38; }
  .check:first-child { border-top: none; padding-top: 0; }
  .check-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .steps li { margin-bottom: 12px; }
  .steps .expect { display: block; color: var(--muted); font-size: 14px; }
  .verdict h3, .verdict h4 { font-size: 16px; margin: 18px 0 8px; }
  details.file { border: 1px solid #262b38; border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
  details.file summary { cursor: pointer; padding: 8px 12px; font-family: Consolas, monospace; font-size: 13px; background: #20242e; list-style: none; }
  details.file summary::-webkit-details-marker { display: none; }
  pre.patch { margin: 0; padding: 4px 0; overflow-x: auto; font-family: Consolas, monospace; font-size: 12.5px; line-height: 1.45; }
  .dl { display: block; padding: 0 12px; white-space: pre; }
  .dl.add { background: #0f2a1c; color: var(--green); }
  .dl.rem { background: #2a1414; color: var(--red); }
  .dl.hunk { color: var(--accent); background: #14181f; }
  .dl.meta { color: var(--muted); }
  .dl.ctx { color: #c2c6d4; }
  .truncated { color: var(--amber); font-size: 13px; margin-top: 8px; }
`;

function page(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${bodyHtml}
</div>
</body>
</html>`;
}

/** The diff section, shared by both page kinds. Always LAST - it is the appendix, not the review. */
function diffSection({ diffText, stats, truncated }) {
  const files = splitDiffIntoFiles(diffText);
  if (files.length === 0) {
    return section("The change", `<div class="muted">No diffable content was found for this.</div>`);
  }
  const added = stats?.added ?? (String(diffText).match(/^\+(?!\+\+)/gm) || []).length;
  const removed = stats?.removed ?? (String(diffText).match(/^-(?!--)/gm) || []).length;
  return section(
    "The change",
    `<div class="chips">
      ${chipHtml(`${files.length} file${files.length === 1 ? "" : "s"}`)}
      ${chipHtml(`+${added}`, "add")}
      ${chipHtml(`-${removed}`, "rem")}
    </div>
    ${files.map(fileBlockHtml).join("\n")}
    ${truncated ? `<div class="truncated">The patch was cut off at a commit boundary because it is very large - this is not all of it.</div>` : ""}`
  );
}

/**
 * A task's whole review.
 *
 * @param {object} opts
 * @param {object} opts.row  the review-queue row (title, taskId, verdict, band, problems,
 *   caveats, whyNotCritical, drift, gauntlet, criticality, category)
 * @param {object} opts.record  the review record
 * @param {Array<{sha:string,subject:string}>} [opts.commits]
 * @param {"record"|"log"|"none"} [opts.commitSource]
 * @param {string} [opts.diffText]
 * @param {object} [opts.stats]
 * @param {boolean} [opts.truncated]
 * @param {string|null} [opts.independentNote]  the independent reviewer's verdict text
 * @param {number|null} [opts.independentNoteAt]
 * @param {string|null} [opts.release]
 */
export function buildReviewHtml({
  row,
  record,
  commits = [],
  commitSource = "none",
  diffText = "",
  stats = null,
  truncated = false,
  independentNote = null,
  independentNoteAt = null,
  release = null,
}) {
  const rec = record || {};
  const g = row?.gauntlet || { declared: 0, state: "none", perCheck: [] };
  const parts = [];

  parts.push(`<h1>${esc(row?.title || rec.taskId || "Review")}</h1>`);
  parts.push(
    `<div class="meta">Task ${esc(String(row?.taskId || rec.taskId || "").slice(0, 8))}${
      row?.category ? ` · ${esc(row.category)}` : ""
    }${rec.projectPath ? ` · ${esc(rec.projectPath)}` : ""}</div>`
  );

  const chips = [];
  if (row?.criticality) {
    chips.push(chipHtml(row.criticality, row.criticality === "critical" ? "bad" : row.criticality === "core" ? "warn" : ""));
  }
  if (row?.verdict) {
    chips.push(chipHtml(`verdict: ${row.verdict}`, row.verdict === "stamp" ? "ok" : row.verdict === "judgment" ? "warn" : "bad"));
  }
  if (g.declared > 0) {
    chips.push(
      chipHtml(
        g.state === "passing" ? `checks ${g.passed}/${g.declared}` : g.state === "failing" ? "checks failing" : "checks unconfirmed",
        g.state === "passing" ? "ok" : g.state === "failing" ? "bad" : "warn"
      )
    );
  } else {
    chips.push(chipHtml("no declared checks", "warn"));
  }
  if (release) {
    chips.push(chipHtml(`shipped in ${release}`));
  }
  parts.push(`<div class="chips">${chips.join("")}</div>`);

  // The warnings come before anything the record claims, exactly as on the card: if
  // the claim is inadmissible, that has to be read before the claim is.
  if (row?.verdict === "unrecorded") {
    parts.push(
      section(
        "No review record",
        `<p>${esc((row.problems || []).join("; "))}. Nothing here has been verified for you — treat it as unreviewed.</p>`,
        "danger"
      )
    );
  } else if (row?.verdict === "incomplete") {
    parts.push(
      section(
        "This record does not meet its own bar",
        `<p>For a ${esc(row.criticality || "?")} item: ${esc((row.problems || []).join("; "))}. Read it, but do not treat it as verified.</p>`,
        "danger"
      )
    );
  }
  if (row?.drift?.drifted) {
    parts.push(
      section(
        "The acceptance criteria moved",
        `<p>They changed after this record was written (${row.drift.snapshot.length} then, ${row.drift.live.length} now) — the evidence may be answering the old question.</p>`,
        "warn"
      )
    );
  }

  // THE ASK CHANGED after this was written - usually because the captain corrected it, which
  // makes it the most useful line on the page. Above the summary, because if the question
  // moved then everything below is answering the old one.
  if (row?.intentDrift?.drifted) {
    parts.push(
      section(
        "What was asked for changed",
        `<p>It now reads: “${esc(row.intentDrift.live)}” — the work below was measured against the old wording.</p>`,
        "warn"
      )
    );
  }

  // WHAT WAS ASKED, then WHAT WAS DONE - the question before its answer, the same pair
  // and the same order as the card (task 10928bdf). Absence is printed, not skipped: a
  // page that quietly omits the ask reads as complete while missing the only thing the
  // work can be found WRONG against.
  const intent = row?.intent || null;
  if (intent) {
    // The wording comes from intent.js, not from a copy here. Three spellings of this one
    // sentence had already appeared while building this feature, and the card, this page
    // and the reviewer's brief disagreeing about how honest an intent is would be worse
    // than any of them being slightly clumsier. Only `fromTask` is local: it is a property
    // of the QUEUE row, not of the source, so intent.js has nothing to say about it.
    const note = intent.source === "captain"
      ? ""
      : intent.fromTask
        ? "Read from the task, not snapshotted when the work was handed over — so this is not what it was reviewed against at the time."
        : intentSourceNote(intent.source);
    parts.push(
      section(
        "Asked for",
        `<p>${esc(intent.text)}</p>${note ? `<p class="provenance">${esc(note)}</p>` : ""}`
      )
    );
  } else {
    parts.push(
      section(
        "Nobody wrote down what was asked for",
        "<p>So nothing here was reviewed against the ask — only against what the author says they did.</p>",
        "warn"
      )
    );
  }

  if (rec.summary) {
    parts.push(section("What was done", `<p>${esc(rec.summary)}</p>`, "lead"));
  }
  if (rec.verdict === "judgment" && rec.ask) {
    parts.push(section("Needs a decision from you", `<p>${esc(rec.ask)}</p>`, "warn"));
  }
  if (row?.caveats?.length > 0) {
    parts.push(section("Resting on the author's word", bulletList(row.caveats), "warn"));
  }
  if (row?.whyNotCritical) {
    parts.push(section("Why this is not critical", `<p>${esc(row.whyNotCritical)}</p>`));
  }

  // Headings frame every line under them, so they are written for the reader rather
  // than about the method. "Evidence — what the author says was checked" described the
  // process; "What I checked" asks for a line that names the worry and what happened.
  // Same for the gaps: naming them as RISK is what makes them act-on-able, and the
  // previous wording ("the gaps they declared") only said something about the author.
  parts.push(section("What I checked", bulletList(rec.evidence, evidenceText)));
  parts.push(section("What could still be wrong", bulletList(rec.notVerified, evidenceText), "warn"));

  if (Array.isArray(rec.acceptanceCriteria) && rec.acceptanceCriteria.length > 0) {
    parts.push(
      section(
        "Agreed up front",
        `<ol>${rec.acceptanceCriteria.map((c) => `<li>${esc(typeof c === "string" ? c : c.text)}</li>`).join("")}</ol>`
      )
    );
  }

  if (Array.isArray(rec.testSteps) && rec.testSteps.length > 0) {
    parts.push(
      section(
        "Walk through these yourself",
        `<ol class="steps">${rec.testSteps
          .map(
            (s) =>
              `<li>${esc(s.step)}<span class="expect">Expect: ${esc(s.expect)}</span>${
                s.ac !== undefined && s.ac !== null ? `<span class="expect">Checks criterion ${esc([].concat(s.ac).join(", "))}</span>` : ""
              }</li>`
          )
          .join("")}</ol>`
      )
    );
  }

  if (g.declared > 0) {
    parts.push(section("Checks, and what happened when they ran", (g.perCheck || []).map(checkHtml).join("")));
  }

  if (independentNote) {
    parts.push(
      section(
        `Independent reviewer${independentNoteAt ? ` · written ${when(independentNoteAt)}` : ""}`,
        `<div class="verdict">${mdToHtml(independentNote)}</div>`
      )
    );
  }

  if (commits.length > 0) {
    parts.push(
      section(
        "Commits",
        `<p class="muted">${
          commitSource === "record"
            ? "Named by the review record."
            : "Found by searching the log for this task's id — a guess, not a record."
        }</p>` + bulletList(commits, (c) => `<code>${esc(c.sha.slice(0, 8))}</code> ${esc(c.subject)}`)
      )
    );
  }

  parts.push(diffSection({ diffText, stats, truncated }));

  return page(`Review — ${row?.title || rec.taskId || ""}`, parts.join("\n"));
}

/**
 * A commit with no Jot task: everything that IS knowable about it, and a plain
 * statement of what is not.
 *
 * @param {object} opts
 * @param {{sha:string, shortSha:string, subject:string, body?:string, author?:string, date?:string}} opts.commit
 * @param {string} opts.projectName
 * @param {string} [opts.diffText]
 * @param {object} [opts.stats]
 * @param {boolean} [opts.truncated]
 * @param {string|null} [opts.independentNote]
 * @param {number|null} [opts.independentNoteAt]
 */
export function buildCommitReviewHtml({
  commit,
  projectName = "",
  diffText = "",
  stats = null,
  truncated = false,
  independentNote = null,
  independentNoteAt = null,
}) {
  const c = commit || {};
  const parts = [];
  parts.push(`<h1>${esc(c.subject || "(no subject)")}</h1>`);
  parts.push(
    `<div class="meta">${esc(c.shortSha || String(c.sha || "").slice(0, 8))}${projectName ? ` · ${esc(projectName)}` : ""}${
      c.author ? ` · ${esc(c.author)}` : ""
    }${c.date ? ` · ${esc(c.date)}` : ""}</div>`
  );
  parts.push(`<div class="chips">${chipHtml("no Jot task", "warn")}${chipHtml("no review record", "warn")}</div>`);

  // The same honesty the in-app card owes: this page has no record behind it, and
  // must not look like one that does.
  parts.push(
    section(
      "Nobody wrote down what to check",
      `<p>This commit is not tied to any Jot task, so there is no review record — no summary of intent, no declared evidence, no checks, no test steps. Everything below is read straight out of git. Treat it as unreviewed.</p>`,
      "warn"
    )
  );

  if (c.body && c.body.trim()) {
    parts.push(section("What the commit message says", `<div class="verdict">${mdToHtml(c.body)}</div>`));
  }

  if (independentNote) {
    parts.push(
      section(
        `Independent reviewer${independentNoteAt ? ` · written ${when(independentNoteAt)}` : ""}`,
        `<div class="verdict">${mdToHtml(independentNote)}</div>`
      )
    );
  }

  parts.push(diffSection({ diffText, stats, truncated }));
  return page(`Review — ${c.subject || c.shortSha || "commit"}`, parts.join("\n"));
}
