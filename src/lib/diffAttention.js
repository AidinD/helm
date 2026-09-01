/**
 * Which parts of a diff deserve a second pair of eyes - the second view the captain asked for.
 *
 * the captain, on the review page: "Vi kanske kan ha två vyer för diffen. 1. Som en vanlig diff.
 * 2. En diff med bara de delar som AI bedömt som behöver second opinion." The first view has
 * existed for months. This is the second, and it was blocked until a card could say which
 * commits were its own (commitBindings.js) - there is no diff to filter before that.
 *
 * ## Anchoring by snippet, not by line number
 *
 * A finding is useless unless it lands on the line it is about, and asking a model for a
 * line number is asking it to count - which is the thing it is worst at. A wrong number puts
 * a warning next to innocent code and, worse, takes attention off the line that earned it.
 *
 * So a finding names a SNIPPET: an exact fragment of the changed line it is about. The
 * anchor is then a search, which either finds that text in that file's diff or does not.
 * A snippet that cannot be found is dropped and counted, exactly as an invented sha is in
 * commitMatch.js - an answer that does not correspond to the question is not a formatting
 * problem, it is an answer about something else.
 *
 * ## What the view must not imply
 *
 * That the rest of the diff is fine. Nothing here reviewed the unflagged parts; the model
 * was asked what stands out and it answered, which is a different thing from a clean bill.
 * The renderer says so, and this module deliberately produces no "everything else is OK"
 * signal for it to render.
 */

/** Beyond this, the diff is cut and the caller is told - a silent truncation reads as "all of it". */
export const MAX_DIFF_CHARS = 120_000;

export const ATTENTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "snippet", "severity", "why"],
        properties: {
          file: { type: "string", description: "the path exactly as it appears in the diff header" },
          snippet: {
            type: "string",
            description: "an exact fragment copied from the changed line this is about, long enough to be unique",
          },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          why: { type: "string", description: "what could go wrong, concretely" },
        },
      },
    },
    nothingStandsOut: {
      type: "string",
      description: "if no part of this diff needs a second opinion, say so in one sentence",
    },
  },
};

export const ATTENTION_SYSTEM =
  "You read a diff and point at the parts a careful reviewer should look at first. You are " +
  "not reviewing the change and not approving it - you are deciding where a person's " +
  "attention is worth spending.\n\n" +
  "Point at a part only when you can say what could go wrong with it, concretely: a case the " +
  "code does not handle, a value that can be absent, an order that matters, a guard that " +
  "moved, a claim in a comment the code does not keep. \"Consider adding a test\", \"this is " +
  "complex\" and \"looks fine\" are not findings and must not be returned.\n\n" +
  "Anchor each finding with an exact fragment copied from the changed line it is about, long " +
  "enough to be unique in that file. Do not paraphrase it and do not give a line number.\n\n" +
  "Returning nothing is a real answer and often the right one. A diff full of warnings gets " +
  "skimmed, and then the one that mattered is skimmed too.";

/**
 * @param {string} diffText a unified diff
 * @param {{ title?: string, description?: string | null }} [card] what the change was FOR,
 *   when it is known - a diff read without its intent produces findings about style.
 * @returns {{ prompt: string, truncated: boolean, sentChars: number }}
 */
export function buildAttentionPrompt(diffText, card = {}) {
  const full = String(diffText || "");
  const truncated = full.length > MAX_DIFF_CHARS;
  const sent = truncated ? full.slice(0, MAX_DIFF_CHARS) : full;
  const lines = [];
  if (card?.title) {
    lines.push("## What this change was for");
    lines.push("");
    lines.push(String(card.title).trim());
    const description = String(card.description || "").trim();
    if (description) {
      lines.push("");
      lines.push(description.slice(0, 1500));
    }
    lines.push("");
  }
  lines.push("## The diff");
  lines.push("");
  lines.push(sent);
  if (truncated) {
    lines.push("");
    lines.push("[the diff was cut here for length - say nothing about the part you cannot see]");
  }
  lines.push("");
  lines.push("Which parts of this should a reviewer look at first, and what could go wrong with each?");
  return { prompt: lines.join("\n"), truncated, sentChars: sent.length };
}

/**
 * Every changed line in the diff, per file, so a snippet can be checked against reality.
 *
 * Only added and removed lines: a finding anchored to an untouched context line is about
 * code this change did not make, which is a different conversation and not what the view is
 * for.
 *
 * @param {string} diffText
 * @returns {Map<string, string[]>} file path -> the text of its changed lines
 */
export function changedLinesByFile(diffText) {
  const byFile = new Map();
  let current = null;
  for (const raw of String(diffText || "").split("\n")) {
    const header = raw.match(/^\+\+\+ b\/(.+)$/);
    if (header) {
      current = header[1].trim();
      if (!byFile.has(current)) {
        byFile.set(current, []);
      }
      continue;
    }
    if (/^diff --git /.test(raw)) {
      current = null;
      continue;
    }
    if (!current) {
      continue;
    }
    if ((raw.startsWith("+") || raw.startsWith("-")) && !raw.startsWith("+++") && !raw.startsWith("---")) {
      byFile.get(current).push(raw.slice(1));
    }
  }
  return byFile;
}

/** Loose comparison, so trailing whitespace or an indent difference does not lose an anchor. */
function normalise(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Keep the findings that land on a line this diff actually changed.
 *
 * @param {any} answer the validated object from the model
 * @param {string} diffText
 * @returns {{ findings: Array<{file: string, snippet: string, severity: string, why: string, line: string}>, unanchored: number, nothingStandsOut: string | null }}
 */
export function shapeAttentionAnswer(answer, diffText) {
  const byFile = changedLinesByFile(diffText);
  // Path spellings drift: a model may answer "src/lib/x.js" for a header that read
  // "b/src/lib/x.js", or use backslashes. Matched on the tail rather than exactly, since the
  // alternative is dropping a real finding over a slash.
  const fileKeys = [...byFile.keys()];
  const resolveFile = (name) => {
    const wanted = String(name || "").replace(/\\/g, "/").replace(/^b\//, "").trim().toLowerCase();
    if (!wanted) {
      return null;
    }
    return (
      fileKeys.find((k) => k.toLowerCase() === wanted) ||
      fileKeys.find((k) => k.toLowerCase().endsWith(`/${wanted}`) || wanted.endsWith(`/${k.toLowerCase()}`)) ||
      null
    );
  };

  const findings = [];
  let unanchored = 0;
  for (const f of Array.isArray(answer?.findings) ? answer.findings : []) {
    const file = resolveFile(f?.file);
    const snippet = String(f?.snippet || "").trim();
    if (!file || !snippet) {
      unanchored += 1;
      continue;
    }
    const needle = normalise(snippet);
    const line = (byFile.get(file) || []).find((l) => normalise(l).includes(needle));
    if (line === undefined) {
      // The dangerous case: a plausible warning about a line that is not in this change.
      unanchored += 1;
      continue;
    }
    findings.push({
      file,
      snippet,
      line,
      severity: ["high", "medium", "low"].includes(f.severity) ? f.severity : "low",
      why: String(f.why || "").trim(),
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const nothing =
    typeof answer?.nothingStandsOut === "string" && answer.nothingStandsOut.trim() ? answer.nothingStandsOut.trim() : null;
  return { findings, unanchored, nothingStandsOut: nothing };
}
