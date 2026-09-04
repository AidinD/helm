// The two things an independent review found were not tested at all (2026-08-16).
//
// 1. NOTHING CHECKED THAT THE GUARD IS ATTACHED. Both tier suites exercised the hook
//    standalone. If the wiring that puts it on a launch were dropped, every test stayed
//    green and the guard was simply absent in production - the same shape as the year-long
//    false pass that produced this guard in the first place.
//
// 2. THE BINDINGS MIGRATION HAD NO TEST. Three mutations survived the suite: making it
//    delete instead of merge, making it drop the session id, and making it do nothing at
//    all. Every data-loss finding in that review was in the untested half, and the function
//    rewrites the captain's only durable second-mate store at every app launch.
//
// Pure - no app, no model. The migration half runs against a temp store; the wiring half
// reads source, and says so.
// Run:  node scripts/e2e/test-tier-guard-wiring-and-migration.mjs
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

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const mainSrc = strip(fs.readFileSync(path.join(repo, "src", "main.js"), "utf8"));
const launcherSrc = strip(fs.readFileSync(path.join(repo, "src", "lib", "launcher.js"), "utf8"));

// --- 1. the guard is actually attached to a launch ---------------------------
ok(/function tierGuardLaunchConfig\(/.test(mainSrc), "main.js builds a tier-guard launch config");
ok(/matcher: "\.\*"/.test(mainSrc), 'the PreToolUse matcher is ".*" - an enumerated matcher would miss every tool nobody listed, which is the failure this whole guard exists to close');
ok(/hookEventName: "PreToolUse"/.test(strip(fs.readFileSync(path.join(repo, "src", "hooks", "tierGuardHook.mjs"), "utf8"))), "and the hook answers with the event name the CLI reads");

const fmBranch = mainSrc.slice(mainSrc.indexOf("allowedTools = FIRST_MATE_ALLOWED_TOOLS"), mainSrc.indexOf("} else if (secondMateId ||"));
ok(fmBranch.length > 200 && /launchTier = TIER_FIRST_MATE/.test(fmBranch), `the first-mate branch sets its tier (${fmBranch.length} chars of branch)`);
const smBranch = mainSrc.slice(mainSrc.indexOf("} else if (secondMateId ||"), mainSrc.indexOf("} catch (err) {", mainSrc.indexOf("} else if (secondMateId ||")));
ok(/launchTier = TIER_SECOND_MATE/.test(smBranch), "and the second-mate branch sets its own");
ok(
  (mainSrc.match(/\.\.\.tierGuardLaunchConfig\(/g) || []).length >= 2,
  `the config is spread into more than one launch path (${(mainSrc.match(/\.\.\.tierGuardLaunchConfig\(/g) || []).length}) - the jump-in path and the relay path are both second-mate turns, and guarding only one would leave the unattended one open`
);
ok(/if \(settings\) \{[\s\S]{0,120}--settings/.test(launcherSrc), "and the launcher passes --settings to the CLI, which is what makes the guard per-TURN rather than per-session");
ok(/env: extraEnv \?/.test(launcherSrc), "the hook's context travels in the environment, not in the command string where a path with a quote could reshape it");

// --- 2. the migration must never lose anything -------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-mig-"));
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
const { migrateDisplayKeyBindings, secondMateId, DIRECT_FIRST_MATE, releaseDisplayKeyedSession } = await import("../../src/lib/secondMates.js");

const PROJECT = process.platform === "win32" ? "D:\\Repo\\Work\\proj" : "/repo/proj";
const REAL = secondMateId(DIRECT_FIRST_MATE, PROJECT);
const seed = (obj) => fs.writeFileSync(process.env.HELM_SECOND_MATES_PATH, JSON.stringify(obj), "utf8");
const read = () => JSON.parse(fs.readFileSync(process.env.HELM_SECOND_MATES_PATH, "utf8"));
const lookup = () => PROJECT;

// The plain case it exists for.
seed({ "sess_S1": { sessionId: "S1", status: "created", name: "Skiff planning" } });
let res = migrateDisplayKeyBindings(lookup);
let after = read();
ok(res.migrated === 1 && !after["sess_S1"], `a lone legacy record folds onto the real id (${JSON.stringify(res)})`);
ok(after[REAL]?.sessionId === "S1" && after[REAL]?.name === "Skiff planning", `and carries its session AND the name the captain typed (${JSON.stringify(after[REAL])})`);
ok(after[REAL]?.projectPath === PROJECT, "and the project, without which the node cannot be rendered");

// THE DATA-LOSS CASE. Two records both holding a session: the earlier version kept the
// target's and deleted the legacy one, so the session the captain had actually been working
// in stopped being bound to anything, and it was reported as a success.
seed({ "sess_S2": { sessionId: "S2", status: "created", name: "legacy name" }, [REAL]: { sessionId: "S3", status: "created", name: "target name", projectPath: PROJECT } });
res = migrateDisplayKeyBindings(lookup);
after = read();
ok(res.migrated === 0 && res.skipped === 1, `a merge that would lose state is REFUSED, not performed (${JSON.stringify(res)})`);
ok(!!after["sess_S2"] && after["sess_S2"].sessionId === "S2", "the legacy record is still there, with its session intact - visible and fixable beats merged away and gone");
ok(after[REAL]?.sessionId === "S3", "and the target is untouched");

// TWO legacy records resolving to one target: the second used to be absorbed into the first
// and deleted, counted as migrated. Three of five records on the real store collide this way.
seed({ "sess_A": { sessionId: "A", name: "first", brief: "brief A" }, "sess_B": { sessionId: "B", name: "second", brief: "brief B" } });
res = migrateDisplayKeyBindings(lookup);
after = read();
const survivors = Object.keys(after).length;
ok(survivors === 2, `two colliding legacy records leave two records, not one (${survivors}: ${Object.keys(after).join(", ")}) - the second is not absorbed into the first`);
ok(JSON.stringify(after).includes("brief B"), "and nothing unique to the second is gone");

// CONSERVATION, asserted as an invariant rather than as a count. The count was true and
// misleading: "5 migrated" was printed while three records net disappeared.
seed({ "sess_C": { sessionId: "C", name: "keep me", brief: "and me", assignments: ["x"] } });
const before = read();
migrateDisplayKeyBindings(lookup);
const flat = JSON.stringify(read());
const lost = Object.values(before).flatMap((r) => Object.entries(r)).filter(([, v]) => v && typeof v !== "object").filter(([, v]) => !flat.includes(String(v)));
ok(lost.length === 0, `every value present before the migration is still present after it (${lost.map(([k, v]) => `${k}=${v}`).join(", ") || "none lost"})`);

// A record with nowhere to resolve to is left alone, not deleted.
seed({ "sess_D": { sessionId: "D", name: "orphan" } });
res = migrateDisplayKeyBindings(() => null);
ok(res.skipped === 1 && !!read()["sess_D"], `an unresolvable record is skipped and kept (${JSON.stringify(res)}) - it is a thing to look at, not evidence it is safe to discard`);

// Idempotent, and no write at all when nothing moved.
seed({ [REAL]: { sessionId: "S9", projectPath: PROJECT } });
const mtimeBefore = fs.statSync(process.env.HELM_SECOND_MATES_PATH).mtimeMs;
res = migrateDisplayKeyBindings(lookup);
ok(res.migrated === 0 && fs.statSync(process.env.HELM_SECOND_MATES_PATH).mtimeMs === mtimeBefore, "a store with nothing to migrate is not rewritten at all");

// A session belongs to ONE node. The migration used to write straight past the rule that
// bindSecondMateSession enforces, so two records could claim the same session and which one
// won depended on key order in the file.
seed({ "sess_E": { sessionId: "E" }, "sm_other000000": { sessionId: "E", projectPath: PROJECT } });
migrateDisplayKeyBindings(lookup);
after = read();
const claimants = Object.entries(after).filter(([, b]) => b?.sessionId === "E").map(([k]) => k);
ok(claimants.length <= 1, `at most one record claims a given session after migrating (${claimants.join(", ") || "none"})`);

// --- 3. archiving still releases a legacy binding ----------------------------
// secondMateIdForSession stopped reaching legacy records, so archiving silently stopped
// un-binding them - and that block exists precisely so an archived session is not
// resurrected by a later jump-in.
seed({ "sess_F": { sessionId: "F", status: "created" } });
const released = releaseDisplayKeyedSession("F");
ok(released === 1 && read()["sess_F"].sessionId === null, `archiving releases a legacy binding (${released}) - otherwise jumping in resurrects the session the captain archived`);
ok(read()["sess_F"].status === "proposed", "and the record stops claiming to be an active seat");

// --- 4. the reports must move with the binding -------------------------------
// The first pass at this migration moved the BINDING and left the inbox addressed to the
// display key, so a mate's own history became invisible to it - helm_collect_reports
// matches dispatchedBy exactly, and eleven of the skiff second mate's reports silently
// stopped being collectable the moment its binding was repaired (found live, 2026-08-17).
const repair = strip(fs.readFileSync(path.join(repo, "src", "main.js"), "utf8"));
const fn = repair.slice(repair.indexOf("function repairDisplayKeyReports("), repair.indexOf("function repairDisplayKeyReports(") + 2000);
ok(fn.length > 400, "the report repair exists in main.js");
ok(/isDisplaySecondMateId\(report\?\.dispatchedBy\)/.test(fn), "it only touches reports still addressed to a display key");
ok(/projectPathForSession\(sessionId\) \|\| fallback/.test(fn), "and resolves the project from the SESSION first, not from the report's own field");
ok(/skipped\+\+/.test(fn) && !/unlink|rmSync|delete /.test(fn), "an unresolvable report is skipped, never deleted - same conservative rule as the bindings");
ok(/repairDisplayKeyReports\(lookup\)/.test(repair), "and it is actually called by the startup repair, with the same lookup");

// THE TRAP ITSELF, as behaviour rather than a source scan. A report carries `project` as a
// NAME ("nw-skiff"), not a path. A first draft preferred that field, and it hashed to a
// valid-looking id for a node that does not exist - every report would have been
// re-addressed to nobody. Only a dry run against a copy of the real inbox caught it.
const fromName = secondMateId(DIRECT_FIRST_MATE, "nw-skiff");
const fromPath = secondMateId(DIRECT_FIRST_MATE, PROJECT);
ok(
  fromName !== fromPath,
  `hashing a project NAME and a project PATH give different ids (${fromName} vs ${fromPath}) - which is why the repair must not fall back to the report's own project field unless it is absolute`
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(
  exit === 0
    ? "VERIFY OK: the guard is wired into both launch paths, and the migration refuses every merge that would lose state."
    : "VERIFY FAILED."
);
process.exit(exit);
