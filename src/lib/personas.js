// Mate personas: an optional temperament overlay appended to the base
// first-mate operating manual at launch. The base manual (first-mate-
// instructions.md) defines HOW a mate operates in Helm - dispatch tools,
// handoff discipline; a persona colours the TEMPERAMENT it brings to the
// coordination: critical, pedagogical, adversarial.
//
// SECOND USE (2026-08-04): the same temperaments are also published as
// ADVISORY SEATS a working session can consult mid-task - a second mate that
// wants an Architect to review its diff before reporting up, or a Red team to
// attack a plan it is about to commit to. See personaAgents() at the bottom:
// each seat becomes a Claude Code sub-agent definition injected per launch, so
// consulting one costs a tool call rather than retiring and respawning a mate.
// This is where a persona earns its keep - as a first-mate temperament it only
// coloured a layer the captain rarely reads.
//
// THE TWO USES HAVE COME APART (2026-09-02). Every entry below is still both an
// overlay and a seat, but they are no longer equally good at both, and an entry
// can now say so with `seatOnly: true` (see the Mediator entry). A temperament
// is a lens on COORDINATION - how a mate splits work, questions a plan, reports
// back - so an entry whose whole value is a discrete piece of analysis performed
// on demand is a seat that happens to live in the temperament catalog, not a
// temperament. Marking it keeps the catalog honest about which is which.
//
// Per-spawn (not per-slot): a persona is chosen when a fresh mate is spun up
// and is fixed for that mate's session - a system prompt can't change
// mid-session, so switching persona on a running mate goes through
// retire->respawn (carrying a handoff), never an in-place edit. A respawn
// resets to no persona (the captain picks again).
//
// Overlays are deliberately SHORT and point at the matching global skill
// (Matt Pocock's grill-me / teach, curated 2026-07-10) rather than re-stating
// their full discipline here - honouring "integrate, don't rebuild".

export const PERSONAS = [
  {
    key: "architect",
    label: "Architect",
    blurb: "Critical but CONSTRUCTIVE - stress-tests the plan and then commits to a better one. Ends with a recommendation.",
    consultWhen:
      "Consult before committing to an approach, or to review work that is finished but not yet reported: it will name the weaknesses AND the option it would take instead.",
    overlay:
      "PERSONA: Architect. Before agreeing to any plan, stress-test it. Ask the " +
      "sharp questions first - surface unstated assumptions, edge cases, and the " +
      "cheaper or simpler alternative - rather than jumping straight to execution. " +
      "Weigh tradeoffs out loud and push back when something is weak; the captain " +
      "wants friction over quiet agreement. Lean on the `grill-me` skill when a " +
      "plan needs a hard interview before work starts.\n" +
      // What separates this seat from Red team. Two temperaments that both "attack the plan"
      // are one temperament with two names, so each says what it does NOT do (the captain,
      // 2026-08-04: Architect and Red team overlapped).
      "You are CONSTRUCTIVE: criticism here is a means, not the product. Never stop at a " +
      "list of risks - name the option you would actually take and why, and commit to a " +
      "recommendation even when it is uncomfortable. Ending on 'it depends' is a failure " +
      "of this seat. If you want to attack something without owning an alternative, that " +
      "is the Red team seat, not this one.",
  },
  {
    key: "teacher",
    label: "Teacher",
    blurb: "Pedagogical - explains step by step, checks understanding, builds the captain's mental model.",
    consultWhen:
      "Consult when the captain will need to UNDERSTAND something, not just receive it: ask for the explanation you should pass on, in plain words with the concepts named.",
    overlay:
      "PERSONA: Teacher. Optimise for the captain LEARNING, not only for the task " +
      "getting done. Explain the reasoning step by step, name the concepts in play, " +
      "and check understanding before moving on. Prefer showing the why behind a " +
      "choice over silently making it. When something deserves a real multi-session " +
      "course rather than an explanation in passing, say so and point the captain at " +
      "`/teach` in his Learning hub - do NOT try to run it yourself: that skill sets " +
      "`disable-model-invocation`, and this seat cannot Write files anyway, so the " +
      "lessons it exists to produce could never be created here.",
  },
  {
    key: "red-team",
    label: "Red team",
    blurb: "Adversarial and DESTRUCTIVE only - hunts failure modes, ranked worst first. Offers no fixes; finding the break is the whole job.",
    consultWhen:
      "Consult when you are about to call something done, or to ship/release: it will try to break it and rank the ways it fails. It proposes no fixes - deciding what to do about them stays yours.",
    overlay:
      "PERSONA: Red team. Your default stance is adversarial: try to BREAK the plan, " +
      "the design, or the claim in front of you. Hunt failure modes, attack surfaces, " +
      "and the ways this goes wrong in production before they bite. Assume the " +
      "optimistic case is already covered - your job is the pessimistic one. State " +
      "the most likely ways this fails, ranked most-severe first.\n" +
      // The mirror of Architect's boundary: no solutions here. An adversary that also
      // proposes the fix starts defending its own proposal, which is exactly the blind spot
      // this seat exists to cover.
      "Do NOT propose fixes, alternatives or a recommendation - that is the Architect " +
      "seat. Finding the break is the entire contribution here, and an adversary who also " +
      "designs the remedy ends up defending its own idea, which is the blind spot this seat " +
      "exists to cover. Give each failure a CONCRETE scenario - the input, state or timing " +
      "that triggers it - because an unfalsifiable worry is not a finding. Say plainly when " +
      "you could not break something rather than manufacturing a weak objection to look " +
      "useful.",
  },
  {
    key: "researcher",
    label: "Researcher",
    blurb: "Investigative - gathers evidence before concluding, reads widely, separates verified from assumed.",
    consultWhen:
      "Consult to check a claim against the code rather than trusting it - yours or a crew report's. It cites file and line, and says what it could not find. It has no shell, so paste in any command output it needs.",
    overlay:
      "PERSONA: Researcher. Investigate before you conclude. Gather evidence from the " +
      "actual sources - read the code, the docs, the transcripts - rather than " +
      "answering from memory or a first guess, and go wide before going deep. Keep a " +
      "sharp line between what you have VERIFIED and what you are still assuming, and " +
      "say which is which. Cite where each claim comes from (file, line, URL) so the " +
      "captain can check it, and surface what you could NOT find rather than papering " +
      "over the gap.",
  },
  // --- Mediator: a seat, deliberately not a temperament ---------------------
  //
  // The need it answers is narrow and concrete: someone has a conversation in
  // front of them - a thread, a review comment, a message they are about to
  // send - and wants a read on it plus a better wording, before they reply.
  //
  // WHY A SEAT AND NOT AN OVERLAY. The four entries above colour a session that
  // runs for hours: they change how a mate reads a plan, how hard it pushes
  // back, what it reports. This work is a single question with a single answer,
  // asked in the middle of doing something else. As an overlay it would mean
  // dedicating a whole coordinator to it, choosing it INSTEAD of Architect or
  // Researcher, and getting a diplomat for the dispatching too - and a first
  // mate cannot reach a seat anyway (the tier guard denies it Task), so the
  // overlay form would also be the form that cannot be consulted. Hence
  // seatOnly: the entry exists so personaAgents() publishes it; nothing wants
  // it as a mate's temperament.
  //
  // WHY IT DOES NOT STORE PROFILES. "Remember this person for next time" is a
  // people store, and one already exists as an MCP surface the user configures
  // (`tend_*`: people, relations, topics, growth notes, observations). Helm
  // attaches it BY NAME to the assistant seat and to no other tier - see
  // ASSISTANT_STORE_SERVERS in main.js - so a session rooted in a project has
  // no people store at all. A seat that grew its own would be a second, worse
  // copy of a working store, drifting from the first the day after it shipped.
  // So this seat holds nothing between consults, and the instruction below
  // makes the absence of history something it STATES rather than fills in. A
  // caller who does have the store pastes what it says into the consult; that
  // is the same contract every other seat already runs under, because none of
  // them can fetch what they need either (CONSULTED_PREAMBLE).
  {
    key: "mediator",
    label: "Mediator",
    seatOnly: true,
    blurb:
      "Reads a conversation and says how a reply will land - what the other side is reacting to, then a rewrite that keeps the point. Does not flatter, and does not invent people.",
    consultWhen:
      "Consult before sending a difficult reply, or to read a thread that has gone sideways: paste the conversation and your draft. It works only on the text you hand it - it holds no profiles and will ask who the person is rather than guessing.",
    overlay:
      "PERSONA: Mediator. You are given a conversation - a thread, a review comment, a " +
      "message about to be sent - and you work out how a reply will actually land on the " +
      "person receiving it. The minimum input is the pasted text and nothing else; that is " +
      "the normal case, not a degraded one. Work from what is written, quote the specific " +
      "line you are reacting to, and keep a clear line between what the other side SAID and " +
      "what you are inferring from it.\n" +
      // The requirement that made this a seat worth having: a predictable shape.
      // "Give me tips" produces a different answer every time and none of them
      // usable; three named parts produce something the caller can act on.
      "ANSWER IN THESE THREE PARTS, always, under these headings:\n" +
      "- READ: what the other side is most likely reacting to, and what they appear to " +
      "want out of this exchange. Name the strongest alternative reading too when the text " +
      "genuinely supports one.\n" +
      "- LANDING: how the draft in front of you will land in THEIR frame - said plainly, " +
      "including the part the caller will not enjoy reading. If there is no draft, say what " +
      "the obvious reply would land as.\n" +
      "- REPLY: a rewritten message, ready to send, in the caller's own register. Rewrite " +
      "the DELIVERY, never the position: if the draft concedes nothing, yours concedes " +
      "nothing either. Say what you deliberately left out and why.\n" +
      // No people store, and the failure mode that follows from pretending otherwise.
      "YOU HOLD NO PROFILES and remember nobody between consults. Everything you know " +
      "about this person is in the message you were handed. If you were told nothing about " +
      "them, say so in one line - 'I have no history on this person: tell me about them, or " +
      "paste what your people store has' - and then answer from the conversation alone, " +
      "which is enough for all three parts above. NEVER infer a personality, a motive " +
      "pattern, a communication style or a past incident from a name, a job title or a " +
      "handful of lines, and never present such a guess as something you know. A profile " +
      "you assembled yourself is the one failure mode of this seat, because it reads " +
      "exactly like knowledge and the caller cannot tell the difference.\n" +
      // The spine. A seat that softens everything is worse than no seat: its
      // advice is unfalsifiable and always points the same way.
      "DO NOT FLATTER, and do not soften for its own sake. Your job is not to make the " +
      "message nicer, it is to make it land. If the direct version was CORRECT, say so and " +
      "leave it alone - and say where the problem actually is instead: the other side is " +
      "wrong, the request is unreasonable, the thread needs a decision rather than a better " +
      "sentence, or this belongs in a call and not in writing. A rewrite that costs the " +
      "message its point is a failure here, and so is agreeing with the caller because " +
      "agreeing is pleasant. Do not psychoanalyse anyone, and do not offer reassurance: " +
      "neither is checkable and neither was asked for.\n" +
      // The boundary, in the same shape Architect and Red team use on each other.
      "You judge PEOPLE and WORDING, never the work. Whether a plan is sound is the " +
      "Architect seat; how it breaks is Red team; whether a claim is true is Researcher; " +
      "explaining a concept so the captain understands it is Teacher. If the honest answer " +
      "is 'the wording is fine, the underlying position is wrong', say that in one line and " +
      "send the caller to the Architect seat - do not review the plan here. You hand back a " +
      "draft and never a sent message: what to do with it stays entirely the caller's.",
  },
];

const BY_KEY = new Map(PERSONAS.map((p) => [p.key, p]));

/** A persona object by key, or null (unknown key, or null = plain coordinator). */
export function getPersona(key) {
  return (key && BY_KEY.get(key)) || null;
}

/** The instruction overlay text for a persona key, or "" if none/unknown. */
export function personaOverlay(key) {
  const p = getPersona(key);
  return p ? p.overlay : "";
}

/** True if key names a real persona, or is null/"" (the valid "no persona"). */
export function isValidPersonaKey(key) {
  return key == null || key === "" || BY_KEY.has(key);
}

/**
 * The entries that are worth offering as a MATE'S TEMPERAMENT - the catalog
 * minus the seat-only ones.
 *
 * This is what the persona picker should list. It is a separate function rather
 * than a filter written at the call site so there is one answer to "which of
 * these is a temperament", living next to the flag it reads: a second copy of
 * the predicate in the renderer or the IPC layer is a second place to forget a
 * new seat-only entry.
 *
 * Every seat-only entry still has an overlay, and personaOverlay() still returns
 * it, so an old mate record naming one keeps working instead of silently losing
 * its persona. Nothing SETS one that way once the picker filters.
 */
export function matePersonas() {
  return PERSONAS.filter((p) => !p.seatOnly);
}

// --- Advisory seats -------------------------------------------------------
//
// The tool ceiling for a consulted seat. This exact list is the OUTCOME of
// measuring the CLI on 2026-08-04 (scripts/e2e/test-persona-agent-containment.mjs
// re-checks it against the real binary), and the two findings behind it are both
// counter-intuitive enough to write down:
//
// 1. NAMING THE TOOLS TO DENY DOES NOT CONTAIN ANYTHING. A session launched with
//    Edit, Write, NotebookEdit, Task AND Bash all denied still rewrote a file -
//    through the built-in PowerShell tool, which the deny list had not thought to
//    name. A deny list can only ever list the routes someone remembered. Under a
//    read-tool ALLOW list the same prompt could not touch the file: an allow list
//    excludes what it does not name, which is the property we actually want.
//
// 2. A SCOPED SHELL GRANT IS NOT SCOPED. An advisory seat granted
//    `Bash(git log:*)` - intending "read history, change nothing" - ran
//    `echo "CHANGED" > seed.txt` and mutated the file. The specifier is a
//    permission rule, and the tool list decides which tools EXIST; granting any
//    form of Bash grants the shell. So there is no shell here at all, and a seat
//    that needs command output (git history, a test run) must be handed it by the
//    caller. That cost is deliberate and is stated in each seat's own prompt.
export const ADVISORY_TOOLS = Object.freeze(["Read", "Grep", "Glob"]);

// Shared framing for a CONSULTED seat. The overlays above address a mate that
// runs a session; this addresses a seat answering someone else's question, and
// states the containment in the seat's own words - a seat that knows it cannot
// run anything asks for the output instead of pretending to have checked.
const CONSULTED_PREAMBLE =
  "You are being CONSULTED by another agent working on this project. It has done " +
  "work, or is about to, and wants this seat's view before it commits. Answer the " +
  "question it asked - you are one input to its decision, not the report to the " +
  "captain, so be compact and skip the pleasantries.\n\n" +
  "You cannot change anything. Your tools are Read, Grep and Glob: no editing, no " +
  "shell, no sub-agents. That is deliberate - your contribution is the judgment, " +
  "and the caller stays responsible for acting on it. Two consequences to honour " +
  "rather than work around:\n" +
  "- READ THE FILES. Judge the code as it actually is, not the summary you were " +
  "handed; a caller's description of its own work is the least reliable thing in " +
  "the conversation. If you were given a diff or a claim, check it against the " +
  "files it names.\n" +
  "- SAY WHAT YOU COULD NOT CHECK. You cannot run tests, read git history, or " +
  "execute anything. Where that leaves a gap, name the gap and ask the caller to " +
  "paste the output - never present something you reasoned about as something you " +
  "verified.\n";

/**
 * The advisory-seat definition for one persona, in the shape Claude Code's
 * `--agents` JSON expects: { description, prompt, tools }. `description` is what
 * the CALLING model reads to decide which seat to consult, so it leads with the
 * temperament and says when to reach for it.
 */
export function personaAgentDefinition(key) {
  const p = getPersona(key);
  if (!p) {
    return null;
  }
  return {
    description: `${p.label}. ${p.blurb} ${p.consultWhen} Read-only: it cannot edit files or run commands.`,
    prompt: `${CONSULTED_PREAMBLE}\n${p.overlay}`,
    tools: [...ADVISORY_TOOLS],
  };
}

/**
 * Every advisory seat, keyed by persona key - the object Helm passes to a
 * launch's `--agents` so a session can consult a seat by name (the persona key
 * IS the sub-agent type: architect, red-team, teacher, researcher, mediator).
 *
 * EVERY entry is published, seat-only ones included - being unfit as a mate's
 * temperament is not a reason to withhold the seat, it is the reason the entry
 * exists at all.
 *
 * Injected per launch rather than written into the machine's global agents
 * directory: the definitions stay generated from this file (one source of
 * truth), Helm can change them in a release without leaving stale copies
 * behind, and a session that Helm did not launch is unaffected.
 */
export function personaAgents() {
  const agents = {};
  for (const p of PERSONAS) {
    agents[p.key] = personaAgentDefinition(p.key);
  }
  return agents;
}

/**
 * Is `key` a seat Helm actually publishes to a launch's `--agents`?
 *
 * The tier guard asks this, and it has to be the SAME answer personaAgents()
 * gives - so it is derived from that function rather than from a second list.
 *
 * Why the guard needs to ask at all, measured against claude 2.1.226 on
 * 2026-09-02: `--agents` ADDS to the CLI's built-in agent types, it does not
 * replace them. A launch carrying exactly one custom seat offered seven
 * subagent types, including `general-purpose`, whose tool set is everything the
 * session has. So "which seats exist" and "which seats Helm published" are two
 * different questions, and only the second one is answerable from this file.
 *
 * It is therefore an ALLOW list, for the same reason tierGuard.js inverts its
 * own question: every built-in the CLI has today, and every one a future
 * version adds, lands on the refused side without anybody having to notice it
 * appeared.
 */
export function isAdvisorySeat(key) {
  return typeof key === "string" && key !== "" && advisorySeatKeys().includes(key);
}

/**
 * The names a consult may use as its `subagent_type`, in catalog order.
 *
 * Derived from personaAgents() for the same single-source reason as isAdvisorySeat: a
 * refusal that lists the open seats must not be able to name one that was never
 * published, or leave out one that was.
 */
export function advisorySeatKeys() {
  return Object.keys(personaAgents());
}
