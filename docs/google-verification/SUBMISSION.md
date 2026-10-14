# Google OAuth verification: what to submit

Google reviews the three sensitive Calendar scopes before clinics can connect
without the "unverified app" warning. The review asks for three things: a
written justification for each sensitive scope, a demo video, and an app whose
consent screen, homepage and privacy policy check out. This page has the
justifications ready to paste and the video's shot list. [README.md](./README.md)
has the screenshots and how to take the two that need you.

**The video needs `apps/app` deployed, and since 14 October 2026 it is.** It
must show Google's real consent screen for healdesk's real OAuth client, which
only the deployed app can reach. `https://app.healdesk.io` has answered from AWS
since 14 October, with synthetic data only, so the video can be recorded once the
checklist below holds, starting with the OAuth client's values on the host.

## Before submitting

- [ ] `apps/app` is live at `https://app.healdesk.io` with healdesk's OAuth
      client, and the demo clinic exists (`npm run demo-clinic -w @healdesk/app`).
- [ ] `healdesk.io` is verified in Search Console by a Google account that is an
      Owner or Editor of the Cloud project. The DNS record for it is already in
      place (`google-site-verification=…`).
- [ ] The consent screen (Google Auth Platform → Branding) reads as below. The
      homepage already links to the privacy policy and the terms.
  - app name `healdesk` and its logo;
  - homepage `https://healdesk.io`;
  - privacy policy `https://healdesk.io/privacy` (section 11 covers Google user
    data and carries the Limited Use statement);
  - terms `https://healdesk.io/terms`;
  - authorised domain `healdesk.io`.
- [ ] The client's redirect URI is `https://app.healdesk.io/api/calendar/google/callback`.
- [ ] Data Access lists exactly the five scopes in `GOOGLE_SCOPES`
      (`packages/connectors/src/google/oauth.ts`), no more.
- [ ] The project has no other OAuth client, or the video covers each one.
- [ ] Shots 02 and 07 are taken (README.md).

## Scope justifications

`openid` and `userinfo.email` are not sensitive and need none. Paste one
paragraph per sensitive scope. Each describes what the code on `main` does
(`packages/connectors/src/google/adapter.ts` and `event.ts`).

**`calendar.calendarlist.readonly`**

> healdesk is an AI assistant that answers a clinic's patient calls and messages and books their appointments. When the clinic's administrator connects Google Calendar, or changes calendar later, we list the calendars that account owns or manages, so the administrator can choose which one bookings go into. We request only each calendar's ID, name, time zone and access role. There is no narrower scope that lists calendars.

**`calendar.events.freebusy`**

> We read when the clinic's chosen calendar is free or busy, so healdesk offers patients, and shows the clinic's front desk, only times that are open. This returns busy blocks only, never event titles or details. It is the most limited way to read availability, and we use it instead of reading events.

**`calendar.events.owned`**

> We add each confirmed booking to the calendar the clinic chose: one event with the patient's first name, the service and the time, created when the assistant books or when the clinic's staff confirm a request in healdesk. Events are private, with no guests and no reminders, and no invitations are sent. We read back only events we created, by their ID, to confirm a booking and never write it twice. We never read, change or delete events we did not create.
>
> Narrower scopes do not work. freebusy and the read-only scopes cannot create events. calendar.app.created writes only to a new calendar created by healdesk, which the clinic's staff and booking software do not already check, so the same time could be booked twice. calendar.events.owned is the narrowest scope that writes to the clinic's existing calendar. We do not request calendar.events, which also reaches calendars shared with the account.

## The video

One screen recording, uploaded to YouTube as **Unlisted**, with its link pasted
into the form. It must show the app's name and the OAuth client ID, Google's
consent flow as a clinic meets it, and each sensitive scope in use. On-screen
captions are enough; a voiceover is optional. Aim for three to four minutes, in
English, in a window at least 1280 pixels wide.

Record in a Chrome profile signed in to Google only as healdesk's sandbox
Workspace account, against the demo clinic, with synthetic data only. Before
recording, put one made-up appointment in the chosen calendar at a time inside
opening hours, so scene 8 has something to show.

| # | On screen | Caption |
| --- | --- | --- |
| 1 | Google Cloud console → Google Auth Platform → Clients: the list row for healdesk's web client, showing its name and client ID. Never open the client's page, which shows the secret. | healdesk's OAuth client for Google Calendar: `<client ID>`. |
| 2 | `https://healdesk.io`, then its privacy policy, scrolled to section 11. | healdesk is an AI front desk for clinics. Section 11 says what it does with Google user data. |
| 3 | The clinic portal, Setup step 3 "Your calendar" (shot 01). Tick the box under "Connecting your Google Calendar" and click "Sign in with Google". | A clinic connects the calendar its bookings live in. The notice says what each permission is for. |
| 4 | Google's account chooser. Click into the address bar so `client_id=` is readable; choose the sandbox account. | The client ID in Google's address bar is the one from scene 1. |
| 5 | If Google warns the app is unverified: Advanced → Go to healdesk. Then the consent screen (shot 02); hold on it for five seconds. Click Continue. | healdesk asks for five permissions: sign-in, the account's email address, the list of its calendars, when a calendar is free or busy, and the events healdesk itself creates. |
| 6 | Back in healdesk: the calendar picker (shot 03). Choose the calendar. | calendar.calendarlist.readonly: healdesk lists the calendars this account owns or manages, so the clinic chooses where bookings go. |
| 7 | Settings → Calendar (shot 04). | openid and userinfo.email: the clinic sees which Google account is connected. |
| 8 | Google Calendar in another tab showing the made-up appointment; then healdesk's front-desk page for a request, "Free in your calendar" (shot 05), without that time. | calendar.events.freebusy: healdesk reads only when the calendar is busy, never what the events are, and offers only free times. |
| 9 | Choose a time and confirm it (shot 06). | calendar.events.owned: healdesk adds the confirmed booking to the chosen calendar. |
| 10 | Google Calendar: open the new event (shot 07). | The event holds the first name, the service and the time. It is private, has no guests and sends no invitation. healdesk never reads, changes or deletes events it did not create. |
| 11 | healdesk Settings → Calendar → "Disconnect the calendar". | The clinic can disconnect at any time, which removes healdesk's stored access. |

In YouTube Studio's editor, blur the values of `state=`, `nonce=`,
`code_challenge=` and `code=` wherever the address bar shows them (scenes 4
and 5, and the callback after scene 5), or cut those seconds. Nothing else in
the video may show a secret, a token, a session cookie or a real person.
