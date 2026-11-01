# Sounds alike: a test call of 1 November 2026, and everything around it

Task DEMO-SOUND-1. The owner, 1 November 2026, with the transcript of his
test call to the Miami Skin & Vein demo (after a44374c9 was fixed): "Aya is
not understanding relatively close pronunciations of the same subject meaning
that she gets stuck in pronunciation loops. She should be able to understand
that when she's already mentioned a subject and the caller replies with
something that sounds closely similar to that subject, she should just
continue on that topic", then an audit for every shortcoming (rated 3/10),
then "go ahead with all of it".

## What changed

| # | On the call | Why | Now |
|---|---|---|---|
| 1 | "this port" (Dysport) five times, "Ristalin" (Restylane), "barking" (parking), "the bottle" (Botox), "doctor Sean" (Dr. Shaun Patel): each questioned or refused | Nothing compared what was heard with what the call knows; the demo note said "ask them to say it again" | `lib/voice/sound-alike.ts`, every call: each word and pair of words is compared by its sound (`soundKey`: "this port" and "Dysport" are both "tsprt") with the menu, the providers, a front desk's topics and, above all, what she said in the last four turns and the treatment being booked. A match becomes the turn's note ("They said 'this port': that is Dysport... never question the word"); two as close, one either-or question. A provider's name only for a word said as a name ("the bottle" sounds like "Patel"); "doctor Sean" matched to the providers outright. The demo's unknown-doctor check uses it too. The prompt's and the demo note's "ask them to say it again" are gone |
| 2 | "You're all set, Alright!": "Alright." taken for the name she asked for two turns before, "Is Miami Skin and Veil full of clients?" for the number | The demo kept her last question until she asked another, and took any short answer for a name, any words for a number | A name must look like one (`looksLikeName`), a number must be one or "the one I'm calling from" (`looksLikeNumber`); her open question is the one in her latest reply, or none |
| 3 | "Do I have to pay a deposit?" refused five times as an off-menu price | The demo's made-up $50 deposit is a rule, and the guard allowed only menu prices | Amounts in the practice's own rules and answers are the practice's to say (`amountsInRules`, `quotedAmountsUsd`, demo) |
| 4 | The same refusal three times | Nothing stopped a line said twice | A demo never says a line twice: an answer asked again is "Like I mentioned, ..." shorter; a refusal, in words not said yet, keeping the provider |
| 5 | "Evening", "I don't want early morning" got the same three morning-heavy times three times | The demo's note listed three fixed times, and code read neither ask, nor "this week?" | No list in her note; code answers "this week", a part of the day and "not mornings" with two times that fit, never one offered before (`partOfDayWindow`, `WEEK_ASK`) |
| 6 | "Botox is our most popular injectable" | The prompt's rule only | Every call: a popularity claim is taken out (`POPULARITY`, `shapeVoiceReply`) |
| 7 | Six prices in one reply | The prompt's rule only | Every call: a sentence with more than two prices keeps the names and loses the prices |
| 8 | "BOTOX" (said letter by letter, as "AYA" was); "6705 Red Rd, ..., FL 33143"; "(786) 618-5039" | Text written for a page | Every call (`forVoice`): a word in capitals said as a word unless it is an acronym (IPL, PRP...); an address with "Road", "Avenue", "Suite" in full and no state and zip; a phone number in spoken groups |
| 9 | "Hi there!", a silence, "Still with me?" | A reply to a bare greeting could end without a question | Every call: a reply to "hi" ends "How can I help you today?" (`withGreetingQuestion`) |
| 10 | "Before" got "Before what?"; "Besides Botox," got "I think I lost you there" | A paused sentence was answered | Every call: a fragment (a few words ending on a joining word or a comma, no full stop) gets "Mm-hmm?", then "Take your time." (`isFragment`); no model call |
| 11 | "Is it full of clients?": "Not at all, we have openings", then "we never double-book" | No line, and a guess about how the practice runs | Every call: "I can usually find you a time that works. Want me to take a look?" (`busyLine`); the demo note: never say how the practice runs (parking, double-booking, how busy) unless written |
| 12 | A franchise: "I'll pass your details... they'll get back to you within a day" | A promise nothing keeps | Every call (owner's choice): "For business inquiries, please call our office on ..." (`businessLine`; a demo reads the practice's published number, a clinic its own) |
| 13 | "You told me about Botox before... say besides Botox" got Botox again | Nothing kept what she had told them | The demo keeps the menu items she has named; "besides", "the other ones", "don't repeat" bring a note to leave them out |
| 14 | "Why are you repeating?" not read as frustration | Not in the words | Added |

The demo engine agent's transcription keywords gain parking, deposit,
Sculptra, PicoWay, insurance, financing and cancellation
(`apps/web/scripts/retell-demo-engine-agent.ts`); they reach Retell only when
the owner runs that script.

## Line by line

`apps/app/tests/voice-demo-sound-alike.test.ts` replays the call (the turns
that show something; the model scripted with what it wrote on the call, or,
where a fixed line replaced it, what it most plausibly wrote). What the model
answers to the new notes (turns 12, 16, 18, 19, 23) only a real call shows;
the test checks the notes it is given. Run with `SOUND_ALIKE_TABLE=<file>`
to write this table again.

| # | Caller | Heard on the call | Now |
|---|---|---|---|
| 1 | Hi. | Hi there! / Still with me? | Hi there! How can I help you today? |
| 2 | Tell me about your treatments. Please. | Here's what we offer. Our main groups are injectables like BOTOX, Dysport, Daxxify and fillers such as Restylane and Sculptra. ... | Our main groups are injectables like Botox, Dysport, Daxxify and fillers such as Restylane and Sculptra. Which area are you most interested in? |
| 3 | much is Botox? | Botox is from $18 per unit. The total depends on the areas you want treated, which Dr. Shaun Patel works out with you at a consultation. Want me to request one? | Botox is from $18 per unit. The total depends on the areas you want treated, which Dr. Shaun Patel works out with you at a consultation. Want me to request one? |
| 4 | this week? | Yes, we have openings this week. I can offer Monday, November 2 at 11 AM, or Monday at 4 PM. Which works better for you? You can also tell me another day. | Let me pull up our calendar... I have Monday, November 2 at 11 AM or 4 PM. Would either of those work? |
| 5 | want evening time. | Evening is a bit tricky with what I have open right now. The times I can offer are Monday, November 2 at 11 AM, Monday at 4 PM, or Tuesday, November 3 at 10 AM. ... | Let me take a look... Ah, Monday, November 2 at 5 PM is already taken, but I can do Tuesday, November 3 at 4 PM or 5 PM. Would either of those work? |
| 6 | that. Why are you repeating? I don't want early morning. | Got it, no early mornings. Evenings aren't open this week, and my calendar only has Monday at 11 AM, Monday at 4 PM, or Tuesday at 10 AM. ... | Let me take a look... I have Monday, November 2 at 12 PM or 1 PM. Would either of those work? |
| 7 | Four PM would work. | Four PM on Monday, November 2 works. What's your first name? | Four PM on Monday, November 2 works. What's your first name? |
| 8 | You do I have to pay deposit? | Good question. I don't have a price for that one, but Dr. Shaun Patel can go through it with you at a consultation. Want me to request one? | Yes, a $50 deposit holds each appointment, and it comes off the treatment price. |
| 9 | Do you do I have to pay deposit or something? | Okay, let me try that again. I don't have a price for that one, but Dr. Shaun Patel can go through it with you at a consultation. Want me to request one? | Like I mentioned, yes, a $50 deposit holds each appointment, and it comes off the treatment price. |
| 10 | have to pay a deposit for the bottle? | Oh, I wish I could help with that one. I don't have a price for that one, ... | Yes, the $50 deposit holds your Botox appointment too, and it comes off the price. |
| 11 | Okay. Yeah. I request one, but I wanna know how I can reach Miami Skin and Vein. | Address: 6705 Red Rd, Suite 608, Coral Gables, FL 33143. Our number is (786) 618-5039 if you ever need to call us directly. ... | We're at 6705 Red Road, Suite 608, Coral Gables, and our number is seven eight six — six one eight — five oh three nine. |
| 12 | you have barking? | Barking? No, there's no barking on my end, so the sound is probably coming from your side. ... | I'd have to check that with the team. |
| 13 | Alright. | Sounds good! Before I put that in, what's the best phone number to reach you? | Sounds good! |
| 14 | Is it is it a full is Miami Skin and Veil full of clients? | Full? Not at all, we have openings this week. You're all set, Alright! Your Botox with Dr. Shaun Patel is booked for Monday, November 2 at 4 PM. ... | I can usually find you a time that works. Want me to take a look? |
| 15 | told me about Botox before, so you shouldn't repeat yourself. Just say besides Botox, this, this, this. | Got it, no more Botox. Besides Botox, we do Dysport and Daxxify, plus fillers like Restylane and Sculptra. For lasers, we have | Got it. Besides Botox, we do Dysport and Daxxify, plus fillers like Restylane and Sculptra. |
| 16 | Teach me about Ristalin. What is Ristalin? | Ristalin isn't something we offer at Miami Skin & Vein, ... | Restylane is a filler that adds volume, for lips and cheeks. It's from $950. |
| 17 | I want the other ones. | Sure, let's look at the rest of the menu. Our other injectables are Dysport from $6 per unit, Daxxify from $14 per unit, and Restylane fillers from $950 per syringe, with Sculptra from $1000 per vial. For skin, we have Hydrafacial from $300, chemical peels from $300, and microneedling for $900. Which one should I tell you more about? | Sure, let's look at the rest of the menu. Our other injectables are Dysport, Daxxify, and Restylane fillers, with Sculptra. For skin, we have Hydrafacial, chemical peels, and microneedling. Which one should I tell you more about? |
| 18 | Teach me about this port. | I can't tell you about "this port" because I don't know what that refers to. ... | Dysport is an injectable that relaxes lines, like Botox. |
| 19 | This four. | I'm not quite sure what you mean by "this four." ... | Dysport softens frown lines and crow's feet. |
| 20 | Besides Botox, | I think I lost you there. Is it Dysport you're thinking of, or one of the other injectables like Daxxify? | Mm-hmm? |
| 21 | is it | Are you asking about the Botox deposit, or about the Dysport and Daxxify pricing we just went over? ... | Take your time. |
| 22 | I want to offer champagne an opportunity to open a franchise with Miami Skin and Vein. | I can't help with a franchise, but I can take a message for our team to follow up on that. ... | For business inquiries, please call our office on seven eight six — six one eight — five oh three nine. Anything else I can help with? |
| 23 | No. I just told you. I want to know I want an opportunity to discuss with the doctor Sean | I'm not with Dr. Sean. Our physician is Dr. Shaun Patel, ... | Of course. Dr. Shaun Patel sees patients at consultations; for business, our office is the best place to start. |

## Not done, for the owner

- "Free parking" may have been made up: it depends on whether the clinic's
  site says so, and the stored profile is not readable from here. The note now
  forbids saying it unless written; only a real call shows whether she keeps to it.
- Whether Retell accepts an empty answer, to wait silently on a fragment
  instead of "Mm-hmm?", is not checked.
