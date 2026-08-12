// The autopilot-model feature (task a3ff4a06, "see which model the autopilot
// used") threaded a resolvedModel through the whole run pipeline, but the branch
// stopped before wiring it into the DISPLAY - goalModelEffortLabel still showed a
// bare "Auto model" for auto-captain runs, so the actual model was captured but
// never shown. This test guards the completed display: an Auto run now surfaces the
// model the CLI actually resolved to.
//
// Drives the real renderer function in a launched app (no model tokens).
//
// Run:  node scripts/e2e/test-goal-model-label.mjs
import { launch } from "./harness.mjs";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`(() => {
    const label = (run) => goalModelEffortLabel(run);
    return {
      // Explicitly-picked model: unchanged behaviour.
      explicit: label({ model: "claude-opus-4-8", effort: "high" }),
      // Auto run, nothing resolved yet: the honest placeholder.
      autoPending: label({ model: null, effort: null, latestModel: null }),
      // Auto run, a model resolved live (mirrored onto run.latestModel).
      autoLive: label({ model: null, effort: null, latestModel: "claude-haiku-4-5" }),
      // Finished auto run: resolved model lives on run.result.
      autoDone: label({ model: null, result: { resolvedModel: "claude-haiku-4-5" } }),
    };
  })()`);

  ok(/opus/i.test(res.explicit) && /high effort/i.test(res.explicit), `an explicit pick still shows its model+effort (${JSON.stringify(res.explicit)})`);
  ok(res.autoPending === "Auto model", `an Auto run with nothing resolved yet shows the placeholder (${JSON.stringify(res.autoPending)})`);
  ok(/^Auto ->/.test(res.autoLive) && /haiku/i.test(res.autoLive), `an Auto run shows the model the CLI actually resolved to, live (${JSON.stringify(res.autoLive)})`);
  ok(/^Auto ->/.test(res.autoDone) && /haiku/i.test(res.autoDone), `a finished Auto run shows its resolved model from run.result (${JSON.stringify(res.autoDone)})`);

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors.slice(0, 6)) {
    console.log("   ", e.text.slice(0, 160));
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    await app?.close();
  } catch {}
}

console.log(exit === 0 ? "VERIFY OK: an Auto autopilot run displays the model the CLI actually resolved to." : "VERIFY FAILED.");
process.exit(exit);
