/**
 * A stand-in for the claude CLI that spends nothing.
 *
 * The three transitions in Helm's daily loop that have never had a test - a relay and a
 * jump-in resolving to ONE session, a relay reaching its second mate, a retiring mate really
 * running its carry-over turn - all need a TURN to happen before anything can be observed.
 * Two of them lose data silently when they break, so they are worth a test; running them
 * against the real CLI would spend tokens on every suite run, which is why they never got one.
 *
 * So this emits the stream-json shape launcher.js parses, and nothing else:
 *   {type:"system",subtype:"init",session_id}   - mints or echoes the session id
 *   {type:"assistant",message:{content:[text]}} - one reply
 *   {type:"result",subtype:"success"}           - the turn ended, successfully
 *
 * It honours --resume <id> by keeping that session id, which is the whole point for the
 * dual-mode check: a relay and a jump-in must end up on the SAME id.
 *
 * FAKE_CLAUDE_HOLD_MS makes the turn last long enough to observe the lock it holds while it
 * runs. Reached only via HELM_CLAUDE_BIN, which nothing but a test sets.
 */
const args = process.argv.slice(2);
const resumeAt = args.indexOf("--resume");
const sessionId = resumeAt >= 0 && args[resumeAt + 1] ? args[resumeAt + 1] : `fake-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

say({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd() });

const hold = Number(process.env.FAKE_CLAUDE_HOLD_MS || 0);
setTimeout(() => {
  say({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: "fake-claude reply" }] } });
  say({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    total_cost_usd: 0,
    modelUsage: { "claude-opus-4-8": { contextWindow: 200000, inputTokens: 1, outputTokens: 1 } },
  });
  process.exit(0);
}, hold);
