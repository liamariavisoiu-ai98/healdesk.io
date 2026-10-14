# The agreement and the purchase, recorded on Vercel (14 October 2026)

**The owner's decision, 14 October 2026:** "The agreement and checkout record can also be
saved on Vercel instead of AWS."

**Why.** The AWS host is getting a standby mode that removes its database and load
balancer until the first clinic pays, and a dispatch that turns it back on when a first
invoice is paid while it is in standby (another session builds both). Until this change,
checkout made three blocking calls to apps/app (sign → `/api/agreements`, Pay →
`/api/checkout/intents`, then `/api/checkout/intents/session`), the PDF download called
`/api/agreements/{id}/pdf`, apps/app emailed the signed copy at signing, and Stripe's
`success_url` was apps/app's `/welcome`. With the host off, nobody could sign or pay. Now a
buyer signs the agreement, pays and lands on an honest page with the host off, and the
clinic is provisioned when the host is back.

Nothing here is PHI. The buyer's records are business contact data (a clinic owner's name,
work email, title, IP address and user agent, the clinic's answers and the read of its
public website), which is why checkout has always sat on apps/web. apps/web still has no
database client: the store is the marketing Google Sheet it already keeps leads in.

## What moved

| Step | Until 14 October | Now |
| --- | --- | --- |
| Sign | apps/web forwarded to apps/app `/api/agreements`, which validated, rendered, wrote `baa_acceptances` and mailed the copy through SES | apps/web `/api/agreement` validates and renders with the catalog's own code, appends a sealed **agreement record** to the Sheet's `agreements` tab, and mails the PDF copy through its Resend sender |
| Download | apps/web `/api/agreement/pdf` asked apps/app to render | rendered on apps/web from the record (same cookie, same limits) |
| Pay | apps/app `/api/checkout/intents` stored the intent; `/api/checkout/intents/session` recorded the Session | apps/web `/api/checkout` checks the agreement record and provisioning's rules, appends a sealed **purchase record** to `checkout_intents`, creates the Session, writes the Session id onto the record |
| Return | Stripe → apps/app `/welcome` | Stripe → apps/web `/welcome`, which checks Stripe, asks apps/app (ops op `welcomeHandoff`) and 303s to apps/app's `/welcome` when it has an answer, else shows a waiting page |
| Provision | the webhook relayed `{ ref, … }`; apps/app provisioned from its own intent row | the webhook reads both records from the Sheet and relays them in the `/api/provision` body; apps/app checks the seals and the re-rendered hash, **imports** both rows, then provisions exactly as before |

Removed from apps/app: `POST /api/agreements`, `POST /api/agreements/[id]/pdf`,
`POST /api/checkout/intents`, `POST /api/checkout/intents/session`, and what only they
used (`saveIntent`, `assertInviteOpen`, `recordIntentSession`). `signAgreement` stays: the
operator's demo clinic and the tests sign with it.

Moved into `packages/catalog`, so both sides run one implementation:

- `agreement-signing.ts` (subpath export): `validateSignRequest`, `prepareSigning` and
  everything they call, from apps/app's `lib/agreements.ts`. Phase two's switch is an
  option (`phaseTwoAttribution`), which apps/app fills from its environment and apps/web
  never sets. Added on the way: `signatoryTitle` is capped at 120 characters, like the
  name, and the route caps the request body at 16 KiB.
- `mail-address.ts` (subpath): the "can healdesk send to this address" predicate apps/app's
  mail layer and the signature both ask.
- `agreement-pdf.ts` (subpath; pdf-lib 1.17.1, pinned, is the catalog's one dependency):
  the PDF renderer. apps/app's `lib/agreements/pdf.ts` re-exports it.
- `agreement-copy-email.ts`: the copy email's words and file name.
- `provision-request.ts`, `checkout-intent.ts`, `agreement-match.ts`: provisioning's
  request validation, `validateIntentRequest`, and `agreementMismatch` with the two rules it
  leans on, so apps/web holds a purchase to provisioning's rules before anyone pays.
- `checkout-record.ts` (subpath): the records, the seal and the cells.

## The records

Both are canonical JSON (keys sorted at every level; only JSON values) with an
HMAC-SHA256 over exactly those bytes, keyed by
`HMAC(HEALDESK_PROVISION_SECRET, "healdesk/checkout-record/v1")`. apps/app holds the same
secret and refuses a record whose seal does not match, so an edit made in the Sheet between
signing and provisioning is found, never imported. The record names its own kind (`record`)
and format (`v`) inside the seal, so a purchase cannot pass for an agreement. The seal key is
derived under its own purpose, so a seal is never a request signature.

**The agreement record** (`record: "agreement"`) stores no text. It stores what re-renders
the document exactly (template version, kind, the variables as rendered, the applied
clauses, the effective date) and the document's hash, the assent sentence, the signer,
IP, user agent, accepted-at (Vercel's clock, ms precision), a UUID made at signing,
`displayedHashVerified`, and, once the copy has gone, the copy evidence (sent-at and the
PDF's SHA-256, written once). Every reader renders the text again with the catalog's
`prepareBaa`/`prepareDpa` and refuses the record unless it hashes to the recorded hash, the
same clauses apply, and the signer, day and assent sentence are the document's own
(`checkAgreementRecord`). The renderer is deterministic (apps/app `tests/baa-golden.test.ts`),
which is what makes a text-free record sound.

**The purchase record** (`record: "checkout_intent"`) is one press of Pay: its own id, the
purchase's `ref`, the `attempt`, created-at and expiry (14 days), the purchase exactly as
`validateIntentRequest` takes it (with the nonce hash and the terms tick-box), and the
Checkout Session id once Stripe has answered. While purchases are by invitation the ref is
the setup link's own request id, so two presses on one link are one purchase; otherwise a
new UUID per press, as before.

**Cells.** A Sheet cell holds 50,000 characters and the website read can reach 200 kB. A row
holds the record in up to eight cells (`record_1`…`record_8`) of at most 45,000 characters:
`j<json>` when it fits one cell, else `z<base64 of gzip>`. A record over 262,144 characters
of JSON is refused, never truncated, and everything under that cap fits the row. The
columns before `seal` are an index (copied out of the record, checked against it whenever a
row is read); `provisioned_at` and `withdrawn_at` are apps/web's own state, outside the
seal, which apps/app never reads.

## The flows

**Sign** (`apps/web/src/app/api/agreement/route.ts`). Rate limit (5 an hour per IP), the
16 KiB cap, the setup-link gate binding the email, the calendar answers, then the catalog's
`validateSignRequest` and `prepareSigning`; a displayed hash that is not the server's render
is refused and nothing recorded. The record is appended; a Sheet that will not take it is
a 502 and "nothing was recorded". Then the copy (PDF and words from the catalog, attached
through Resend, idempotency key `agreement-copy:<id>`) within eight seconds, the attempt
left to finish under Next's `after()` and still record its evidence; the download cookie;
the setup request's `signed_at`; one log line with the id, version and hash, never the name
or the address. The 201 has the shape the browser always got.

**Pay** (`apps/web/src/app/api/checkout/route.ts`). After the order's own validation: the
agreement record must exist and open, belong to no account (`provisioned_at`, here or on a
provisioned purchase naming it), be signed by the buying address, and be the document the
purchase describes (`agreementMismatch`). For a setup link, the purchase's earlier records
are read: a provisioned one refuses the link; the latest live press's Session is asked
about with Stripe, and a paid one refuses the press with nothing recorded, an unreachable
Stripe answers 503. The purchase is held to `validateIntentRequest`, the record appended
under the next attempt, the Session created with the idempotency key
`checkout:<ref>:<attempt>` after expiring the previous one (`createCheckout`), and the
Session id written onto the record. A Session the record cannot name is expired and the
press withdrawn; a press that opened no Session is withdrawn too. `success_url` is
`${NEXT_PUBLIC_SITE_URL}/welcome?h=<ref>&cs={CHECKOUT_SESSION_ID}`. The nonce cookie is
set on the parent domain of the site and `HEALDESK_APP_URL`'s host (`healdesk.io`), so
apps/app's `/welcome` still reads it. Stripe still carries no buyer details (design D1).

**Return** (`apps/web/src/app/welcome/route.ts`, a route handler so the hand-off is a
true 303). The Session must be this purchase's and paid, by Stripe's own answer, or the page
is a 404 that names nothing. Then apps/app is asked, over `/api/ops` (an existing signed
path; the load balancer serves only the signed paths on the internal host), whether the
purchase is there and settled (`welcomeHandoff`: ready once provisioned or refused, for this
Session only, with a URL apps/app composes from `BETTER_AUTH_URL`). Ready → 303 there.
Otherwise a plain page: payment received, the account is being set up, the sign-in link
will be emailed to the address used at checkout (masked, and only to the browser holding
the purchase's nonce), refreshing every 15 seconds for 10 minutes, then saying the link will
come by email, which it will: apps/app sends the welcome email once it has made the account.

**Provision** (`apps/web/src/app/api/webhooks/stripe/route.ts` →
`apps/app/src/app/api/provision/route.ts`, `lib/checkout/import.ts`). The webhook reads the
record of the press that was paid (the subscription's `attempt`) and the agreement it names,
and relays both exactly as the Sheet holds them, opened or not: apps/app is the judge. A
Sheet it cannot read is a 500, so Stripe redelivers. apps/app opens the purchase record
(a seal that fails reaches ops only), imports the intent row (same ref, attempt, nonce,
Session, created-at, expiry), opens and re-renders the agreement record (a failure marks the
purchase failed, tells ops and sends the "order delayed" email once, as any refusal does),
imports `baa_acceptances` with the record's own id and accepted-at (the column-scoped
INSERT grant of drizzle/0066 allows both), the re-rendered text, the variables a signature
taken there would have stored, the `baa_accepted` event with the signing instant in its
metadata, and the copy evidence with its `baa_copy_sent` event; then checks the purchase
against the imported agreement (`checkIntentAgreement`) and provisions as before. Every
insert is `on conflict do nothing` on the record's own key, and an intent already consumed is
not looked at again, so a retried event finds both rows and continues. On success the
webhook marks the purchase and the agreement `provisioned_at` in the Sheet. No migration.

## Guarantees kept

- The agreement is signed, recorded and copied to the signer before anything is charged.
- What the screen showed is what is recorded, byte for byte (the displayed-hash check), and
  the server, never the browser, renders it.
- An edit to either record between signing and provisioning is found (the seal), and an
  agreement whose template no longer renders to its hash is refused.
- The imported acceptance has the signature's own id and instant, and the same variables,
  text and copy evidence a signature taken on apps/app would have had; from import on, the
  database's rules hold it as before (append-only, write-once copy evidence, one-way bind).
- Provisioning is gated on the first paid invoice, idempotent per subscription, and refuses
  a second subscription for a purchase already set up.
- A purchase is held to provisioning's own rules before anyone pays (`validateIntentRequest`
  and `agreementMismatch`, the same functions apps/app runs at the import).
- Stripe carries an opaque ref and the terms of the press, never the buyer.
- Only the paying browser, holding the nonce, is handed the one-time sign-in link, and the
  link is composed by apps/app from its public origin.

## Guarantees lost or weakened

1. **No atomic upsert.** The database kept one intent per setup link with a unique
   `invite_ref` and moved the attempt in one statement. The Sheet has no unique index, no
   transaction and no atomic increment: two presses on one link at the same instant can read
   the same attempt and both append. Stripe's idempotency key gives a same-request pair one
   Session (a pair whose terms differ is refused by Stripe and withdrawn); two presses that
   read different attempts can each make a Session the other did not expire, and both could
   be paid, in which case apps/app refuses the second subscription as a duplicate and tells
   ops, as it always did. The sequential case (Pay pressed again after cancelling at Stripe)
   is covered as before. Written beside the code in `api/checkout/route.ts`.
2. **The record is not append-only until it is imported.** Before payment the signature lives
   in a spreadsheet anyone with Editor access can edit or delete. The seal finds an edit; it
   cannot stop a deletion. A deleted agreement record cannot be provisioned (ops finishes the
   paid order by hand), and a signed-but-unpaid signature that is deleted is gone, except for
   the PDF in the signer's inbox. Treat the `agreements` tab as a legal record: no hand edits,
   no row deletions, no sorting. Its retention (the database computed `retention_eligible_at`)
   is not implemented for the Sheet.
3. **Unpaid signatures are not in the database.** They used to be rows the operator console
   listed (agreement search, `unboundAgreements()`). They are in the Sheet's `agreements`
   tab now, visible through `/admin/crm`, as JSON; only paid ones reach apps/app.
4. **The security events are written at import.** `baa_accepted` and `baa_copy_sent` have
   `occurred_at` = the import, with the signing and sending instants in their metadata (as
   epoch milliseconds, because the audit guard reads a written-out date as a phone number).
   `accepted_at` and `copy_sent_at` themselves are Vercel's clock, not Postgres's.
5. **The copy goes through Resend, not SES with TLS required.** apps/app's copy went through
   the report transport with `TlsPolicy: REQUIRE`, on the argument that the attached document
   promises not to use a channel that cannot negotiate encryption. The brief chose apps/web's
   Resend sender. The document is not PHI, so Resend may carry it, but the root
   `.env.example` records that Resend has no equivalent of SES's TLS enforcement: if the
   owner wants the old guarantee back, the signer's copy has to move to SES again once the
   host is up. The operator's resend still goes through SES.
6. **Validation after payment can still refuse.** apps/app checks the imported purchase
   again; apps/web runs the same catalog code first, so a refusal now needs the two apps to be
   on different catalogs. **Deploy order for an agreement release:** apps/app first (its
   catalog must know a version before apps/web signs under it), then apps/web. A signature
   apps/app cannot re-render is a paid order refused as `unknown_version`.
7. **The Sheet is on the critical path.** Without `MARKETING_SHEET_ID`,
   `GOOGLE_SERVICE_ACCOUNT_JSON` and `HEALDESK_PROVISION_SECRET` on apps/web, signing and
   checkout answer 503; a Sheets outage is a 502 at signing and Pay, and a 500 (redelivered)
   at the webhook. Each press of Pay costs a handful of Sheets calls against a quota of about
   sixty a minute; fine for the volumes expected, not for a flash sale.
8. **The nonce cookie lasts 30 minutes** (`WELCOME_NONCE_TTL_SECONDS`). If the host takes
   longer than that to wake and provision, the paying browser reaches apps/app's `/welcome`
   without it and is told nothing; the welcome email carries the sign-in link regardless.
9. **The webhook relays a larger body** (the purchase record carries the website read).
   `/api/provision` reads the whole body; nothing in front of it caps it today.
10. **Rotating `HEALDESK_PROVISION_SECRET` breaks every record not yet provisioned.** It
    seals the records as well as signing the calls, and apps/app opens a record only with
    the secret it was sealed with. Rotate only when no purchase is waiting on its first
    invoice (or re-seal the waiting records under the new secret first).
11. **`infra/aws` still lists the removed paths** in `signed_paths` (`/api/agreements`,
    `/api/agreements/*/pdf`, `/api/checkout/intents`, `/api/checkout/intents/session`), and
    its README names them. They now answer 404 from the app; whoever owns `infra/aws` should
    drop them. This change did not touch `infra/aws` or `.github`.

## Tests

- `packages/catalog/src/checkout-record.test.ts`: the seal (edit, forged seal, other secret,
  kind swap refused), canonical JSON, cells (a 200 kB read round-trips across cells ≤ 45,000
  characters; above the cap refused; everything under it fits), the agreement record renders
  back to its hash and refuses one that does not, the purchase record held to
  `validateIntentRequest`. `agreement-signing.test.ts`: the title cap, phase two's option,
  the shared address predicate.
- apps/web: `/api/agreement` (records sealed, never calls apps/app, the copy with its
  attachment and its evidence, refusals by field, body cap, a Sheet outage), `/api/agreement/pdf`
  (from the record; missing 404; edited 409), `/api/checkout` (`paid.test.ts`: the agreement
  checks, success URL on apps/web, previous Session expired, a paid one refusing the press, an
  unrecordable Session expired and withdrawn; `route.test.ts`: the order's rules, through the
  relayed purchase record), `/welcome` (unpaid 404, host unreachable waiting page, ready 303),
  the webhook (both records relayed as held, spent on success, a Sheet outage retried).
- apps/app: `tests/checkout-purchase.test.ts` (the import: id and time kept, re-rendered text,
  events, copy evidence, idempotent retry, seal and hash mismatches refused; then the whole
  lifecycle through `/api/provision`, `welcomeHandoff` and `/welcome`),
  `checkout-intent-answers.test.ts` and `setup-wizard.test.ts` through the import.
