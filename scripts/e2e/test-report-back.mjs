// E2E: what a finished run REPORTS - its one-line what-changed, whether it needs the captain,
// and how it is labelled - built from the run's own record.
//
// This file used to wait for a separate Dashboard "Report-back" section (#dashReportSlot). That
// section was deliberately removed on 2026-07-11 at Aidin's own request ("Faculty, not a room"):
// terminal runs report back UNDER their dispatcher's roll-up, and anything needing the captain
// surfaces in the Needs-you queue. Two E2E files were updated in that commit; this one was not, so
// it has been failing ever since on a selector that cannot exist - while
// test-tiered-report-back.mjs asserts the OPPOSITE, that #dashReportSlot is absent. Two tests
// contradicting each other, one of them red for weeks.
//
// The CONTENT assertions were worth keeping, and nothing else covered them: the roll-up test checks
// which runs appear where, never what each row says. So they are repointed at dashReportRowEl - the
// surviving unit that builds a report row wherever it is shown - which is what they were about.
//
// Run:  node scripts/e2e/test-report-back.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[report-back-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  // #pageToggle is static HTML and can become visible a hair BEFORE renderer.js finishes
  // evaluating its top-level state, so touching it immediately races that. Settle first.
  await new Promise((r) => setTimeout(r, 800));

  const res = await app.eval(`(() => {
    const mk = (over) => ({
      goalRunId: "r", ordinal: 1, goal: "g", projectPath: "P", dispatchedBy: null,
      status: "done", result: null, iterations: [], error: null, escalation: null, latestPlan: null,
      ...over,
    });
    const rowOf = (run) => {
      const el = dashReportRowEl(run);
      document.body.append(el);
      const out = {
        text: el.innerText,
        needs: el.classList.contains("dash-report-needs"),
        icon: el.querySelector(".dash-state-ic")?.textContent || "",
        iconClass: el.querySelector(".dash-state-ic")?.className || "",
        // Read straight off the classifier, not the DOM: the quiet awaiting-review
        // line has no rendered surface yet (that is the deferred half of the
        // 2026-08-20 split), so the assertion has to reach the value itself rather
        // than a widget that does not exist. Asserting it here is what stops the
        // information being quietly dropped while its surface is still unbuilt.
        awaitingReview: goalRunReport(run).awaitingReview || null,
      };
      el.remove();
      return out;
    };

    return {
      // Converged WITH commits - the loop's one genuinely successful outcome. It raises
      // no alarm: needs-captain means something went wrong or a decision is needed, and
      // this is neither. Its what-changed is the implement iteration's own summary rather
      // than a generic "finished". The commits are still announced, on awaitingReview.
      // (No backticks in here - this block lives inside a template literal.)
      commits: rowOf(mk({
        goalRunId: "doneCommits", goal: "Add the export button",
        result: { commitCount: 3, branchName: "helm/goal-abc", stoppedReason: "no_op_convergence" },
        iterations: [{ ok: true, phase: "implement", result: { success: true, summary: "Wired the export button to the CSV writer" } }],
      })),
      // Converged having committed NOTHING. This used to be called the "clean" case and
      // asserted to need nobody - which had it backwards: a run that stopped without
      // changing anything either had its goal already met or was stuck, and telling those
      // two apart is exactly a captain's job. So this is the row that raises the flag.
      nothingCommitted: rowOf(mk({
        goalRunId: "doneClean", goal: "Investigate flaky test",
        result: { commitCount: 0, branchName: "helm/goal-def", stoppedReason: "no_op_convergence" },
      })),
      // Escalated: the escalation's detail IS the what-changed line.
      escalated: rowOf(mk({
        goalRunId: "esc", goal: "Refactor auth layer", dispatchedBy: "mate_work",
        result: { commitCount: 1, branchName: "helm/goal-ghi" },
        escalation: { signal: "ambiguity_reported", detail: "Unclear which token store to use" },
      })),
      // Errored: failed, needs the captain, and the error is what it says.
      errored: rowOf(mk({ goalRunId: "err", goal: "Upgrade the bundler", status: "error", error: "npm build failed" })),
      // A still-running run is not a RESULT, and the gate for that is isTerminalRun - the
      // predicate every report-back surface filters on before building a row.
      //
      // The first version of this asserted !!goalRunReport(run).terminal === false. goalRunReport
      // has no terminal field at all, so that was !!undefined === false: an assertion that could
      // not fail, on the very day two independent reviewers found three of them in this repo. It
      // also reported status "done" for a running run, which is what gave it away - goalRunReport
      // falls through to the finished shape because it is only ever CALLED for a terminal run.
      live: {
        running: isTerminalRun(mk({ status: "running" })),
        done: isTerminalRun(mk({ status: "done" })),
        error: isTerminalRun(mk({ status: "error" })),
        interrupted: isTerminalRun(mk({ status: "interrupted" })),
      },
      // And the removed surface must stay removed - the opposite of what this file used to wait for.
      slotGone: !document.getElementById("dashReportSlot"),
    };
  })()`);

  log("commits row:\n" + res.commits.text);

  assert(/Add the export button/.test(res.commits.text), "a finished run's row names its goal");
  assert(
    /Wired the export button to the CSV writer/.test(res.commits.text),
    "its 'what changed' line is the implement iteration's own summary, not a generic finished message"
  );
  // The commit count and branch still have to REACH the reader - the point of the
  // 2026-08-20 split was to move them off the alarm line, not to drop them. Nothing
  // else surfaces landed-but-unread work, and 117 crew commits reached crewline's
  // master that way, so this asserts they are still stated.
  assert(
    /3 commits/.test(res.commits.text),
    `the row still states how much landed (${JSON.stringify(res.commits.text.slice(0, 130))})`
  );
  assert(
    /3 commits ready for review in helm\/goal-abc/.test(res.commits.awaitingReview || ""),
    `and the quiet awaiting-review line names the count + branch (${JSON.stringify(res.commits.awaitingReview)})`
  );
  // Settled with Aidin 2026-08-20: needs-you is an ALARM, so the one successful outcome
  // must not wear it. This assertion was inverted until then, which is why every clean
  // run counted toward the tally and the queue flagged everything.
  assert(res.commits.needs === false, "a successful run with commits raises NO needs-captain accent - nothing went wrong");
  assert(res.commits.icon === "✓" && /dash-state-done/.test(res.commits.iconClass), "and shows the done check");

  assert(/Investigate flaky test/.test(res.nothingCommitted.text), "a run that committed nothing renders its row too");
  assert(res.nothingCommitted.needs === true, "and DOES carry the needs-captain accent - stopping without changing anything is not success");
  assert(res.nothingCommitted.icon === "⚠" && /dash-state-needs/.test(res.nothingCommitted.iconClass), "with the warning icon");

  assert(/Refactor auth layer/.test(res.escalated.text), "an escalated run's row renders");
  assert(
    /Unclear which token store to use/.test(res.escalated.text),
    "and its what-changed is the escalation's own detail - the reason it stopped"
  );
  assert(res.escalated.needs === true, "an escalation needs the captain");
  assert(
    /Dispatched/.test(res.escalated.text) && !/Dispatched/.test(res.commits.text),
    "a dispatched run is labelled as such, and one the captain started himself is not"
  );

  assert(/Upgrade the bundler/.test(res.errored.text), "an errored run's row renders");
  assert(/npm build failed/.test(res.errored.text), "with the error as its what-changed line");
  assert(res.errored.needs === true, "and it needs the captain");

  assert(res.live.running === false, "a still-running run is not a finished result, so no report surface builds a row for it");
  assert(
    res.live.done === true && res.live.error === true && res.live.interrupted === true,
    `and the three states that ARE results all count (done ${res.live.done}, error ${res.live.error}, interrupted ${res.live.interrupted}) - so the check above is not passing on a predicate that says no to everything`
  );

  assert(
    res.slotGone,
    "the separate Dashboard Report-back section stays removed - runs report under their dispatcher, which is what this file used to contradict"
  );

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    log("  console error:", e.text.slice(0, 160));
  }

  log(
    exitCode === 0
      ? "VERIFY OK: a finished run's report row says what changed, flags what needs the captain, and labels where it came from."
      : "VERIFY FAILED."
  );
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
