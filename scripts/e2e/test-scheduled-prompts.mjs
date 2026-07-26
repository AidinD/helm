// Unit test: the scheduled-prompt queue (task 7d9d2188 - "queue 'fortsätt' and
// send it when the quota window has actually reset"). Covers add/cancel/due,
// the quota-reset fireAt resolution, and the rule that matters most: a
// wait-for-quota entry that comes due while the quota is STILL spent must NOT
// fire, it must be pushed.
// Run:  node scripts/e2e/test-scheduled-prompts.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), "sched-prompts-" + process.pid + ".json");
process.env.HELM_SCHEDULED_PROMPTS_PATH = tmp;

const s = await import("../../src/lib/scheduledPrompts.js");

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const T0 = 1_800_000_000_000; // fixed "now"
const MIN = 60_000;

try {
  ok(s.scheduledPromptsPath() === tmp, "uses the HELM_SCHEDULED_PROMPTS_PATH seam");
  ok(s.listScheduledPrompts().length === 0, "starts empty (missing file is not an error)");

  // --- quota-reset resolution ---
  const windows = [
    { info: { rateLimitType: "five_hour", resetsAt: Math.floor((T0 + 30 * MIN) / 1000) }, at: T0 },
    { info: { rateLimitType: "seven_day", resetsAt: Math.floor((T0 + 400 * MIN) / 1000) }, at: T0 },
    { info: { rateLimitType: "seven_day_opus", resetsAt: Math.floor((T0 - 90 * MIN) / 1000) }, at: T0 }, // already elapsed
  ];
  const fireAt = s.quotaResetFireAt(windows, T0);
  ok(fireAt === T0 + 30 * MIN + 60_000, `picks the SOONEST future reset + a grace minute (got ${fireAt !== null ? (fireAt - T0) / MIN + "m" : "null"})`);
  ok(s.quotaResetFireAt([{ info: { resetsAt: Math.floor((T0 - 5 * MIN) / 1000) }, at: T0 }], T0) === null, "an already-elapsed window yields null (don't guess a future from a dead reading)");
  ok(s.quotaResetFireAt([], T0) === null, "no windows -> null");
  ok(s.quotaResetFireAt(null, T0) === null, "null windows -> null, no throw");

  // --- add / validation ---
  let threw = 0;
  for (const bad of [{ cwd: "D:/x", fireAt: T0 }, { prompt: "hi", fireAt: T0 }, { prompt: "hi", cwd: "D:/x" }]) {
    try {
      s.scheduledPromptAdd({ ...bad, now: T0 });
    } catch {
      threw++;
    }
  }
  ok(threw === 3, `add rejects missing prompt / cwd / fireAt (${threw}/3)`);

  const e1 = s.scheduledPromptAdd({ prompt: "Fortsätt", cwd: "D:/Repo/Tools/helm", resumeSessionId: "sess-1", fireAt, waitForQuota: true, now: T0 });
  ok(e1.id.startsWith("sp_") && e1.status === "pending", "add returns a pending entry with an id");
  ok(e1.label.includes("quota reset"), `a quota-wait entry is labelled as such (got "${e1.label}")`);
  ok(e1.resumeSessionId === "sess-1", "it remembers the session to resume");

  const e2 = s.scheduledPromptAdd({ prompt: "later", cwd: "D:/x", fireAt: T0 + 120 * MIN, now: T0 });
  ok(e2.label === "in 2h", `a plain delay is labelled in hours (got "${e2.label}")`);

  // --- pending listing ---
  const pending = s.pendingScheduledPrompts(T0);
  ok(pending.length === 2 && pending[0].id === e1.id, "pending is sorted soonest-first");
  ok(pending.every((p) => p.overdue === false), "nothing is overdue yet");

  // --- due + the quota re-check rule ---
  ok(s.dueScheduledPrompts(T0).length === 0, "nothing is due before its fireAt");
  const atReset = fireAt + 1;
  ok(s.dueScheduledPrompts(atReset, { quotaLimited: false }).length === 1, "the quota-wait entry is due once its window has reset");
  ok(
    s.dueScheduledPrompts(atReset, { quotaLimited: true }).length === 0,
    "THE KEY RULE: a quota-wait entry does NOT fire while the quota is still spent (firing would just burn it on the same failure)"
  );
  // A plain (non-quota) entry is unaffected by quota state - the captain asked for
  // a time, not for a condition.
  ok(s.dueScheduledPrompts(T0 + 200 * MIN, { quotaLimited: true }).some((p) => p.id === e2.id), "a plain timed entry still fires even when quota is limited");

  // --- push ---
  const pushed = s.pushScheduledPrompt(e1.id, atReset + 45 * MIN, atReset);
  ok(pushed && pushed.fireAt === atReset + 45 * MIN, "push moves fireAt out");
  ok(pushed.status === "pending" && pushed.label.includes("quota reset"), "a pushed entry stays pending and keeps its quota-wait label");
  ok(s.dueScheduledPrompts(atReset, { quotaLimited: false }).length === 0, "after the push it is no longer due");

  // --- fire / fail ---
  const fired = s.markScheduledPromptFired(e1.id, { ok: true, now: atReset + 46 * MIN });
  ok(fired.status === "fired" && fired.firedAt === atReset + 46 * MIN, "markFired records the outcome");
  ok(s.pendingScheduledPrompts(atReset).length === 1, "a fired entry leaves the pending list");
  const failed = s.markScheduledPromptFired(e2.id, { ok: false, error: "launch refused", now: atReset });
  ok(failed.status === "failed" && failed.error === "launch refused", "a failed fire keeps its error");

  // --- cancel ---
  const e3 = s.scheduledPromptAdd({ prompt: "cancel me", cwd: "D:/x", fireAt: T0 + 10 * MIN, now: T0 });
  ok(s.cancelScheduledPrompt(e3.id) === true, "cancel works on a pending entry");
  ok(s.cancelScheduledPrompt(e3.id) === false, "cancelling twice is a no-op, not an error");
  ok(s.cancelScheduledPrompt("sp_nope") === false, "cancelling an unknown id is a no-op");
  ok(s.dueScheduledPrompts(T0 + 20 * MIN).length === 0, "a cancelled entry never becomes due");

  // --- prune ---
  const removed = s.pruneScheduledPrompts(atReset + 40 * 24 * 60 * MIN);
  ok(removed >= 2, `prune drops old terminal entries (removed ${removed})`);
  ok(s.listScheduledPrompts().every((p) => p.status === "pending" || p.status === "cancelled"), "prune never removes a pending entry");

  // --- durability ---
  const leftovers = fs.existsSync(path.dirname(tmp)) ? fs.readdirSync(path.dirname(tmp)).filter((f) => f.startsWith(path.basename(tmp)) && f.includes(".tmp")) : [];
  ok(leftovers.length === 0, "atomic write leaves no .tmp files");
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.stack || err.message);
} finally {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // best-effort
  }
}
console.log(exit === 0 ? "VERIFY OK: scheduled-prompt queue (quota-reset resolution, due/push/fire, cancel, prune)." : "VERIFY FAILED.");
process.exit(exit);
