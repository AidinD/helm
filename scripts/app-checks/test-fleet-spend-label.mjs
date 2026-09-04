// E2E (deterministic, no API turns): the Fleet-spend chip's display model
// (task 18d4c9f4 - "what is fleet spend? where does the $25 come from, I'm on a
// subscription not pay-by-usage?"). The dollar figure is Helm's OWN estimate of
// what the fleet's model usage WOULD cost at API rates, used only as the guardrail
// behind the Stop button + the $ ceiling - NOT a subscription charge. The fix
// makes that legible: an "(est.)" qualifier on the label + an explaining tooltip.
// orchestrationChipContent(budget) is the pure display model; we exercise it in
// the real loaded renderer via CDP eval (no live budget/spend needed).
//
// Run:  node scripts/e2e/test-fleet-spend-label.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[fleet-spend-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-fspend-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const r = await app.eval(`(() => ({
    spend: orchestrationChipContent({ spentUsd: 25.4, ceilingUsd: 100, killed: false }),
    noCeiling: orchestrationChipContent({ spentUsd: 25.4, killed: false }),
    stopped: orchestrationChipContent({ spentUsd: 25.4, ceilingUsd: 100, killed: true }),
    over: orchestrationChipContent({ spentUsd: 120, ceilingUsd: 100, killed: false }),
    idle: orchestrationChipContent({ spentUsd: 0, ceilingUsd: 100, killed: false }),
    none: orchestrationChipContent(null),
  }))()`);

  assert(r.spend.labelText === "Fleet spend (est.) ~$25.40 / $100", `spend label carries (est.) + ~ + amount/ceiling (got ${JSON.stringify(r.spend.labelText)})`);
  assert(/not a bill/i.test(r.spend.title) && /subscription/i.test(r.spend.title), "the tooltip explains it's an estimate, not a subscription charge");
  assert(r.noCeiling.labelText === "Fleet spend (est.) ~$25.40", "a no-ceiling budget still labels the figure as an estimate");
  assert(r.stopped.labelText === "⏸ Fleet stopped" && r.stopped.stopped === true, "a killed fleet shows the stopped state");
  assert(/Budget reached/.test(r.over.labelText) && /est\./.test(r.over.labelText) && r.over.over === true, "an over-ceiling fleet reads as an estimate too");
  assert(r.idle.hidden === true, "idle + $0 spent -> chip hidden (stays out of the way)");
  assert(r.none.hidden === true, "no budget data -> chip hidden");

  log(exitCode === 0 ? "VERIFY OK: the Fleet-spend chip labels its figure as an estimate and explains it (not a subscription charge)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_MATES_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
