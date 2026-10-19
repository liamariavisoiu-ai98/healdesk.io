# The web chat backend and the Retell voice endpoint — 13 October 2026

**Built on the owner's request of 13 October 2026**: the voice endpoint and the web chat backend,
each emailing the conversation's transcript to the clinic when it ends
(`docs/design/transcript-email-2026-10-13.md`). Both are in `apps/app`, inside the PHI boundary.
They share one brain; the Meta channels keep their own narrower front door
(`lib/meta/front-door.ts`), because Meta signs no BAA and those channels carry nothing clinical.

## The shared brain: `apps/app/src/lib/assistant/`

| File | What it does |
| --- | --- |
| `facts.ts` | What the assistant may know about a clinic: name, numbers, address, weekly hours, the approved script's services and prices, policies, the clinic's own answers, the never-say list (the clinic's plus the built-in defaults), the booking requirement set, the greetings |
| `prompt.ts` | A fixed system prompt around those facts. The clinic edits the facts, never the rules |
| `turn.ts` | One turn: card numbers cut from the person's words; complication and urgent-symptom messages answered with a fixed line (911, then the clinic's urgent-help number) before the model sees them; the model's answer read as JSON and never trusted; the guard; a fixed failure line when the model is missing or fails |
| `guard.ts` | After the model: the never-say list, any dollar amount that is not a configured price or deposit (an off-menu price becomes the offer of a consultation), any ask for card or bank details, any "HIPAA compliant" claim. A refused reply is replaced by a fixed line |
| `responder.ts` | Anthropic's API under healdesk's key, no tools. `HEALDESK_CHAT_MODEL` (default `claude-opus-5-5`, 30 s) and `HEALDESK_VOICE_MODEL` (default `claude-sonnet-5-5`, 8 s, no retry) |

The assistant books nothing. It collects what the practice's requirement set asks for and takes
**one request for the desk**; the booking engine (`lib/booking/engine.ts`) is there, and no
channel calls it. Direct booking waits for counsel and the owner
(`HEALDESK_DIRECT_BOOKING_ENABLED`, which Terraform refuses to set).

## The web chat: `lib/chat/web-chat.ts`, `app/api/widget/v1/[slug]/{start,message,end}`

- **Start**: the widget names the clinic by its public slug (`app_web_chat_clinic`, drizzle/0071). The
  answer gate decides; a refusal answers `contact_form`, which is what the widget shows instead
  (CLAUDE.md, "Failure"). Otherwise the opening line, the locked AI line and the chat greeting, and a
  signed token. Nothing is stored yet.
- **Message**: the first message creates the conversation (`conversations`, channel `web_chat`, its
  `disclosure_played_at` the moment the opening line was shown) and counts it once
  (`chat_conversations`, idempotent on the conversation). The chat's state, its turns and what it has
  collected, lives sealed in its transcript row (`transcript_emails`, status `open`) and is rewritten at
  each message; the browser holds only the token, an HMAC-signed note of the clinic, the conversation
  and the session, with nothing the visitor wrote.
- **Request**: once a first name, a number and a time are collected, one booking request (channel
  `web_chat`, drizzle/0071) and the desk's usual link email, which carries nothing about the person.
- **End**: the visitor ends it (`/end`, which a widget can send with `navigator.sendBeacon`), or thirty
  quiet minutes pass; the outbox sends the transcript, and its sealed copy is deleted once SES
  reports it delivered (at the latest 30 days after the chat began; 14 October 2026). A tab closed mid-chat
  loses nothing: the row is already there. A message after the end starts a new conversation.
- **CORS**: answered only for the clinic's own website (`clinics.website`: its host, `www.`, its
  subdomains, https; `localhost` over http), or any origin for a clinic with no website on file. No
  cookie and no ambient credential, so CORS decides which pages may call it, not who may read.
- **Limits**: 8 KB a request, 2,000 characters a message, 20 requests a minute per address and
  clinic in each process, 120 turns a conversation, a token 12 hours.

## The bubble: `src/widget/v1.js`, `app/widget/v1.js/route.ts`

The script the pasted line loads, served byte for byte from `apps/app`, cached five minutes and
revalidated by its ETag, the same for every clinic and holding nothing of anyone's. It draws a launcher
in a closed shadow root, builds its DOM without markup parsing, and needs no inline style or eval, so it
runs under a strict CSP and Trusted Types once the page allows the script and connections to its origin.

- **Start** is asked when the visitor first opens the bubble, not on every page view. The opening line is
  shown first; a start with no opening line opens no chat.
- **Requests** are `text/plain`, CORS-simple, so no preflight: the routes check the Origin themselves and
  read the body as JSON whatever its type. No cookie, no storage: the token and the words live in the
  page's memory only.
- **The engine's own ends**: it closes a chat after thirty quiet minutes or 120 turns and would open
  the next one silently, so the bubble opens a new chat itself after 29 quiet minutes or 59 answers. A
  chat the quiet time closes between the bubble's check and the engine's write still opens without a
  new line on screen.
- **End**: the visitor's End chat button, or a keepalive request on `pagehide` (not for a page kept for
  Back), once a message has been sent and no reply is pending. The next message after any end asks for a
  new chat first, so every conversation's opening line is on screen.
- **Not answering** (any `contact_form` reply, two failures in a row to reach us, or an answer the
  browser hides because the page is not the clinic's site): the contact form when it takes messages,
  otherwise a line saying to call the practice. The engine does not send the practice's number, so the
  line points to the number on the clinic's own website; returning `publishedPhoneE164` in the contact
  form offer would let the bubble show it. A start that failed is asked again when the bubble reopens.
- **Known limits.** The bubble runs in the clinic's page, so a script there that wraps `fetch` (a
  session-replay or tag-manager script) can see what a visitor types; only a frame served from
  `apps/app` would hide it, and the engine's origin check would have to allow for that. The script is
  served only by `apps/app`: while the host is in standby or down, a visitor whose browser cached it in
  the last day sees a bubble that says to call the practice, and anyone else sees no bubble, only the
  clinic's own page and number. A message whose reply never came (ninety seconds' wait) or was lost can be
  sent again, and the engine may then record it twice. Going live waits for an operator, who is asked only
  once someone opens the bubble from the clinic's site (`LAUNCH_PROMISES`, `web-chat-on-paste`).

## The voice endpoint: `src/voice/server.ts`, `lib/voice/retell.ts`

Its own long-lived Node process from the same image (`node --import tsx src/voice/server.ts`,
`npm run voice` locally), on port 3001 so the same tls-proxy sidecar fronts it.

- Each clinic's Retell agent uses the custom-LLM URL
  `wss://app.healdesk.io/llm-websocket/<HEALDESK_RETELL_LLM_SECRET>/<clinic id>`; Retell appends the
  call id. The secret is checked in constant time before the upgrade; unset, every call is refused.
- **On connect**: `config` (pings, call details), then the answer gate, then response 0: the locked AI
  line (transcribed, no audio kept) and the clinic's phone greeting. Its time is the call's
  `disclosure_played_at`.
- **Each turn**: the caller's words since the agent last spoke go to the shared brain; the reply is
  sent whole, never streamed, because the guard reads all of it first. A newer request supersedes an
  older one still being answered. A reminder gets a fixed line.
- **Degradation ends at a person**: a gate that refuses the call (paused, capped, suspended, and after
  the Services have ended, the Terms' pass-through), a call whose start fails while the direct line
  can still be read, or a model that fails twice running transfers the caller to the direct line
  (`transfer_number`). With no direct line the assistant takes the caller's details, except once the
  Services have ended or the clinic's agreement no longer covers it (`agreement_insufficient`): then
  nothing may process the caller, and the call is closed with a fixed line. An outbound call is ended
  at once and refused by the ingest as a security event.
- **On hang-up**: the existing post-call ingest (`lib/voice/ingest.ts`), idempotent on the call id,
  records the conversation, turns the request into a booking request for the desk, counts the minutes,
  and now queues the transcript in the same transaction, emailed straight after.
- **Infrastructure**: `enable_voice` in `infra/aws` (off by default; see the runbook).

## Tests

`apps/app/tests/assistant.test.ts` (unit), `web-chat.test.ts` (database), `retell-voice.test.ts`
(database, a real WebSocket on a local port), plus the outbox's own.

## Not built, or to check before the first real call

- **The widget's script** (the bubble a clinic pastes) was built on 19 October 2026:
  `apps/app/src/widget/v1.js`, served at `/widget/v1.js` (see "The bubble" above). The spec's "first load
  flips the channel live" is still not automatic: the first chat opened from the clinic's own site asks an
  operator to look and confirm in Ops, because an Origin header proves nothing.
- **Retell's protocol fields**: `transfer_number` on a response, and the `call_details` event's
  `from_number`, `direction` and `start_timestamp`, are written from Retell's custom-LLM WebSocket
  reference as it was known; check them against the current reference and a test call on the demo
  clinic (the only one the endpoint answers until `voice_real_calls`) before any real call.
- **A call in progress when its task dies** is lost with its words: the session is in memory until the
  hang-up. The load balancer drains a task for up to an hour before ECS stops it, so a deploy does not
  cut calls; a crash does. Retell's own call-ended webhook could backstop it; not built.
- **The per-process rate limit** is per task: with several web tasks the limit is that many times
  higher.
- **Meta-style screening on the web chat**: the web chat may carry clinical words (it is BAA-covered),
  so only urgent content is short-circuited; the general clinical screen is the Meta front door's.
