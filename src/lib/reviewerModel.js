/**
 * Which model to send an independent reviewer in on, RECOMMENDED from what is
 * measurable about the change - and overridable, because a recommendation you cannot
 * refuse is just a decision someone else made (Aidin, 2026-08-05: "en bra lösning på
 * modell vore att man får en rekommendation baserat på dess komplexitet men att man
 * själv kan välja om man inte vill följa rekommendationen").
 *
 * Every input is something the app already knows: the criticality the record declares,
 * the size of the diff, and which files it touches. No guessing at "how hard does this
 * feel" - the reason string names the signal that decided it, so a recommendation can be
 * argued with.
 *
 * The tiers deliberately mirror the review record's own criticality gradient: the point
 * of declaring that being wrong here is expensive is that more is then spent on checking.
 */

export const REVIEWER_MODELS = [
  { value: "claude-opus-5", label: "Opus 5", tier: 3 },
  { value: "claude-opus-4-8", label: "Opus 4.8", tier: 2 },
  { value: "claude-sonnet-5", label: "Sonnet 5", tier: 1 },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", tier: 0 },
];

/**
 * Paths where being wrong is expensive whatever the diff size says.
 *
 * Matched on the path, not on the content: a small change to a permission gate deserves
 * the expensive reviewer, and "small" is exactly the argument that would talk you out of
 * it. Kept short and specific rather than a general "security" guess.
 */
const SENSITIVE = [
  /(^|[\\/])(preload|main)\.(c?js)$/i,
  /permission|allowedtools|bypass/i,
  /token|secret|credential|\bkey\b|hmac|sign/i,
  /spawn|execfile|child_process|shell/i,
  /reviewrecords|atomicwrite|config\.js/i,
];

/**
 * @param {object} change
 * @param {string} [change.criticality] "critical" | "core" | "cosmetic", as declared.
 * @param {number} [change.files] files touched.
 * @param {number} [change.changedLines] added + removed.
 * @param {number} [change.commits]
 * @param {string[]} [change.paths] file paths in the diff.
 * @returns {{ model: string, effort: string, why: string, sensitive: boolean }}
 */
export function recommendReviewer(change = {}) {
  const criticality = String(change.criticality || "").toLowerCase();
  const files = Number(change.files) || 0;
  const lines = Number(change.changedLines) || 0;
  const commits = Number(change.commits) || 0;
  const paths = Array.isArray(change.paths) ? change.paths : [];
  const hit = paths.find((p) => SENSITIVE.some((re) => re.test(String(p))));

  if (criticality === "critical") {
    return {
      model: "claude-opus-5",
      effort: "high",
      sensitive: !!hit,
      why: `The record declares this CRITICAL, which is the tier where my own passing tests do not count as evidence.${hit ? ` It also touches ${hit}.` : ""}`,
    };
  }
  if (hit) {
    return {
      model: "claude-opus-5",
      effort: "high",
      sensitive: true,
      why: `It touches ${hit} - a small change there is exactly the case where "it is only small" is the wrong argument.`,
    };
  }
  const big = lines >= 400 || files >= 8 || commits >= 4;
  if (criticality === "core") {
    return big
      ? {
          model: "claude-opus-5",
          effort: "high",
          sensitive: false,
          why: `Core behaviour and a large change (${lines} changed lines across ${files} file${files === 1 ? "" : "s"}) - too much surface for a cheap pass to hold at once.`,
        }
      : {
          model: "claude-sonnet-5",
          effort: "medium",
          sensitive: false,
          why: `Core behaviour but a contained change (${lines} changed lines across ${files} file${files === 1 ? "" : "s"}).`,
        };
  }
  if (criticality === "cosmetic") {
    return big
      ? {
          model: "claude-sonnet-5",
          effort: "medium",
          sensitive: false,
          why: `Cosmetic, but ${lines} changed lines across ${files} file${files === 1 ? "" : "s"} is more than a glance.`,
        }
      : {
          model: "claude-haiku-4-5-20251001",
          effort: "low",
          sensitive: false,
          why: `Cosmetic and small (${lines} changed lines) - a bug here is recoverable, so this is not worth an expensive pass.`,
        };
  }
  // No declared criticality is itself a signal: nobody said how much it costs to be
  // wrong, so the recommendation does not assume it is cheap.
  return {
    model: big ? "claude-opus-5" : "claude-sonnet-5",
    effort: big ? "high" : "medium",
    sensitive: false,
    why: `The record declares no criticality, so this does not assume the change is cheap - ${lines} changed lines across ${files} file${files === 1 ? "" : "s"}.`,
  };
}

/**
 * Diff statistics from a unified patch, for the recommendation.
 *
 * Counts the patch's own markers rather than trusting git's --stat summary line: the
 * summary is absent when a commit only renames, and a wrong count here would quietly
 * change the recommendation.
 */
export function diffStats(text) {
  const paths = new Set();
  let added = 0;
  let removed = 0;
  let commits = 0;
  for (const line of String(text || "").split("\n")) {
    if (/^diff --git /.test(line)) {
      const m = line.match(/ b\/(.+)$/);
      if (m) {
        paths.add(m[1].trim());
      }
      continue;
    }
    if (/^commit [0-9a-f]{7,40}/.test(line)) {
      commits += 1;
      continue;
    }
    // +++ / --- are file headers, not content.
    if (/^\+\+\+|^---/.test(line)) {
      continue;
    }
    if (/^\+/.test(line)) {
      added += 1;
    } else if (/^-/.test(line)) {
      removed += 1;
    }
  }
  return { files: paths.size, added, removed, changedLines: added + removed, commits, paths: [...paths] };
}

/** The label for a model id, or the id itself if it is not one we list. */
export function reviewerModelLabel(value) {
  return REVIEWER_MODELS.find((m) => m.value === value)?.label || String(value || "default");
}
