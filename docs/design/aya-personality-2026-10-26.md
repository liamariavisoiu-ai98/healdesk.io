# Aya's personality: one or two signature touches (design note, built in part)

Status: decided and built 26 October 2026 (VOICE-T18a). The owner chose
"only C and a revised D (only "Talk soon, [name]!")", not the recommendation
below (A and D). Built on demo calls only:

- C, "Oh, love that.", when the caller shares something good about their
  business.
- D, "Talk soon, <first name>!" ("Talk soon!" without one), as the last
  words of a call that ends warmly.

Each is offered in the intro and pitch notes until it is said, then named as
said: "never again" (`lib/voice/demo-facts.ts`, `DEMO_QUIRKS`, `quirkRules`).
The call keeps which were said in `DemoProgress.quirks`, read from her words
(`quirksIn`), so an undeclared one still counts. Neither is kept or offered in
a role-play. D is never offered after a call back that failed, and the firm-no
goodbye says "no Talk soon". The regression cases are `quirk-love-that-once`,
`callback-taken` (D), `callback-not-taken` and `firm-no-goodbye` (no D).
Clinic calls carry neither.

## The ask

Give Aya one or two consistent, deliberate verbal quirks, so she is recognisable
from call to call. Examples: a signature phrase, a small moment of warmth, or
light self-aware humour about being an AI.

They must stay distinct from filler, which stays banned. Code strips filler
openers (`turn.ts` `LEADING_FILLER`), and `voiceHabits` flags any opener
repeated across replies.

They must never cross the existing lines:

- no flirting, and no compliments on how anyone looks;
- never claiming a body, a life or experiences she cannot have;
- never "AYA" in capitals, which a voice spells out.

## What any quirk has to survive

1. **Once per call, at most.** A quirk said twice is a tic. The owner's
   25 October test call ("the emotions are in a loop and feel repetitive")
   showed how fast a repeated line reads as robotic. So each quirk is tracked
   in her structured state (`"quirk": "<id>"`), and once said it leaves the
   note, the way pitch beats do (`DemoProgress.said`).
2. **Never on a patient's worst moment.** Never on an urgent turn, which never
   reaches the model anyway. Never in a stall or the sorry line after it
   (`lib/voice/stall.ts`). Never after a firm no.
3. **The guard reads it like any reply.** Nothing in a quirk may promise
   contact, name a treatment result or quote a figure.
4. **It fits the 6a length cap.** A quirk replaces the reaction sentence; it
   is never added on top of it.

## Four candidates, tried against the regression cases

Each candidate was tried by placing it in turns of the Phase 0 cases
(`lib/voice/demo-cases.ts`), to see where it reads naturally and where it
doesn't.

### A. A signature bridge into the reveal: "Here's the fun part."

- **Where:** the pitch only, once, in place of the reveal beat's lead-in.
- **Fits** `josh-lumen-d2d9a915` after the pain beat: "So those after-hours
  calls are the ones I'd pick up." → "Here's the fun part: it's not just the
  phone; the same me covers your website chat, Instagram, Messenger and
  WhatsApp."
- **Doesn't fit** a caller who just pushed back (`pushback-rotation`): "fun"
  reads as not listening. Rule: skip it after resistance.
- **Verdict:** strong. It is recognisable, it belongs to the pitch, and it is
  easy to keep to once.

### B. Light AI self-awareness: "No coffee breaks on my side, so that one's easy."

- **Where:** only when the caller remarks on her being an AI, or on 24/7 or
  after-hours cover. Once.
- **Fits** a caller asking "So you really answer at 2am?": "No coffee breaks
  on my side, so that one's easy." True, and light.
- **Doesn't fit** a caller worried patients will mind an AI. That needs the
  real answer: the AI line first, a person whenever asked. Humour there reads
  as dodging. Rule: never on an objection about AI.
- **Verdict:** good, and the most memorable. It is honest: it denies having a
  life rather than claiming one.

### C. A warm micro-affirmation when they share something good: "Oh, love that."

- **Where:** when the caller shares a win or plans ("we just opened a second
  location"). Once.
- **Fits** the discovery answer "we're opening in Round Rock next month".
- **Doesn't fit** most turns. The risk is drift into a filler opener, the
  exact thing 6c removes.
- **Verdict:** weak. It overlaps with the mood rule's "Oh nice!" (VOICE-T16b)
  and is the most likely to become a tic.

### D. A signature sign-off: "Talk soon, and happy booking!"

- **Where:** the last line of a demo call that ends warmly. Not after a firm
  no, and not after a call back failed.
- **Fits** the close in `callback-taken`, after "someone will call you", and
  the warm close in `disinterest-then-contact-ask`.
- **Doesn't fit** `firm-no-goodbye`. A cheerful sign-off to "leave me alone"
  grates.
- **Verdict:** good. Every call that ends well ends the same recognisable
  way, and it is the easiest to keep to once (it is the end).

## Recommendation

Choose **A and D**: a signature bridge in the pitch, and a signature sign-off.
Add **B** as a third only if, after the next test call, she still sounds
generic. Leave out **C**: it fights the 6c rule against habitual openers.

On a clinic's calls, D would read "Talk soon!", since clinic calls carry no
pitch. Any use there is the owner's separate call: those callers are
patients, and the clinic chose its greeting.

## What building it takes, once chosen

- A `QUIRKS` list in `lib/voice/demo-facts.ts`, each with its line, where it
  may go and where never.
- The chosen ones added to the stage notes with "once per call".
- Her state's `"quirk"` field, and the progress keeping which have been said.
- A regression case per quirk: said once, never twice, never after a firm no
  or a stall.

About half a day, with the tests.

## Decision for the owner

Which quirks, if any? Recommended: A and D now, B on trial.
