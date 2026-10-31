# Google OAuth verification: screenshots

> **Not needed for the submission** (31 October 2026): Google's form asks for
> the video and the written reason, not screenshots. These shots are the
> video's storyboard and our own record; 02 and 07 are optional. Status:
> [STATUS.md](./STATUS.md). How to submit: [SUBMISSION.md](./SUBMISSION.md).

Seven screenshots for Google's review of healdesk's Calendar connection, in the
order a practice meets them: the button that starts the sign-in, Google's
consent screen, choosing the calendar, the connected state, the free times
healdesk reads, a booking confirmed into the calendar, and that booking in
Google Calendar.

healdesk asks for exactly five scopes, in this order
(`GOOGLE_SCOPES` in `packages/connectors/src/google/oauth.ts`):

| Scope | What healdesk uses it for |
| --- | --- |
| `openid` | Which Google account was connected (the ID token's subject). |
| `https://www.googleapis.com/auth/userinfo.email` | That account's address, shown to the practice, and whether it is a Workspace account. |
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | The calendars the account owns or manages, so the practice chooses where bookings go. |
| `https://www.googleapis.com/auth/calendar.events.freebusy` | When the chosen calendar is free or busy, to offer only free times. |
| `https://www.googleapis.com/auth/calendar.events.owned` | Adding each confirmed booking to that calendar, and reading back the events healdesk added. |

## The shots

| # | File | What it shows | Scope it demonstrates | Taken |
| --- | --- | --- | --- | --- |
| 01 | `01-connect-button.png` | Clinic portal, Setup step 3 "Your calendar": the "Connecting your Google Calendar" notice, its box (ticked) and the "Sign in with Google" button. | All five: this button sends the practice to Google asking for exactly these scopes, and the notice says what each is for. | Commit efc3b98, 12 October 2026 |
| 02 | `02-consent-screen.png` | Google's consent screen for healdesk. | All five, as Google words them. | **Not yet: the owner takes it (below).** |
| 03 | `03-calendar-picker.png` | After the sign-in: the account's calendars, listed from Google, with "Riverside Aesthetics appointments" chosen as the one the assistant books into. This is the calendar page healdesk emails to the practice's address; in the portal the same choice is Settings → Calendar → Change → "Show my calendars". | `calendar.calendarlist.readonly` (the list). The "Connected as" line comes from `openid` and `userinfo.email`. | Commit efc3b98, 12 October 2026 |
| 04 | `04-connected.png` | Clinic portal, Settings → Calendar: the connected account, its Workspace domain, that bookings go into a calendar other than the main one, and when the connection was last checked. | `openid` and `userinfo.email` (the account and its domain, read from the ID token at sign-in). | Commit efc3b98, 12 October 2026 |
| 05 | `05-free-times.png` | The front desk's page for a booking request from a caller: "Free in your calendar" lists the times the chosen calendar is free within opening hours, around the practice's own appointments, with one time chosen. | `calendar.events.freebusy` | Commit efc3b98, 12 October 2026 |
| 06 | `06-booking-confirmed.png` | The same page once the desk confirmed that time: "Appointment: Thursday, October 15, 2026 at 2:15 PM" and "Added to your calendar." | `calendar.events.owned` (the event added to the chosen calendar). | Commit efc3b98, 12 October 2026 |
| 07 | `07-event-in-google.png` | That booking as an event in Google Calendar's web app. | `calendar.events.owned` (what the event carries, and nothing more). | **Not yet: the owner takes it (below).** |

## How 01 and 03 to 06 were made

From a local run of `apps/app` at commit efc3b98, on 12 October 2026, with a
local database and synthetic data only: a fictional practice, Riverside
Aesthetics; a fictional Google Workspace account, `bookings@example.com`, with
four calendars; a fictional caller, Jordan, on a number reserved for fiction
(+1 212 555 0142). Google was never called. The app's own sign-in, callback
and Calendar code ran unchanged, and every request they made to Google was
answered by the in-memory Google the tests use (`fakeGoogleCalendar` in
`packages/connectors/src/google/fake.ts`), including the consent step. Times
are shown on the practice's clock (America/New_York). Images are 2x, cropped
from a 1280-pixel-wide window.

Shots 02 and 07 are Google's own screens, so they need a person signed in to
healdesk's sandbox Workspace account against healdesk's real OAuth client.
Never put that account's password anywhere but Google's own sign-in page.

## What may and may not show, in every image

- The OAuth client ID (`client_id=…`) and the `redirect_uri` may show.
- Never show the value of `code=`, `state=`, `nonce=` or `code_challenge=`.
  Crop the address bar off, or blur those values.
- Never show the client secret, a refresh or access token, a session cookie,
  a sign-in link or a KMS key ARN, and never take a shot with developer tools
  open.
- Only synthetic people: the sandbox account, a made-up first name, and no real
  person's name, number or email in a calendar or a booking.

## 02: Google's consent screen (owner)

Take it from the deployed app with healdesk's real OAuth client: a local run
has no real client. Use healdesk's demo clinic (the one
`npm run demo-clinic -w @healdesk/app` made), the only clinic healdesk's own
test Google accounts may be connected to.

1. Open a Chrome profile signed in to Google only as the sandbox Workspace
   account, so Google's account chooser offers just that one.
2. In that profile, sign in to the demo clinic's portal and open Setup, step 3
   "Your calendar". If the calendar is already connected, use Settings →
   Calendar → Reconnect instead.
3. Tick the box under "Connecting your Google Calendar" and click "Sign in with
   Google". Choose the sandbox account.
4. If Google first says it hasn't verified the app, click "Advanced", then "Go
   to healdesk (unsafe)". That warning is not the shot.
5. The shot is the next page, where Google lists what healdesk is asking for.
   Take it before you click Continue. It must show:
   - healdesk's name, as the consent screen is configured;
   - the sandbox account's address;
   - every Calendar permission healdesk asks for, each with its checkbox, and
     the sign-in line for the account's address (openid and email).
   If the list does not fit, zoom the page out (Cmd and minus) rather than
   taking two images.
6. Address bar: Google's reviewers look for the client ID, so you may keep the
   address bar and its `client_id=`, but blur the values of `state=`, `nonce=`
   and `code_challenge=`. Or crop the address bar off entirely.
7. Click Continue. The browser comes back through
   `/api/calendar/google/callback?code=…&state=…`: don't screenshot that address.
8. Save the image as `02-consent-screen.png` in this folder.

## 07: the booking in Google Calendar (owner)

1. With the sandbox account connected to the demo clinic, choose the calendar
   bookings go into, as in shot 03.
2. Make one booking into it: confirm a free time on the front desk's page for a
   request at the demo clinic, as in shots 05 and 06, or let the assistant book
   one on a test call to the demo clinic. Give a made-up first name.
3. In the same Chrome profile, open calendar.google.com, go to the booking's
   day or week, and make sure the chosen calendar is ticked under "My
   calendars".
4. Click the event to open its details. The shot must show:
   - the title, the first name and the service, such as "Jordan – Consultation";
   - the date and time;
   - the calendar it is on;
   - healdesk's one-line description: "Added by healdesk after your front desk
     confirmed it." for a desk-confirmed booking, or "Booked by your healdesk
     assistant." for one the assistant made;
   - no guests, and no phone number or email address anywhere in the event.
5. Crop to the calendar and the open event. Leave out the address bar, and any
   other account or calendar holding anything but synthetic events.
6. Save the image as `07-event-in-google.png` in this folder.
