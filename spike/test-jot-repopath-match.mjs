// Verifies matchByTitle precedence after adding Category.repoPath support:
//   1. A category with repoPath matches a session by cwd path, even when the
//      session title does NOT contain the list name.
//   2. cwd inside a SUBFOLDER of repoPath still matches (prefix, on a boundary).
//   3. Path separators / case differ on Windows and still match.
//   4. Name-fuzzy-match still works as the fallback when no repoPath is set.
//   5. A repoPath match BEATS a competing name match for a different list.
//   6. When several repoPaths contain the cwd (nested), the longest wins.
//   7. A cwd that only shares a string prefix (foo vs foobar) does NOT match.
//
// Uses the REAL loadJot against a temp todos.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadJot } from "../src/lib/jot.js";

const tmp = path.join(os.tmpdir(), `maestro-jot-${randomUUID()}.json`);

const cats = {
  maestro: { id: "c-maestro", name: "Maestro", color: "#111", createdAt: 1, repoPath: "D:\\Repo\\Tools\\maestro" },
  skiff: { id: "c-skiff", name: "Skiff", color: "#222", createdAt: 2, repoPath: "D:/Repo/Northwind/Internal/nw-skiff" },
  // Nested INSIDE maestro's repo, longer path -> should win for cwds under it.
  worker: { id: "c-worker", name: "Analytics Worker", color: "#333", createdAt: 3, repoPath: "D:\\Repo\\Tools\\maestro\\infra\\worker" },
  // No repoPath: name-fuzzy-match only.
  jot: { id: "c-jot", name: "Jot", color: "#444", createdAt: 4 },
};

fs.writeFileSync(tmp, JSON.stringify({ todos: [], categories: Object.values(cats), tags: [] }, null, 2), "utf8");

const { ok, matchByTitle } = loadJot({ path: tmp });

let pass = true;
function check(label, got, wantId) {
  const ok = (got ? got.id : null) === wantId;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (got ${got ? got.id : "null"}, want ${wantId})`);
  if (!ok) pass = false;
}

check("loadJot ok", { id: ok ? "ok" : "no" }, "ok");

// 1. Path match wins even though the title has nothing to do with "Maestro".
check("exact cwd -> repoPath, title unrelated", matchByTitle("some random session name", "s1", "D:\\Repo\\Tools\\maestro"), "c-maestro");

// 2. cwd in a subfolder of repoPath still matches its list.
check("subfolder cwd -> repoPath", matchByTitle("whatever", "s2", "D:\\Repo\\Tools\\maestro\\src\\lib"), "c-maestro");

// 3. Different separators + case still match (forward slashes, lowercase).
check("mixed separators + case -> repoPath", matchByTitle("x", "s3", "d:/repo/tools/maestro/src"), "c-maestro");
check("skiff forward-slash repoPath matches backslash cwd", matchByTitle("x", "s3b", "D:\\Repo\\Northwind\\Internal\\nw-skiff"), "c-skiff");

// 4. Name fallback still works when NO repoPath applies (cwd unknown).
check("name fallback (no cwd)", matchByTitle("Working on Jot capture", "s4"), "c-jot");
check("name fallback (cwd matches no repoPath)", matchByTitle("Jot task board", "s5", "C:\\somewhere\\else"), "c-jot");

// 5. Path match beats a competing NAME match for a different list.
//    Title says "Jot" (would fuzzy-match c-jot) but cwd is the Maestro repo.
check("repoPath beats name match", matchByTitle("Fixing the Jot integration", "s6", "D:\\Repo\\Tools\\maestro"), "c-maestro");

// 6. Nested repos: cwd under the worker subfolder -> longest repoPath wins.
check("nested repoPaths -> longest wins", matchByTitle("x", "s7", "D:\\Repo\\Tools\\maestro\\infra\\worker\\src"), "c-worker");

// 7. Sibling with shared string prefix must NOT match (boundary guard).
//    "maestro-notes" starts with "maestro" as a string but is not inside it.
check("string-prefix sibling does NOT path-match (falls back to name=null)", matchByTitle("unrelated title", "s8", "D:\\Repo\\Tools\\maestro-notes"), null);

fs.unlinkSync(tmp);
console.log(pass ? "\nALL PASS" : "\nFAILURES");
process.exit(pass ? 0 : 1);
