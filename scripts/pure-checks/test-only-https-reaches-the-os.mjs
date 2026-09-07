// Helm hands exactly one kind of string to the operating system, and it is checked by parsing.
//
// WHY THIS IS ITS OWN CHECK. shell.openExternal asks Windows to open a string, and Windows
// picks the handler - so an arbitrary string is an arbitrary program with arguments. The first
// caller of this in Helm is the CI widget's "Open run" button, whose URL arrived over the
// network from `gh`. That string is not something Helm authored, and "it came from a source I
// trust" is the reasoning that produces injection bugs: the trust is in the SOURCE while the
// risk is in the STRING.
//
// WHAT IT DECIDES, AND WHAT IT DOES NOT. The scheme, by parsing rather than by prefix-matching
// a string. Not the destination: a URL that parses as https is allowed and goes wherever it
// says, and the block near the bottom asserts three such odd-looking forms being allowed
// on purpose, so that limit is documented rather than discovered. What the guard buys is that
// Helm never asks Windows to open something that could start a program.
//
// Run: node scripts/pure-checks/test-only-https-reaches-the-os.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { externalLinkProblem, OPENABLE_SCHEMES } from "../../src/lib/externalLink.js";

let fails = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${what}`);
  if (!cond) {
    fails += 1;
  }
};

// --- what it lets through -------------------------------------------------------------------
ok(externalLinkProblem("https://github.com/AidinD/helm/actions/runs/34096417620") === null, "a run URL opens");
ok(externalLinkProblem("  https://github.com/x  ") === null, "and surrounding whitespace is trimmed rather than refused");
ok(OPENABLE_SCHEMES.length === 1 && OPENABLE_SCHEMES[0] === "https:", `and https is the only scheme on the list (${OPENABLE_SCHEMES.join(",")})`);

// --- what it refuses, with the reason -------------------------------------------------------
const refused = [
  ["file:///C:/Windows/System32/calc.exe", "a file: URL, which opens a program"],
  ["http://example.com", "plain http, because a link Helm opens should not be downgradeable"],
  ["ms-settings:privacy", "a Windows custom protocol"],
  ["javascript:alert(1)", "a javascript: URL"],
  ["data:text/html,<script>1</script>", "a data: URL"],
  ["vscode://file/C:/x", "a registered app protocol that takes a path"],
  ["", "an empty string"],
  ["   ", "whitespace only"],
  ["not a url", "something that is not a URL at all"],
];
for (const [url, what] of refused) {
  const problem = externalLinkProblem(url);
  ok(typeof problem === "string" && problem.length > 0, `${what} is refused, with a reason (${problem || "NO REASON"})`);
}

// --- what the parse decides, including where it says YES to something odd -------------------
//
// THE LIMIT, ASSERTED SO IT CANNOT BE MISTAKEN FOR AN OVERSIGHT. Three of the four below look
// like attacks and are ALLOWED, because the WHATWG parser reads `https:/\host` and `https:host`
// as https URLs with that host - which they are. This guard decides the SCHEME, so that Helm
// never asks Windows to open something that could start a program; it does not decide the
// destination. Writing that here means the next reader learns it from the check instead of
// discovering it in the wild.
for (const url of ["https:/\\evil.example.com", "https:evil", "https:\\\\evil", " https://ok.example.com/../.."]) {
  const problem = externalLinkProblem(url);
  const parsedScheme = (() => {
    try {
      return new URL(url.trim()).protocol;
    } catch {
      return "(unparseable)";
    }
  })();
  // Some of these DO parse as https with a harmless path, and those are correctly allowed -
  // the assertion is that the answer follows the PARSE and never the prefix.
  const expected = parsedScheme === "https:" ? null : "refused";
  ok(
    expected === null ? problem === null : typeof problem === "string",
    `"${url}" follows its parsed scheme ${parsedScheme} and is ${problem === null ? "ALLOWED - the scheme is the rule, not the destination" : "refused"}`
  );
}

// --- and nothing else in the app calls openExternal directly --------------------------------
// The guard is only a guard if it is the only door. A second call site that reaches for
// shell.openExternal itself would be a hole with a test sitting next to it.
//
// COMMENTS ARE STRIPPED FIRST, so a commented-out call site cannot be counted as the one real
// door, and a comment mentioning `shell.openExternal(` cannot be mistaken for a second one. A
// plain regex over the raw source cannot tell "called here" from "mentioned in a comment here",
// which is exactly the gap a behavior-preserving edit (adding a note) could fall into.
function stripComments(src) {
  // Block comments, then line comments. Not JS-string-aware - fine for this file's purpose,
  // since the only thing this strips before counting is comment text, and the fixture below
  // proves the one case that matters: a commented-out call disappears.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

{
  // Prove the stripping actually strips, before trusting it to judge the real source.
  const fixture = [
    "function open(url) {",
    "  // shell.openExternal(url); // old, unguarded call - left as a note",
    "  return externalLinkProblem(url) || realOpen(url);",
    "}",
  ].join("\n");
  const strippedCalls = [...stripComments(fixture).matchAll(/shell\.openExternal\s*\(/g)];
  ok(strippedCalls.length === 0, "a commented-out shell.openExternal call is not counted once comments are stripped");
}

{
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const main = stripComments(fs.readFileSync(path.join(repo, "src", "main.js"), "utf8"));
  const calls = [...main.matchAll(/shell\.openExternal\s*\(/g)];
  ok(calls.length === 1, `shell.openExternal is called in exactly one place in main.js (${calls.length})`);
  const handlerBody = main.slice(main.indexOf('ipcMain.handle("link:open"'), main.indexOf('ipcMain.handle("ci:health"'));
  ok(
    /externalLinkProblem\(/.test(handlerBody),
    "and that one place asks externalLinkProblem first"
  );
  ok(
    handlerBody.indexOf("externalLinkProblem(") < handlerBody.indexOf("shell.openExternal("),
    "before it opens anything - the check has to come first to be a check"
  );
}

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: nothing that could start a program reaches the OS, refusals carry a reason, the judgement follows a parse rather than a prefix, and there is one door. Where an https link POINTS is not what this decides."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
