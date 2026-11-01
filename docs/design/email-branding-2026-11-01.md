# Every email in healdesk's look (EMAIL-BRAND-1, 1 November 2026)

The owner, showing the plain sign-in email: "brand this email, like all emails
sent from healdesk to users with healdesk's branding. it must be apple like but
with healdesk branding".

## What it looks like

The model is the owner's own Apple-like email, the demo-ready email of
30 October 2026 (`apps/web/src/lib/email/demo-ready.ts`, unchanged): the
healdesk logo centred at the top, Apple's greys (#1D1D1F ink, #6E6E73 grey,
#D2D2D7 hairlines, #F5F5F7 boxes), the system's San Francisco type, a black
pill button, a quiet footer under a hairline, white in light mode and black in
dark. Every other email now wears the same shell:

- `packages/catalog/src/email-brand.ts`: the shell itself (logo, title, body,
  footer, the pill button, dark mode, Outlook's fallbacks). One place, used by
  both apps.
- `apps/app` notices (`lib/email/templates/compose.ts`, every template): the
  subject is the large title under the logo (HTML only; the text part is
  unchanged, and a text-only reader sees the subject first anyway), except an
  ops alert, which opens with its own tagged headline, and a support reply,
  which reads as a letter. An email's first action is the filled pill; any
  later one is outlined, so the next step stands out. Label and value pairs
  are set as Apple sets a receipt's details: the label small and grey over
  its value, between hairlines.
- The transcript email (`lib/conversations/transcript-email.ts`, SES) and the
  agreement copy (`packages/catalog/src/agreement-copy-email.ts`, both apps):
  the same shell, the subject as the title.
- `apps/web`'s text emails (`htmlTwinOfText`): the same shell, with no title,
  since they are letters and their HTML may say only what the text says.

Not changed: the plain-text part of every email, every word, subject and
preheader; the demo-ready email (already the owner's design); and the two
phase-two emails fenced out of v1 (the monthly report, the connect link).

## The one thing fetched

Annex X1.8 of the funnel plan said "no images, no remote content". The logo
replaces that for one image: `https://healdesk.io/brand/healdesk-logo-email.png`
(352x64, shown at 176x32), the file the demo-ready email has used since
30 October. It is the same public URL in every email, on the marketing site,
which is always on (apps/app's host is not, in standby), so fetching it says
nothing about the reader, the clinic or the message: no query, no id, no
per-send name. That is what made a remote image a read receipt, and it is not
true of this one. Fonts are still the system's own. A client that blocks
remote images shows "healdesk" in the logo's red in its place.

The link scanner in `apps/app` (`lib/email/lint.ts` `findLinks`) passes over
that exact URL, an image and not a link, so a support reply's one-link rule
and every other link check are unchanged. `apps/web/src/lib/email/brand-logo.test.ts`
pins the file (a PNG at twice the shown size), because renaming or deleting it
would break the logo in every email already in an inbox.

## Checked

Rendered in Chromium (light, dark, phone width) for the sign-in link, welcome,
daily summary, an ops alert, a support reply, the transcript, the agreement
copy and an apps/web setup link. Not yet checked in real inboxes (Gmail,
Apple Mail, Outlook): that needs a send from the live host.
