/**
 * Every durable store Helm keeps as a plain file beside the app, and the env var that moves it.
 *
 * WHY THIS IS ITS OWN MODULE, rather than a list inside packagedPaths.js where it lived until
 * 2026-09-11. That file imports `electron`, so nothing outside the main process can read it -
 * and the list turned out to have a second, equally load-bearing reader: the E2E harness.
 *
 * The packaged build was the first problem. Each store resolves its file as
 * `process.env.HELM_<X>_PATH || <repo root>/<file>`, which is right in dev and fatal when
 * installed, because the fallback lands inside the read-only app.asar (task 7d9d2188:
 * scheduling a prompt worked in dev and failed in the installed app).
 *
 * The SECOND problem is the same list from the other end, and it is why this moved. An
 * app-check that launches the real app and does not override a seam writes into the captain's
 * actual store. The harness already understood this and fixed it for exactly one seam:
 * "Isolate config.json so E2E runs never write their throwaway test sessions into the real
 * dev-repo config.json ... Belongs in the harness, not each test, so ALL current and future
 * E2Es are isolated automatically." That reasoning is correct and it was applied to one entry
 * of a list of eleven.
 *
 * Measured on 2026-09-11 rather than argued: config.json, the seam the harness owns, was
 * CLEAN. mates.json held three seats rooted in deleted E2E temp directories, and
 * goal-run-history.json held seven lines of a dispatch run's scratch repo. The captain found
 * it by reading his own dashboard and not recognising the names on it.
 *
 * So both readers derive from here, and neither keeps its own copy to drift from.
 *
 * ADDING A STORE: add it here. test-packaged-store-paths.mjs sweeps src/lib for
 * `process.env.HELM_*_PATH|DIR` and fails if a seam it finds is missing from this list, so
 * the registry cannot quietly fall behind the code. That check derives its other side from
 * the source, never from this file, which is what keeps it from confirming itself.
 *
 * @type {ReadonlyArray<readonly [envVar: string, fileName: string]>}
 */
export const REPO_ROOT_STORES = Object.freeze([
  ["HELM_CONFIG_PATH", "config.json"],
  ["HELM_DOMAINS_PATH", "domains.json"],
  ["HELM_GOAL_RUN_HISTORY_PATH", "goal-run-history.json"],
  ["HELM_MATES_PATH", "mates.json"],
  ["HELM_SECOND_MATES_PATH", "second-mates.json"],
  ["HELM_ROUTINES_PATH", "routines.json"],
  // Missing from the packaged redirect until 2026-08-02, which is why queueing a prompt in the
  // INSTALLED app failed with "Could not write the scheduled-prompt queue" while it worked
  // perfectly in dev (the captain, task 7d9d2188): without the redirect the store resolved
  // inside the read-only app bundle.
  ["HELM_SCHEDULED_PROMPTS_PATH", "scheduled-prompts.json"],
  ["HELM_USAGE_PATH", "helm-usage.jsonl"],
  ["HELM_USAGE_LOG_PATH", "usage-log.jsonl"],
  ["HELM_IMAGES_DIR", "pasted-images"],
].map((pair) => Object.freeze(pair)));

/**
 * Where an E2E run's stores should live, given the environment it is about to launch with.
 *
 * A FUNCTION RATHER THAN A LOOP INSIDE THE HARNESS, and the reason is a mutation that
 * survived. The check that guards this first asserted only that the harness source mentioned
 * `REPO_ROOT_STORES` - so replacing the import with `const REPO_ROOT_STORES = []` left it
 * green while every store went back to the captain's real files. Asserted by NAME, not by
 * behaviour, which is the first entry on this repo's own failure list.
 *
 * Pulling the decision out here makes it something a pure check can CALL and inspect, with no
 * Electron to launch and no processes to reap. The harness keeps the I/O - making the
 * directory, cleaning it up - and this owns the answer.
 *
 * @param {Record<string,string|undefined>} env  the environment as it stands
 * @param {string} dir  the throwaway directory to point the stores at
 * @returns {Record<string,string>} overrides to apply; empty when nothing should be isolated
 */
export function storeIsolationEnv(env, dir) {
  // HELM_DATA_DIR means "one shared directory decides where every store lives" - the packaged
  // build's own mechanism, answering the same question this does. Two mechanisms for one
  // decision, so the explicit one wins. Pre-setting the seams made packagedPaths.js's
  // setIfUnset find them already set, and test-packaged-build failed on the assertion that
  // exists because a missing redirect broke the installed app (task 7d9d2188).
  if (env?.HELM_DATA_DIR) {
    return {};
  }
  const out = {};
  for (const [envVar, fileName] of REPO_ROOT_STORES) {
    // A check's OWN override always wins: pointing a seam at a fixture is deliberate.
    if (!env?.[envVar]) {
      out[envVar] = `${dir.replace(/[\\/]+$/, "")}/${fileName}`;
    }
  }
  return out;
}
