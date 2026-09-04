/**
 * A function reading a name that is somebody ELSE'S parameter.
 *
 * ## The bug
 *
 * The crew tier guard shipped on 2026-08-31. `runGoal` gained a `guard` parameter, and
 * `runIteration` - a separate top-level function in the same file - was taught to read
 * `guard?.settings` and `guard?.extraEnv`. It was never given one. `guard` was a free
 * variable there, so every crew iteration threw ReferenceError before it spawned anything,
 * and the whole feature was dead from the moment it landed.
 *
 * It is in the run history in Helm's own words: a goal run whose `error` field reads
 * "guard is not defined". Nothing else noticed. `--fast` was 125/125 green, and
 * test-no-undefined-calls.mjs - which exists for exactly this family - asks only about
 * CALLS, and this was a property read.
 *
 * ## Why this shape and not a linter
 *
 * A linter with `no-undef` catches this in milliseconds and would be the better answer;
 * this repo has none, and adding one is a dependency decision rather than a check
 * (flagged separately). What a linter needs and a regex cannot have is real scope
 * analysis - so instead of asking the general question badly, this asks a narrow one
 * exactly:
 *
 *   does a top-level function read a name that is a DESTRUCTURED PARAMETER of a
 *   different top-level function in the same file, and is not bound in its own?
 *
 * That is the whole shape of the bug, and it is nearly false-positive-proof: a
 * destructured parameter name is a local by construction, so a second function reading
 * one either got it as a parameter too, declared it, or is reading a variable that does
 * not exist there. Everything bound anywhere inside the reading function - its own
 * parameters, any `const`/`let`/`var`, a nested function's parameters, a catch binding,
 * a loop variable - counts as bound, which is what keeps the honest cases quiet.
 *
 * Pure and fast. Run: node scripts/e2e/test-no-borrowed-parameters.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const libDir = path.join(repo, "src", "lib");

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

/**
 * Comments, strings, template literals and regex literals out, so a name merely MENTIONED
 * in prose is never read as code. Borrowed from test-no-undefined-calls.mjs, which learned
 * the hard way that a comment explaining what a function does otherwise counts as using it.
 */
function stripNonCode(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""')
    .replace(/([=(,:[!&|?{};+\-*%^~<>]|^|return|typeof)\s*\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/g, "$1 //RE ");
}

/** The matching close for the bracket at `open`, or -1. Quotes are already gone. */
function matchBracket(text, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[text[open]];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === text[open]) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * The names an object-destructuring parameter list binds, at its top level only.
 *
 * `{ a, b: c, d = 1, ...rest }` binds a, c, d and rest. A nested pattern's inner names are
 * skipped rather than guessed at - missing a name only makes this quieter, never wronger.
 */
function destructuredNames(paramText) {
  const open = paramText.indexOf("{");
  if (open < 0) {
    return [];
  }
  const close = matchBracket(paramText, open);
  if (close < 0) {
    return [];
  }
  const inner = paramText.slice(open + 1, close);
  const names = [];
  let depth = 0;
  let piece = "";
  for (const ch of inner) {
    if ("{[(".includes(ch)) {
      depth += 1;
    }
    if ("}])".includes(ch)) {
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      names.push(piece);
      piece = "";
      continue;
    }
    piece += ch;
  }
  names.push(piece);
  return names
    .map((p) => {
      // `b: c` binds c; `d = 1` binds d; `...rest` binds rest.
      const renamed = p.includes(":") ? p.slice(p.indexOf(":") + 1) : p;
      const named = renamed.split("=")[0];
      return named.replace(/\.\.\./g, "").trim();
    })
    .filter((n) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n));
}

/** Every top-level function in a file: its name, its destructured parameter names, its body. */
function topLevelFunctions(code) {
  const out = [];
  const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  let m;
  while ((m = re.exec(code))) {
    const parenOpen = code.indexOf("(", m.index + m[0].length - 1);
    const parenClose = matchBracket(code, parenOpen);
    if (parenClose < 0) {
      continue;
    }
    const braceOpen = code.indexOf("{", parenClose);
    if (braceOpen < 0) {
      continue;
    }
    const braceClose = matchBracket(code, braceOpen);
    if (braceClose < 0) {
      continue;
    }
    const paramText = code.slice(parenOpen, parenClose + 1);
    out.push({
      name: m[1],
      // What OTHERS could borrow: only top-level destructured names, which are locals by
      // construction and therefore distinctive.
      params: destructuredNames(paramText),
      // What THIS function has bound: every identifier in its parameter list, positional
      // ones included. Without this, `function truncate(text, n)` reading `text` looks
      // like it borrowed the `text` of a destructured parameter elsewhere in the file -
      // which produced 36 false reports and no true ones on the first run.
      ownNames: (paramText.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []),
      body: code.slice(braceOpen + 1, braceClose),
    });
  }
  return out;
}

/**
 * Is `name` bound anywhere inside this body?
 *
 * Deliberately generous - a declaration, a destructuring, a nested function's parameter,
 * a catch, a loop variable, an assignment target all count. Being generous here is what
 * keeps the false-positive rate at zero; the bug this looks for is a name that appears
 * ONLY as a read.
 */
function boundInside(body, name) {
  const n = name.replace(/[$]/g, "\\$");
  const patterns = [
    // const/let/var, alone or inside a destructuring pattern on the same statement
    new RegExp(`\\b(?:const|let|var)\\s+[^;=\\n]*\\b${n}\\b`),
    // a parameter of a nested function or arrow, or a catch binding
    new RegExp(`(?:function\\s*[A-Za-z0-9_$]*\\s*\\(|catch\\s*\\()[^)]*\\b${n}\\b`),
    // an arrow's parameter list, parenthesised or bare
    new RegExp(`\\([^)(]*\\b${n}\\b[^)(]*\\)\\s*=>`),
    new RegExp(`\\b${n}\\s*=>`),
    // for (const x of ...) is covered above; a plain assignment target creates a global
    // but is still an intentional write, not the read this hunts
    new RegExp(`\\b${n}\\s*=[^=>]`),
  ];
  return patterns.some((p) => p.test(body));
}

/**
 * Does this body READ `name`?
 *
 * The lookbehind drops `.x` (a property) and the `:` lookahead drops `x:` (a key). The
 * follower class is what separates code from prose: in JavaScript an identifier is never
 * followed by another word, so "commit boundary" in an English sentence is not a read of
 * `commit`. That sentence is real - it lives in a template literal nested inside another
 * one, which the string stripper cannot see into, and it was this check's last false
 * positive.
 */
function readsIdentifier(body, name) {
  const n = name.replace(/[$]/g, "\\$");
  return new RegExp(`(?<![.\\w$])${n}(?![\\w$])(?!\\s*:)\\s*(?:[.?)\\],;}=&|+\\-*/<>!%^~]|$)`).test(body);
}

const files = fs.readdirSync(libDir).filter((f) => f.endsWith(".js"));
const findings = [];

for (const file of files) {
  const code = stripNonCode(fs.readFileSync(path.join(libDir, file), "utf8"));
  const fns = topLevelFunctions(code);
  // A name declared at module level is legitimately shared and is not a borrowed parameter.
  const moduleLevel = new Set();
  for (const m of code.matchAll(/^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm)) {
    moduleLevel.add(m[1]);
  }
  for (const m of code.matchAll(/^import\s+[\s\S]*?from\s+/gm)) {
    void m;
  }
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const nm = part.split(/\s+as\s+/).pop().trim();
      if (nm) {
        moduleLevel.add(nm);
      }
    }
  }
  for (const m of code.matchAll(/\bimport\s+([A-Za-z0-9_$]+)\s+from/g)) {
    moduleLevel.add(m[1]);
  }

  for (const fn of fns) {
    const own = new Set(fn.ownNames);
    for (const other of fns) {
      if (other.name === fn.name) {
        continue;
      }
      for (const name of other.params) {
        if (own.has(name) || moduleLevel.has(name)) {
          continue;
        }
        if (!readsIdentifier(fn.body, name)) {
          continue;
        }
        if (boundInside(fn.body, name)) {
          continue;
        }
        findings.push({ file, fn: fn.name, name, owner: other.name });
      }
    }
  }
}

// Dedup: one report per (file, function, name), whichever other function owns it.
const seen = new Set();
const unique = findings.filter((f) => {
  const key = `${f.file}:${f.fn}:${f.name}`;
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  return true;
});

for (const f of unique) {
  console.log(`     ${f.file}: ${f.fn}() reads "${f.name}", which is a parameter of ${f.owner}() and is not bound in ${f.fn}()`);
}
ok(unique.length === 0, `no function reads another function's parameter (${files.length} files in src/lib scanned)`);

// The check must be able to find something, or a green result means nothing. This plants
// the exact bug that motivated it and confirms the scan reports it.
{
  const planted = stripNonCode(
    [
      "function outer({ guard, other }) {",
      "  return inner({ other });",
      "}",
      "function inner({ other }) {",
      "  return { settings: guard?.settings, other };",
      "}",
    ].join("\n")
  );
  const fns = topLevelFunctions(planted);
  const inner = fns.find((f) => f.name === "inner");
  const outer = fns.find((f) => f.name === "outer");
  const caught =
    !!inner &&
    !!outer &&
    outer.params.includes("guard") &&
    !inner.params.includes("guard") &&
    readsIdentifier(inner.body, "guard") &&
    !boundInside(inner.body, "guard");
  ok(caught, "and the scan reports the planted case it was written for - a green result above means something");
}

console.log("");
console.log(exit === 0 ? "VERIFY OK: no borrowed parameters in src/lib." : "VERIFY FAILED.");
process.exit(exit);
