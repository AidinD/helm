/**
 * A turn that did the project's work itself instead of delegating it.
 *
 * ## The gap this closes
 *
 * The tier guard stops a first mate WRITING to a project. That was the celebrated fix, and
 * it addressed the smaller half of the problem. Haddock's real signature was not the writes:
 * it was 82 Bash calls from the coordinator's seat with ZERO delegations, and 180,000 tokens
 * of context across nine turns. Under the write guard alone that same run would have read
 * its way through the entire project for exactly as long, just unable to save the result.
 * The damage was made quieter, not smaller.
 *
 * ## Why absence is the signal
 *
 * Kun Chen's turn-end guard keys on the ABSENCE of dispatch metadata rather than on any
 * property of the work. That is what makes it durable: work not being registered anywhere is
 * itself detectable, and it stays detectable through any restructuring of what the tiers are
 * called or which tools they hold. A rule phrased as "a first mate may not run Bash" dies the
 * first time a first mate legitimately needs to run one.
 *
 * ## The threshold, and the evidence for it
 *
 * Measured over 597 real turns in Helm's own usage log on 2026-09-01, 305 of them rooted in
 * the meta-home:
 *
 *   action calls per turn:  0 → 174,  1-4 → 85,  5-9 → 23,  10-19 → 15,  20-49 → 7,  50+ → 1
 *
 * Nine of those turns delegated at all, and EIGHT of the nine made zero action calls. So
 * delegating and doing are almost perfectly separated in practice, which is what makes a
 * threshold meaningful rather than arbitrary.
 *
 * Ten action calls with no delegation would have flagged 22 turns in about two months - one
 * every three days - the worst of them 95 calls costing $12.14 in a single turn. Dropping to
 * five would add 23 more on weaker evidence and turn a rare signal into a routine one, which
 * is how a signal stops being read.
 *
 * That measurement is an OVER-estimate of what this will flag: it counted every meta-home
 * turn, and the guard only judges turns in an actual first-mate seat, not the captain's own
 * chats there.
 *
 * ## It never blocks
 *
 * This runs when a turn is already over. It cannot prevent anything, and it should not try -
 * the tier guard is where prevention lives. This exists so that a turn that quietly became
 * the worker instead of the coordinator says so afterwards, rather than only being noticed
 * when a bill arrives.
 */

/**
 * Tools that DO something to a project, as opposed to orienting in it.
 *
 * Reading is not on this list on purpose. A coordinator has to read to decide what to
 * delegate, and counting Read/Grep/Glob would flag exactly the turns that are doing their
 * job. What is being detected is a coordinator that started EXECUTING.
 */
export const ACTION_TOOLS = new Set(["Bash", "PowerShell", "Edit", "Write", "NotebookEdit"]);

/**
 * Tools that hand work to a lower tier.
 *
 * `helm_create_second_mate` is deliberately NOT here: creating a seat is setup, not
 * delegation, and a turn that made a mate and then did all the work itself is precisely the
 * behaviour being looked for.
 */
export const DELEGATION_TOOLS = /helm_dispatch|helm_relay_to_second_mate|helm_resume_crew|helm_resume_fleet/;

/** See the module comment for the distribution this comes from. */
export const UNDELEGATED_ACTION_LIMIT = 10;

/**
 * Seats that are supposed to delegate.
 *
 * A SECOND MATE is deliberately absent. It owns a project and dispatching crew is one of the
 * things it does, not the only one - flagging its own hands-on work would be a rule about a
 * tier that has not been shown to need one. Crew is the tier that is MEANT to do the work,
 * and the captain is a person. Adding a seat here is a decision to be made with evidence for
 * that seat, the same way this one was.
 */
export const DELEGATING_SEATS = new Set(["first-mate"]);

/**
 * @typedef {object} TurnEndFinding
 * @property {string} seat
 * @property {number} actionCalls How many project-changing tool calls the turn made.
 * @property {string[]} tools The action tools it used, with counts, worst first.
 * @property {string} reason What happened, in a person's words.
 * @property {string} whatToDo
 */

/**
 * Did this turn do the project's work instead of handing it out?
 *
 * Pure, and takes the whole tool list rather than a pre-computed count, so the finding can
 * name what was actually run - "62 Bash, 14 Edit" says more than "76 action calls".
 *
 * @param {object} turn
 * @param {string} turn.seat Which tier ran this turn.
 * @param {string[]} turn.toolsUsed Every tool call, in order, with repeats.
 * @param {number} [turn.limit] Override for the threshold; the default is the measured one.
 * @returns {TurnEndFinding|null} Null when there is nothing to say, which is the usual case.
 */
export function judgeTurnEnd({ seat, toolsUsed, limit = UNDELEGATED_ACTION_LIMIT } = {}) {
  if (!DELEGATING_SEATS.has(seat)) {
    return null;
  }
  const tools = Array.isArray(toolsUsed) ? toolsUsed : [];
  if (tools.some((t) => DELEGATION_TOOLS.test(String(t)))) {
    // It delegated. How much it also did with its own hands is not this guard's question:
    // a coordinator that hands out the work and then checks something itself is working.
    return null;
  }
  const counts = new Map();
  for (const tool of tools) {
    if (ACTION_TOOLS.has(String(tool))) {
      counts.set(tool, (counts.get(tool) || 0) + 1);
    }
  }
  let actionCalls = 0;
  for (const n of counts.values()) {
    actionCalls += n;
  }
  if (actionCalls < limit) {
    return null;
  }
  const breakdown = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tool, n]) => `${n} ${tool}`);
  return {
    seat,
    actionCalls,
    tools: breakdown,
    reason: `This first mate ran ${breakdown.join(", ")} and delegated nothing. That is the project's work being done in the coordinator's seat.`,
    whatToDo: "If the work was worth doing, it was worth dispatching to crew - the context it built is lost when this seat is retired. Check what it actually changed before moving on.",
  };
}
