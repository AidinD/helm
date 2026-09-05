/**
 * Which helm_* tools a seat may call, decided by WHAT THE SEAT IS.
 *
 * Split out of one shared array on 2026-09-05. Before that, first mates, second mates and the
 * assistant were all handed `FIRST_MATE_ALLOWED_TOOLS`, so "give the standing seat something
 * the project seats do not have" was not expressible at all.
 *
 * KEYED ON THE SEAT, NOT ON ITS ROOT, and that is the load-bearing part rather than a style
 * choice. Under the 2026-09-05 decision meta-home seats are NAMED - the assistant and a
 * supervisor share a root and have different manuals, different duties and no reason to share
 * a toolset. A rule that asked "is this rooted in the meta-home" would hand the supervisor the
 * assistant's tools the moment it exists. It is also the 2026-07-15 scar restated: rooting
 * alone was tried as a discriminator and reverted, because every ordinary chat kept in that
 * folder was mis-framed by it.
 *
 * So the argument is the seat's own declared kind. Today that is `kind`; when personas take
 * over seat identity it becomes the persona, and the shape does not have to change.
 */

/** Every dispatching seat can do these: hand work out, read state, and answer upward. */
export const DISPATCH_TOOLS = [
  "helm_dispatch",
  "helm_collect_reports",
  "helm_list_projects",
  "helm_fleet_state",
  "helm_report_up",
  "helm_resume_fleet",
  "helm_resume_crew",
];

/**
 * Reaching into ANOTHER project. Opening a seat for a repo, or driving one from outside it.
 *
 * A standing seat above every project may do this - it is the one thing that seat is for. A
 * PROJECT seat may not, and that restriction is the tier removal holding: a project seat that
 * can open and drive other projects' seats is the coordinator tier growing back from below,
 * informally and with nobody having decided it.
 */
export const CROSS_PROJECT_TOOLS = ["helm_open_project", "helm_relay_to_project"];

/**
 * The names these two answered to before 2026-09-05, mapped to what they are called now.
 *
 * THEY STAY PRE-APPROVED, and that is the whole point of an alias. A saved instruction or a
 * running session calling the old name must still reach the tool - and an allowlist that only
 * carried the new name would block it before it ever got there, with no error the caller can
 * see. An unoffered tool is simply never called, which is the same silent failure the rename
 * exists to avoid.
 *
 * They come out when it can be MEASURED that nothing calls them - see recordLegacyToolCall.
 */
export const LEGACY_TOOL_ALIASES = {
  helm_create_second_mate: "helm_open_project",
  helm_relay_to_second_mate: "helm_relay_to_project",
};

/**
 * The helm_* tool names for a seat, unprefixed.
 *
 * `standing` covers the meta-home seats - today only the assistant, tomorrow named ones. An
 * unknown kind gets the dispatch set and nothing more: the safe direction for a seat nobody
 * has classified is fewer tools, not the union.
 */
export function helmToolsForSeat(seatKind) {
  if (seatKind === "standing" || seatKind === "assistant") {
    return [...DISPATCH_TOOLS, ...CROSS_PROJECT_TOOLS, ...Object.keys(LEGACY_TOOL_ALIASES)];
  }
  return [...DISPATCH_TOOLS];
}

/**
 * Two seats sharing a root may hold different tools - can this split even say that?
 *
 * Asserted by the checks rather than left as intent, because the whole point of the split was
 * to make that expressible before the second meta-home seat exists. If this ever returns true
 * for a pair that should differ, the split has collapsed back into one list.
 */
export function seatToolsDifferBetween(kindA, kindB) {
  const a = helmToolsForSeat(kindA).slice().sort().join("|");
  const b = helmToolsForSeat(kindB).slice().sort().join("|");
  return a !== b;
}
