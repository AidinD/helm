// Which skills a turn actually used, as chips in the transcript (card 7cf14337: "I want to
// see in the output which memory it loads and which skills it uses - as chips maybe, like in
// the other app.").
//
// The card asks for TWO chips. Only one of them is real, and this check is where that is
// established rather than asserted in prose. Both halves were probed with a live capture on
// 2026-09-02: one `claude -p --output-format stream-json --verbose` run in a scratch folder
// carrying a root CLAUDE.md, a `sub/CLAUDE.md`, and a `.claude/skills/probe-skill`, with the
// CLI's own session .jsonl for the SAME run read alongside its stdout.
//
//   SKILLS - observable, in BOTH streams. Verbatim from the capture:
//     {"type":"tool_use","id":"toolu_01AnGj...","name":"Skill","input":{"skill":"probe-skill"}}
//   followed by
//     {"type":"tool_result","tool_use_id":"toolu_01AnGj...","content":"Launching skill: probe-skill"}
//
//   MEMORY - NOT observable. The run demonstrably loaded `sub/CLAUDE.md`: the session .jsonl
//   recorded it as
//     {"attachment":{"type":"nested_memory","path":"...\\sub\\CLAUDE.md","displayPath":"sub\\CLAUDE.md"}}
//   and the same run's stdout - all 20 lines of it - contains no such record and no mention of
//   CLAUDE.md at all. The root and user-level CLAUDE.md never appear in either: they go into
//   the system prompt. The init event carries `memory_paths` ({"auto":"<dir>"}), which is a
//   DIRECTORY that exists, not a list of files this turn read.
//
// So there is no memory chip, and the negatives below are the tripwire that keeps that
// honest: a chip reading "memory: X" with no signal behind it would be a rendering of a
// guess, and this repo has already shipped prose asserting a mechanism nobody built.
//
// Pure by design: it feeds captured payloads through the real parser and the real resolver,
// launching nothing. The DOM side (a Skill call leaving the collapsed "Used N tools" group and
// becoming a clickable chip) is proved separately in test-skill-chip-renders.mjs.
//
// Run:  node scripts/e2e/test-skill-chips.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const rSrc = fs.readFileSync(path.join(repo, "src", "renderer", "renderer.js"), "utf8");

// The REAL functions, lifted out of renderer.js rather than reimplemented, so a change there
// cannot pass here. Same technique as test-crew-row-headline.
const grab = (name) => {
  const at = rSrc.indexOf(`function ${name}(`);
  if (at < 0) {
    throw new Error(`renderer.js no longer defines ${name}`);
  }
  return rSrc.slice(at, rSrc.indexOf("\n}", at) + 2);
};
const refReMatch = rSrc.match(/^const SKILL_REF_RE = (.+);$/m);
if (!refReMatch) {
  throw new Error("renderer.js no longer defines SKILL_REF_RE");
}
const lifted = new Function(
  `const SKILL_REF_RE = ${refReMatch[1]};
${grab("skillUseFromTurn")}
${grab("isSkillLaunchResult")}
${grab("resolveSkillOrigin")}
${grab("samePath")}
return { skillUseFromTurn, isSkillLaunchResult, resolveSkillOrigin, samePath };`
)();
const { skillUseFromTurn, isSkillLaunchResult, resolveSkillOrigin } = lifted;

const { readTranscript } = await import("../../src/lib/transcript.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-skillchips-"));
const proj = path.join(tmp, "proj");
const home = path.join(tmp, "home", ".claude");
process.env.HELM_CLAUDE_HOME = home;

const writeSkill = (dir, name, body) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), body, "utf8");
};

// A project skill, a categorised project skill, a personal one, and one from an enabled
// plugin - the four shapes a real invocation resolves to on this machine.
writeSkill(path.join(proj, ".claude", "skills"), "probe-skill", "# Probe skill\n\nProject scope.\n");
writeSkill(path.join(proj, ".claude", "skills"), path.join("tools", "nested-probe"), "# Nested probe\n\nFiled under a category.\n");
writeSkill(path.join(home, "skills"), "personal-probe", "# Personal probe\n\nPersonal scope.\n");
const marketplace = path.join(home, "plugins", "marketplaces", "probe-market");
fs.mkdirSync(path.join(marketplace, ".claude-plugin"), { recursive: true });
fs.writeFileSync(
  path.join(marketplace, ".claude-plugin", "marketplace.json"),
  JSON.stringify({ name: "probe-market", plugins: [{ name: "probe-plugin", source: "./probe-plugin" }] }),
  "utf8"
);
writeSkill(path.join(marketplace, "probe-plugin", "skills"), "plugin-probe", "# Plugin probe\n\nPlugin scope.\n");
fs.writeFileSync(
  path.join(home, "settings.json"),
  JSON.stringify({ enabledPlugins: { "probe-plugin@probe-market": true } }),
  "utf8"
);

// ---------------------------------------------------------------------------------------
// 1. The captured payloads, through the real transcript parser
// ---------------------------------------------------------------------------------------
// Copied from the capture named at the top of this file. Only the absolute paths and the cwd
// are rewritten to this test's temp folder - everything that decides the parse (the record
// types, the block shapes, the field names, the tool_use id linking the call to its result)
// is exactly what the CLI wrote.
const jsonPath = (p) => JSON.stringify(p).slice(1, -1);
const CWD = jsonPath(proj);
const transcript = path.join(tmp, "session.jsonl");
fs.writeFileSync(
  transcript,
  [
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"Use the probe-skill skill, then read sub/note.txt and tell me its contents."},"uuid":"14dc0668","timestamp":"2026-09-02T17:00:44.000Z","cwd":"${CWD}","sessionId":"410d2aaf","version":"2.1.226"}`,
    // The Skill call. Verbatim, id and all.
    `{"parentUuid":"cdbda6f4","isSidechain":false,"message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CeeyGLnMkZAZsd3gH992F","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01AnGj1ga7pwBkMQwK1ZnFXx","name":"Skill","input":{"skill":"probe-skill"},"caller":{"type":"direct"}}],"stop_reason":"tool_use"},"type":"assistant","uuid":"56607bfb","timestamp":"2026-09-02T17:00:48.409Z","cwd":"${CWD}","sessionId":"410d2aaf","version":"2.1.226"}`,
    // Its result. This is the whole content the CLI sends back for a Skill call.
    `{"parentUuid":"56607bfb","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01AnGj1ga7pwBkMQwK1ZnFXx","content":"Launching skill: probe-skill"}]},"uuid":"42461cdf","timestamp":"2026-09-02T17:00:48.433Z","toolUseResult":{"success":true,"commandName":"probe-skill"},"cwd":"${CWD}","sessionId":"410d2aaf","version":"2.1.226"}`,
    // An ordinary tool call from the same capture, so the check covers what must NOT become a
    // chip as well as what must.
    `{"parentUuid":"a1","isSidechain":false,"message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CeeyRdEZij4VjgErT6pVB","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_013DwsQxu6moU3xtuafGMLe9","name":"Read","input":{"file_path":"${CWD}\\\\sub\\\\note.txt"},"caller":{"type":"direct"}}]},"type":"assistant","uuid":"b1","timestamp":"2026-09-02T17:02:56.000Z","cwd":"${CWD}","sessionId":"410d2aaf","version":"2.1.226"}`,
    `{"parentUuid":"b1","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_013DwsQxu6moU3xtuafGMLe9","type":"tool_result","content":"1\\thello from sub\\n2\\t"}]},"uuid":"c1","timestamp":"2026-09-02T17:02:56.144Z","cwd":"${CWD}","sessionId":"410d2aaf","version":"2.1.226"}`,
    // THE MEMORY EVIDENCE. This run really did load sub/CLAUDE.md, and this record is how the
    // CLI wrote it down. It is an `attachment`, which is a record type readTranscript skips -
    // and it never appeared on stdout at all, which is where Helm's live chips would come from.
    `{"parentUuid":"70f5c0cd","isSidechain":false,"attachment":{"type":"nested_memory","path":"${CWD}\\\\sub\\\\CLAUDE.md","content":{"path":"${CWD}\\\\sub\\\\CLAUDE.md","type":"Project","content":"# Probe sub\\n\\nNested memory for the sub folder.\\n"},"displayPath":"sub\\\\CLAUDE.md"},"type":"attachment","uuid":"46f123ba","timestamp":"2026-09-02T17:02:56.640Z","cwd":"${CWD}","sessionId":"410d2aaf","version":"2.1.226"}`,
    `{"parentUuid":"c1","isSidechain":false,"message":{"model":"claude-haiku-4-5-20251001","id":"msg_z","type":"message","role":"assistant","content":[{"type":"text","text":"hello from sub"}]},"type":"assistant","uuid":"d1","timestamp":"2026-09-02T17:02:58.000Z","cwd":"${CWD}","sessionId":"410d2aaf","version":"2.1.226"}`,
    "",
  ].join("\n"),
  "utf8"
);

const { turns } = readTranscript(transcript);
const skills = turns.map(skillUseFromTurn).filter(Boolean);

ok(turns.length === 6, `the captured transcript parses into the six turns it holds (${turns.length})`);
ok(skills.length === 1, `exactly one turn is a skill invocation (${skills.length})`);
ok(skills[0]?.ref === "probe-skill", `and it names the skill that ran (${JSON.stringify(skills[0]?.ref)})`);
ok(skills[0]?.plugin === null, "with no plugin, because the invocation carried no namespace");
// The Read call in the same capture must stay an ordinary tool row.
const readTurn = turns.find((t) => t.kind === "tool_use" && t.toolName === "Read");
ok(!!readTurn, "the ordinary Read call is still in the turns");
ok(skillUseFromTurn(readTurn) === null, "and it does not become a skill chip");
// The launch result belongs to the chip, not to a row of its own under it.
const launchResult = turns.find((t) => t.kind === "tool_result" && /Launching skill/.test(t.text || ""));
ok(!!launchResult && isSkillLaunchResult(launchResult), "the \"Launching skill: X\" result is recognised as the chip's own");
const readResult = turns.find((t) => t.kind === "tool_result" && /hello from sub/.test(t.text || ""));
ok(!!readResult && !isSkillLaunchResult(readResult), "and an ordinary tool result is not");

// ---------------------------------------------------------------------------------------
// 2. The invocation shapes that actually occur, including the one that must refuse
// ---------------------------------------------------------------------------------------
// Measured across the transcripts on this machine: 81 Skill invocations, 48 of them
// {"skill":"..."} and 33 {"skill":"...","args":"..."}. transcript.js hands the renderer the
// input's FIRST key, so the second shape works today - and stops working the day the key
// order flips. That is exactly when a fabricated chip would appear, so it is asserted.
const toolTurn = (toolInput) => ({ kind: "tool_use", toolName: "Skill", toolInput });
ok(skillUseFromTurn(toolTurn("ship-review"))?.ref === "ship-review", "a {skill, args} invocation still resolves to the skill name");
const argsFirst = skillUseFromTurn(
  toolTurn("Review the 8 unpushed commits before pushing and releasing. Working tree is clean and…")
);
ok(argsFirst === null, `an args sentence arriving where the ref should be produces NO chip, not a chip named after prose (${JSON.stringify(argsFirst)})`);
const namespaced = skillUseFromTurn(toolTurn("anthropic-skills:pptx"));
ok(namespaced?.plugin === "anthropic-skills" && namespaced?.name === "pptx", `a plugin-namespaced invocation splits into plugin and name (${JSON.stringify(namespaced)})`);
ok(skillUseFromTurn(toolTurn("")) === null, "an empty input produces no chip");
ok(skillUseFromTurn({ kind: "tool_use", toolName: "Bash", toolInput: "ls" }) === null, "and no other tool does");

// ---------------------------------------------------------------------------------------
// 3. The origin, resolved against the REAL listing, and a file that really opens
// ---------------------------------------------------------------------------------------
// The chip says "personal" / "project" / "<plugin>" beside the name. That label is what makes
// the card's question answerable ("was it the skill I meant, from where I meant"), and it is
// also what makes CLICKING the chip open the right SKILL.md - so it is resolved against
// skills.js's own listing and then checked by asking skillMdPath for the file.
const { listSkills, skillMdPath } = await import("../../src/lib/skills.js");
const listing = listSkills({ projectRoots: [proj] });

const resolve = (ref) => resolveSkillOrigin(listing, skillUseFromTurn(toolTurn(ref)), proj);
const opens = (r) => {
  const file = skillMdPath(r.ref, r.origin, r.cwd || proj, r.plugin);
  return !!file && fs.existsSync(file);
};

const project = resolve("probe-skill");
ok(project?.origin === "project" && project?.label === "project", `a project skill resolves to the project (${JSON.stringify(project)})`);
ok(!!project && opens(project), "and the chip's reference opens that project's SKILL.md");

const personal = resolve("personal-probe");
ok(personal?.origin === "global" && personal?.label === "personal", `a skill in ~/.claude/skills reads as personal (${JSON.stringify(personal)})`);
ok(!!personal && opens(personal), "and its chip opens that file");

const plugin = resolve("probe-plugin:plugin-probe");
ok(plugin?.origin === "plugin" && plugin?.label === "probe-plugin", `a plugin skill names its plugin (${JSON.stringify(plugin)})`);
ok(!!plugin && opens(plugin), "and its chip opens the plugin's own SKILL.md");

// The category case is the one that silently breaks: the tool invokes "nested-probe" while the
// listing files it as "tools/nested-probe", and a chip carrying the bare name would name a
// skill it cannot open - the same failure task 2ba0d477 fixed in the Analysis chips.
const nested = resolve("nested-probe");
ok(nested?.origin === "project", `a categorised skill still resolves (${JSON.stringify(nested)})`);
ok(nested?.ref === path.join("tools", "nested-probe").replace(/\\/g, "/") || nested?.ref === "tools/nested-probe", `and carries the category in its reference (${JSON.stringify(nested?.ref)})`);
ok(!!nested && opens(nested), "so its chip opens the file rather than naming one it cannot");

// A skill that ships inside the CLI is in none of these roots. It must come back unresolved,
// so the chip keeps the name and claims no origin, rather than guessing "personal".
const bundled = resolve("artifact-design");
ok(bundled === null, `a skill Helm cannot find on disk resolves to nothing, not to a guess (${JSON.stringify(bundled)})`);

// ---------------------------------------------------------------------------------------
// 4. The memory half: the negative, with the real payload behind it
// ---------------------------------------------------------------------------------------
// The nested_memory record above is in the fixture. If a future CLI version, or a future
// transcript.js, starts surfacing a loaded memory file as a TURN, these two go red - and that
// is the signal that the memory chip has become buildable. Until then it is not.
const memoryish = turns.filter((t) => /CLAUDE\.md|nested_memory|memory/i.test(JSON.stringify(t)));
ok(
  memoryish.length === 0,
  `no turn carries a loaded memory file, so there is nothing to build a memory chip from yet (${JSON.stringify(memoryish).slice(0, 200)})`
);
ok(
  !/memoryUseFromTurn|memory-chip|memoryChipEl/.test(rSrc),
  "and the renderer builds no memory chip, because no signal reaches it"
);
// What the stream DOES carry about memory, and why it is not a usage chip: a directory.
const CAPTURED_INIT_MEMORY = { auto: "<project>\\memory\\" };
ok(
  Object.keys(CAPTURED_INIT_MEMORY).length === 1 && /memory[\\/]?$/.test(CAPTURED_INIT_MEMORY.auto),
  "the init event's memory_paths is a directory that exists, not a list of files a turn read"
);

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // temp dir; a leftover is harmless
}

console.log("");
console.log(
  exit === 0
    ? "VERIFY OK: an invoked skill is parsed out of a real transcript, resolved to a SKILL.md that opens, and memory stays unclaimed because nothing in the stream claims it."
    : "VERIFY FAILED."
);
process.exit(exit);
