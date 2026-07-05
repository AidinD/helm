import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Repo-map context priming (praktiker mechanism #5 — see PLAN.md's "Target UI
 * + practitioner research" section and DECISIONS.md's 2026-07-04 practitioner
 * entry, crediting Paul Gauthier/aider's repo-map idea: prime a fresh worker
 * with compact SIGNATURES, not raw file dumps, for token-efficient whole-repo
 * awareness). Each `goalOrchestrator.js` iteration starts a brand-new
 * subprocess with no memory beyond notes.md/plan.md — this module gives that
 * fresh worker a cheap map of the repo's shape so it doesn't have to
 * re-discover it via blind Read/Grep before it can even start reasoning about
 * the goal.
 *
 * IMPLEMENTATION NOTE — regex, not tree-sitter: aider's actual repo-map uses
 * tree-sitter for real per-language parsing. This first cut deliberately uses
 * plain regexes per file extension instead, to avoid a native tree-sitter
 * dependency (prebuilt binaries per Node/Electron ABI, and historically flaky
 * on Windows). The tradeoff: regex signature extraction is a heuristic — it
 * will miss some declaration styles and can false-positive on lines that
 * merely look like a declaration (e.g. inside a string or comment). That is
 * an acceptable approximation for "orient a fresh worker cheaply", not a
 * substitute for actually reading the file when precision matters. If this
 * ever needs to get more accurate, swapping in tree-sitter later is a
 * contained change — callers only see the text map this module returns.
 */

// Files/directories never worth putting in the map: build output, deps,
// version control internals, and binary/lockfile noise that has no
// meaningful "signature" anyway. Mirrors the kind of thing a .gitignore
// already excludes from `git ls-files`, but a few of these (e.g. package-lock
// style files) ARE tracked in some repos and would otherwise dominate the map
// with junk.
const SKIP_DIR_SEGMENTS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage"]);

const SKIP_FILENAME_PATTERN = /\.(lock|min\.js|map)$/i;

/**
 * Regex signature extractors, keyed by file extension. Each extractor takes
 * the file's full text and returns an array of short human-readable
 * signature strings (e.g. "function foo(a, b)", "class Bar"). Deliberately
 * simple, line-oriented patterns — language-aware enough to be useful for the
 * languages this ecosystem actually uses (JS/TS for Maestro and the web
 * tooling, Lua for Roblox work, Python for scripting), not a full grammar.
 */
const SIG_EXTRACTORS = {
  ".js": extractJsLikeSignatures,
  ".mjs": extractJsLikeSignatures,
  ".cjs": extractJsLikeSignatures,
  ".jsx": extractJsLikeSignatures,
  ".ts": extractJsLikeSignatures,
  ".tsx": extractJsLikeSignatures,
  ".lua": extractLuaSignatures,
  ".luau": extractLuaSignatures,
  ".py": extractPythonSignatures,
};

/**
 * One signature capture per JS/TS declaration shape, applied line-by-line so
 * the reported signature is just "the interesting prefix of the line",
 * cheaply truncated rather than trying to balance parens across lines.
 */
const JS_PATTERNS = [
  // export (default)? (async)? function name(...)
  /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  // (async)? function name(...)   [non-exported, still useful context]
  /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  // export (default)? class Name
  /^\s*export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*class\s+([A-Za-z_$][\w$]*)/,
  // export const/let/var name = ... (arrow fn or plain value)
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  // top-level const/let/var name = (...) => ...  (only arrow functions, to
  // avoid flooding the map with every plain constant assignment)
  /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*\)?\s*=>/,
];

function extractJsLikeSignatures(text) {
  const sigs = [];
  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) {
      continue;
    }
    for (const pattern of JS_PATTERNS) {
      const match = pattern.exec(rawLine);
      if (match) {
        sigs.push(truncateSignature(line));
        break;
      }
    }
  }
  return sigs;
}

const LUA_PATTERNS = [
  // function Name.Method(...) / function Name:Method(...) / function Name(...)
  /^\s*(?:local\s+)?function\s+[\w.:]+\s*\(/,
  // local Name = function(...)
  /^\s*local\s+function\s+[\w.:]+\s*\(/,
  // Roblox module boundary conventions used across this ecosystem's Lua code.
  /^\s*local\s+[A-Za-z_]\w*\s*=\s*\{\}/,
  /^\s*return\s+[A-Za-z_]\w*\s*$/,
];

function extractLuaSignatures(text) {
  const sigs = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("--")) {
      continue;
    }
    for (const pattern of LUA_PATTERNS) {
      if (pattern.test(rawLine)) {
        sigs.push(truncateSignature(line));
        break;
      }
    }
  }
  return sigs;
}

const PY_PATTERNS = [
  /^\s*(?:async\s+)?def\s+\w+\s*\(/,
  /^\s*class\s+\w+/,
];

function extractPythonSignatures(text) {
  const sigs = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    for (const pattern of PY_PATTERNS) {
      if (pattern.test(rawLine)) {
        sigs.push(truncateSignature(line));
        break;
      }
    }
  }
  return sigs;
}

// Keeps each signature to one short line — a declaration's own opening line
// is what matters for orientation; multi-line parameter lists or trailing
// implementation detail would just bloat the map for no orientation value.
const MAX_SIGNATURE_CHARS = 100;

function truncateSignature(line) {
  return line.length > MAX_SIGNATURE_CHARS ? line.slice(0, MAX_SIGNATURE_CHARS) + "…" : line;
}

function runGit(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

/**
 * Lists tracked files in a project/worktree via `git ls-files`, same
 * shell-out pattern `worktree.js`/`version.js` already use (`execFileSync`
 * with `-C <cwd>`, never relying on this process's own working directory).
 * Returns paths relative to `projectPath`, forward-slash separated (git's own
 * native format, which also keeps the generated map's paths OS-independent).
 */
function listTrackedFiles(projectPath) {
  let output;
  try {
    output = runGit(projectPath, ["ls-files"]);
  } catch (err) {
    throw new Error(`Failed to list tracked files for ${projectPath}: ${err.message}`);
  }
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function shouldSkip(relPath) {
  const segments = relPath.split("/");
  if (segments.some((seg) => SKIP_DIR_SEGMENTS.has(seg))) {
    return true;
  }
  if (SKIP_FILENAME_PATTERN.test(path.basename(relPath))) {
    return true;
  }
  return false;
}

/**
 * Orders files so the most orientation-useful ones are emitted first — this
 * matters because `formatRepoMap` truncates once the character budget is hit,
 * so whatever sorts last is what gets silently dropped on a large repo.
 * Priority, highest first:
 *   1. Top-level `src/` files over deeply nested ones (shallower path depth).
 *   2. `src/` paths over everything else (application code over config/docs).
 *   3. Alphabetical, as a stable tiebreaker.
 */
function compareForPriority(a, b) {
  const aInSrc = a.startsWith("src/") ? 0 : 1;
  const bInSrc = b.startsWith("src/") ? 0 : 1;
  if (aInSrc !== bInSrc) {
    return aInSrc - bInSrc;
  }
  const aDepth = a.split("/").length;
  const bDepth = b.split("/").length;
  if (aDepth !== bDepth) {
    return aDepth - bDepth;
  }
  return a.localeCompare(b);
}

/**
 * Character budget for the generated map, mirroring the truncate-to-budget
 * pattern `goalOrchestrator.js` already uses for verify-command output
 * (`VERIFY_OUTPUT_TAIL_CHARS`) — a hard cap so a huge repo can never blow up
 * an iteration's prompt size. ~12,000 chars is on the order of a few thousand
 * tokens, small next to a modern context window but enough to list signatures
 * for a few hundred files, which comfortably covers a project this size.
 */
export const REPO_MAP_CHAR_BUDGET = 12_000;

const TRUNCATION_NOTE = "\n(map truncated — repo is larger than the context budget)\n";

/**
 * Builds the compact repo map for `projectPath` (or a worktree of it — this
 * only ever shells out with `-C projectPath`, so it works identically for
 * either): one line per code file, `relative/path: sig1, sig2, sig3`, ordered
 * by `compareForPriority` and cut off at `charBudget` total characters.
 *
 * Synchronous by design at the per-file level (`fs.readFileSync`) because
 * signature extraction itself is pure CPU-bound regex work with no I/O wait
 * worth yielding on, matching `worktree.js`'s own `execFileSync`-based
 * git helpers — but the exported entry point (`buildRepoMap`) is still async,
 * so it never blocks the Electron main process's event loop on the
 * `git ls-files` shell-out or the file-read loop for a large repo; both run
 * off the main thread's synchronous call stack inside a microtask-yielding
 * wrapper (see below).
 *
 * @param {string} projectPath - absolute path to the repo or worktree.
 * @param {object} [options]
 * @param {number} [options.charBudget] - max output length; defaults to
 *   REPO_MAP_CHAR_BUDGET.
 * @returns {Promise<{ map: string, fileCount: number, truncated: boolean }>}
 */
export async function buildRepoMap(projectPath, options = {}) {
  const charBudget = options.charBudget ?? REPO_MAP_CHAR_BUDGET;
  const resolvedProject = path.resolve(projectPath);

  const tracked = listTrackedFiles(resolvedProject)
    .filter((relPath) => !shouldSkip(relPath))
    .filter((relPath) => SIG_EXTRACTORS[path.extname(relPath).toLowerCase()])
    .sort(compareForPriority);

  const lines = [];
  let usedChars = 0;
  let truncated = false;
  let filesIncluded = 0;

  for (const relPath of tracked) {
    // Yield to the event loop between files rather than running the whole
    // (potentially few-hundred-file) loop in one synchronous stretch — cheap
    // insurance so this never becomes a visible stall in the Electron main
    // process on a large repo, without needing a worker thread for what is
    // still fundamentally fast regex work.
    await Promise.resolve();

    const absPath = path.join(resolvedProject, relPath);
    let text;
    try {
      text = fs.readFileSync(absPath, "utf8");
    } catch {
      // Deleted/renamed between `git ls-files` and the read, or a binary file
      // git happens to track — skip rather than fail the whole map.
      continue;
    }

    const extractor = SIG_EXTRACTORS[path.extname(relPath).toLowerCase()];
    const sigs = extractor(text);
    if (sigs.length === 0) {
      continue;
    }

    const line = `${relPath}: ${sigs.join(", ")}`;
    // +1 for the newline that will join this line to the map.
    if (usedChars + line.length + 1 > charBudget - TRUNCATION_NOTE.length) {
      truncated = true;
      break;
    }
    lines.push(line);
    usedChars += line.length + 1;
    filesIncluded += 1;
  }

  let map = lines.join("\n");
  if (truncated) {
    map += TRUNCATION_NOTE;
  }

  return { map, fileCount: filesIncluded, truncated };
}
