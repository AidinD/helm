# First-mate voice personality - recommendation

Status: recommendation for discussion (Jot p0 40b13017 "first mates ska ha personlighet (tal) som matchar karaktären - kul idé eller irriterande?").
Not built. This is the "how would it fit / how would we push it in" write-up the captain asked for.

## The question, sharpened

Should a first mate *sound* like its name - Barbossa dry and wry, Nemo formal and precise - in the text it produces?
And is that a fun bit of identity, or fluff that gets annoying in a tool you drive many times a day?

## Verdict

**Yes - but only as a thin, opt-in, tone-only layer that is OFF by default and can never touch substance.**
The moment "personality" adds a word, a sentence, a roleplay flourish, or softens a direct answer, it has failed and should be cut.

The reason to be this conservative is the captain's own standing rules: concise, no fluff, honest, push back, no em-dash.
A strong character voice (pirate-speak, in-character narration) fights every one of those. A *faint* tonal signature does not - it can make the two named mates feel distinct and a little warmer at zero cost to clarity, IF it stays subordinate to concision.

## Two axes, kept separate

We already shipped **personas** (architect / teacher / red-team): how a mate *thinks* - injected as a system overlay (`personaOverlay`).
Voice is a different axis: how a mate *sounds*, tied to its **name** (identity), not its persona.

Keep them orthogonal:
- Persona = reasoning stance. Chosen per-spawn, changes what the mate does.
- Voice = tonal flavor. Tied to the sea-captain name, changes only how it phrases the same substance.

A mate can be an Architect that sounds like Nemo, or a Teacher that sounds like Barbossa. Collapsing them into one axis would wrongly couple "how it thinks" to "what it's called."

## Where voice may and may NOT appear

- **May color:** the mate's OWN generated prose - chat replies, its handoff summary, its cross-project rollup. This is the mate talking.
- **Must NOT color:** app-generated UI microcopy - status lines ("working…", "idle"), fleet nudges, badges. That text is *the app* talking, not the mate. Faking a character voice in the app chrome is the cringe, annoying kind of personality and buys nothing. This line is the whole difference between "tasteful" and "irritating."

## The hard guardrail (this is the load-bearing part)

The voice overlay must state, in the prompt, that flavor is strictly subordinate:

> You may carry a light <trait> flavor in how you phrase things. This is tone only: never add words, length, preamble, or roleplay for the sake of character, and never let flavor reduce directness or clarity. If flavor would ever compete with being concise and sharp, drop the flavor. No greetings-in-character, no narration, no accent spelling.

Without that clause, a model will happily drift into "Arr, the Skiff deadline be lookin' grim, cap'n" - exactly the failure mode the task worries about.

## Recommended traits (small, concision-aligned)

Tie each pooled name to a one-word-ish trait that is compatible with terseness. Examples:
- Captain Nemo - formal, precise
- Hector Barbossa - dry, wry
- Captain Ahab - intense, terse
- Jean-Luc Picard - measured, principled
- Han Solo - blunt, informal
- Captain Haddock - gruff, plainspoken

Note every trait is compatible with "short and sharp." None is "verbose", "whimsical", or "chatty" - those would fight the guardrail.

## How we'd push it in (implementation sketch)

Mirrors the persona plumbing exactly, so it's small and consistent:

1. `src/lib/voice.js` (new): a `NAME_TRAITS` map (name -> short trait) + `voiceOverlay(name, enabled)` returning the ~2-sentence overlay above (with the trait spliced in) or `""` when disabled/unknown. Single source of truth.
2. `config.js`: `mateVoice: false` (global, default OFF). One flag, one kill switch.
3. `main.js` launch: after the persona overlay, if `config.mateVoice` is on, append `voiceOverlay(mate.name, true)`. Same injection point, same "fresh turn only" rule.
4. UI: a single toggle (Settings, or a small control on the Fleet card / persona row) - "Mate voice: off / subtle". Off = literally no line in the prompt.
5. Not tied to persona; tied to the mate's current name. A rename changes the voice with it (the name IS the identity).

Cost: ~one small module + one flag + one toggle. Blast radius: zero on functionality (prompt-only, additive, off by default).

## Recommendation to the captain

Ship it as **opt-in, default OFF, subtle-only, name-tied, guardrailed** - then actually turn it on for a week and judge it live.
It is cheap to try and trivial to kill (flip one flag). If during that week any mate reply reads even slightly longer or softer *because of* the voice, the guardrail didn't hold and we remove the feature rather than tune it - the bar is "invisible unless you're looking for it."

Open question for the discussion: do you even want a "subtle" level, or is the honest answer that a coordination tool should have zero voice and this is a no? I lean "try subtle, default off" - but I'd take "skip it" as a perfectly defensible call given the no-fluff ethos.
