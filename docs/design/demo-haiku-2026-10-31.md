# Demo call on Haiku: what changed, and the proposal for the rest

Task DEMO-HAIKU-1. Owner, 31 October 2026: implement (1) a short demo-only
prompt outside the role-play, (2) only the current step's instructions, with
a pitch on any buying signal, (3) a small set of real-model test calls scored
on every change; then "propose the utmost fix so that haiku will work on this
smoothly", staying on Haiku, with one Aya (healdesk's sales voice who plays
the clinic's front desk in a role-play), simpler, and without losing what
makes her sound human.

The numbers refer to the 20 items of the 31 October review.

## 1. Built in this change (code and tests, not yet run on a real model)

| | Before | Now |
|---|---|---|
| Prompt outside the role-play | The clinic's front-desk prompt (about 2,500 words, "You are the AI assistant answering the phone for...") | healdesk's own prompt, `demoSalesPrompt` (about 2,100 words), one identity, cached |
| Note per turn | 1,500 to 2,550 words, every rule every turn | 250 to 300 words: what they said, the one next step, the repairs that apply; about 560 when selling (it carries the price list) |
| In the role-play | Front-desk prompt plus a note that also carried sales rules | Front-desk prompt (what she plays) plus a short role-play note that frames her as healdesk's Aya playing it |
| Contradictions (4) | The model guessed | One order of precedence, written once: rules, then the note, then what they said, then style |
| Buying signal (9 to 11) | Close and discount only after four discovery questions | Price, how to start, what's next, the competition, "how would you improve", keenness: heard in code or declared by her, opens value, prices, discount and close at any step, and moves the intro on |
| The nine pitch points (10) | Fixed order, one a turn | A menu; she picks the unsaid one that best fits what they just said; a buyer reaches the close after three |
| Regrowth (5) | Nothing stopped it | Tests bound the prompt and note sizes: growing them is a deliberate change |
| Quality before and after (19, 20) | Learned on the owner's test calls | `npm run voice-eval:demo`: eight simulated owners call the real demo pipeline on the real model; checks plus an Opus judge; base against head on every pull request (`.github/workflows/demo-eval.yml`) |

Everything human in her voice was kept, said once instead of every turn: the
mood word, one short reaction then one sentence, no restating, "say that
again?", mirroring, contractions, no filler, the name at most twice, the
signature touches, "we" for healdesk, the role-play opener and exit said by
the call.

After launch (owner, 31 October 2026; plan task `DEMO-EVAL-LIVE`, not a
go-live blocker): add `VOICE_EVAL_ANTHROPIC_API_KEY` (the eval's own key,
never the HIPAA organisation's) as an Actions secret, and optionally
`VOICE_EVAL_DEMO_BUDGET_USD` as a repository variable (5 when unset; one run
is estimated at about $1.60 with the 14 personas and the listener, so a pull request, base and head, about $3.30, under the default budget).
Until then the workflow says it skipped, and demo changes before launch rest
on the scripted regression cases and the owner's test calls. The first live
run is the baseline; nothing here has been measured on a real model yet. The
steps in section 2 that say "must beat the eval's baseline" are measured that
way once it runs; before then, by the scripted cases and a test call.

## 2. Proposal: what would make Haiku smooth

The pattern behind most of the 20 items: we ask one small, fast model, on one
pass with thinking off, to do three jobs at once: understand what the owner
meant, decide what to do next, and say it like a person. Haiku is good at the
third, fair at the first, and weak at the second when the rules are long. The
fix is to give each job to the thing that does it best, and to measure every
change on the eval before it reaches a call.

Ordered by value for effort. Each step is its own pull request, and each must
beat the eval's baseline (the workflow fails on a drop past the noise).

### Step 1. A listener: understanding by a model, not by phrase lists (items 6, 7, 8)

Today what the owner meant is read by fixed phrase lists (`ANNOYED`,
`ROLE_SAID`, `DELEGATED`, `CALLED_OUT`, the buying patterns) and by her own
hidden note of which question she asked. Both miss: other wordings, misheard
words ("clothes" for calls), and replies where she forgets her note.

Proposal: a second Haiku call per turn, the listener, with a tiny prompt
(about 200 words) and a strict JSON schema (the API's structured outputs, so
the shape is guaranteed). It reads only the last few lines and fills slots:
their name, role, what they are after, calls a day, what happens to missed
calls, how they want help; and signals: buying, annoyed, confused, "you
already asked", impatient, wants the role-play, speaking as themselves in a
role-play, wants to leave; plus the likely meaning of a misheard word.

- Runs at the same time as the speaking model, so it adds no wait. Its slots
  shape the next turn's note; the speaking model still sees the whole
  conversation, so it answers this turn from what was said.
- Slots, not "the answer to the last question": an answer counts wherever it
  is said, and nothing is filed under the wrong question.
- The phrase lists stay only as an instant fallback when the listener is late
  or fails.
- The speaking model's JSON shrinks to what only it knows (`end`, `roleplay`,
  `beats`), so a forgotten field matters less.

Cost: one more small Haiku call a turn, about a tenth of a cent. Risk: the
listener can be wrong too, but it is a narrow, schema-bound task, and the
eval measures it.

### Step 2. Show her, don't tell her: examples instead of rules (items 3, 5, 12, 13)

A small model copies examples far better than it follows abstract rules. The
style section is still about 40 rules. Replace half of them with six to eight
short exemplary exchanges from the best calls and from the owner's own
wording: a buyer who asks the price first, the competition question with one
confident point, a warm recovery after "you already asked", a role-play
handover, a close. Each example is two or three lines. Keep the hard rules
(claims, prices, HIPAA wording) as rules.

Every new failure becomes an eval scenario first, and a fix is an example or a
consolidated rule, never another special case in the note. The size bounds in
the tests keep that honest.

### Step 3. One sales conversation, interleaved (items 9, 10, 13)

Merge "discovery" and "pitch" into one conversation where code picks the next
move from the slots: a question only when the next point needs the answer,
and at most two questions before the first value point (question, value,
question, value), the way good salespeople talk. A buying signal still jumps
to value and the close. After a misstep the next move comes from the slots,
so there is always a way back to the sales thread.

### Step 4. A role-play that ends when the caller is done, and can book (items 14, 15, 16)

- End the role-play when the listener says the caller speaks as themselves
  again, or when the booking request is taken and the patient says goodbye,
  never on a turn count; the count stays only as a ceiling.
- Give the role-play a demo calendar: two or three plausible free times made
  from the clinic's published hours, the same through the call, so she can
  offer real times the way a front desk does. It is a role-play, so nothing
  is booked; the note says so, and the guard's rule against claiming a
  booking still holds.
- Switch roles on the listener's signal as well as hers and the scripted
  lines, so one missed signal no longer leaves her in the wrong role.
- During the role-play, show her only the role-play's own turns. PR 77 did
  this and was reverted with the rest of its voice change; it should come
  back only with the eval showing it helps.

### Step 5. Fewer cuts and stock lines (items 17, 18)

- Track what the shaper removes in the eval ("words cut per reply"); prevent
  the cause with an example rather than cutting after the fact.
- When the guard refuses, the second try already gets the reason; when that
  fails too, choose from a larger, rotating set of recovery lines tied to the
  next step, and never the same one twice in a call. The eval counts stock
  lines per call.

### Step 6. Keep the loop honest (items 19, 20)

- Grow the eval from real transcripts: each bad call becomes a persona
  (`scripts/voice-eval/demo/scenarios.ts`), not a phrase list.
- Keep the scripted regression cases for what code decides (stages, prices,
  the call-back), and the eval for how she sounds.
- Make the demo eval a required check once its baseline is stable (owner, in
  GitHub branch protection).

## 2b. Status of the six steps (owner, 31 October 2026: "Let's implement these all")

Built in DEMO-HAIKU-2, tested with scripted models and the eval's dry run;
none measured on a real model yet (the eval key is post-launch, `DEMO-EVAL-LIVE`).

| Step | Built | Where |
|---|---|---|
| 1. Listener | A second Haiku call beside each demo turn, strict JSON schema, 4-second limit; fills what the owner said and keeps buying, impatience, "wants the role-play" and "stepped out"; an answer it heard is never overwritten. The phrase lists stay as the instant read and fallback | `lib/voice/demo-listener.ts`, `retell.ts` `listen`, `responder.ts` `json` |
| 2. Examples | Nine short exchanges in the sales prompt, several style rules removed | `demo-facts.ts` `demoExamples` |
| 3. Interleaved | At most two questions before a value point, then alternate | `asksSinceValue`, `INTERLEAVED` |
| 4. Role-play | Ends on her end signal (a held-back end comes on the next reply), on the listener hearing the owner as themselves, or at a ceiling of eight turns (was a cut at four); a calendar of three free times from the clinic's hours | `rpOut`, `rpEndPending`, `demoSlots` |
| 5. Fewer stock lines | Recovery openers rotate, never the same twice in a call; the eval counts words cut from her replies | `leadsFor`, eval `wordsCut` |
| 6. Loop | Each test call the cases cite (six) is an eval persona, held by a test; 14 personas in all. The required check stays the owner's, after launch | `scripts/voice-eval/demo/scenarios.ts` |

## 3. What not to do

- Do not add a rule to the note for a single transcript. Add a scenario, then
  an example or a consolidated rule, and let the eval decide.
- Do not move to a bigger model to cover a structural problem. If, after
  steps 1 to 3, the eval still shows the speaking model missing steps, run
  the same eval with `HEALDESK_VOICE_MODEL` set to Sonnet for a side-by-side
  measurement before deciding; the code already supports it.
