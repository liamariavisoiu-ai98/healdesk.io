# Google OAuth verification: what to submit, and how to record the video

Clinics connect their Google Calendar to healdesk with "Sign in with Google".
Until Google verifies healdesk, every clinic that does this first sees Google's
"Google hasn't verified this app" warning. This page is everything needed to
get rid of that warning, written so that someone who is not an engineer can do
it, start to finish.

**Where things stand today:** see [STATUS.md](./STATUS.md). Tick things off
there, not here.

---

## What Google asks for

In Google Cloud (project **healdesk-prod**) → Google Auth Platform → Data
Access, Google sorts healdesk's five permissions like this (owner's reading of
the console, 31 October 2026):

| Permission | Google's category | Needs a review? |
| --- | --- | --- |
| `openid` | non-sensitive | No |
| `.../auth/userinfo.email` | non-sensitive | No |
| `.../auth/calendar.calendarlist.readonly` | non-sensitive | No |
| `.../auth/calendar.events.freebusy` | non-sensitive | No |
| `.../auth/calendar.events.owned` | **sensitive** | **Yes** |

These are exactly the five the code asks for (`GOOGLE_SCOPES` in
`packages/connectors/src/google/oauth.ts`), so nothing needs to be added or
removed. Only one permission, `calendar.events.owned`, needs a review, and it is
"sensitive", not "restricted": **no paid outside security audit is needed.**

For that one permission Google wants two things:

1. **A short written reason** (ready to paste, below).
2. **A YouTube video** showing how healdesk uses it (step-by-step guide below).

You do **not** need the screenshots in [README.md](./README.md) for the
submission. Google's form asks for the video, not screenshots. The screenshots
were made as the storyboard for the video and as our own record. Shots 02 and 07
are optional.

### About Google's warning on the video page

Google's page says: *"If your app is already public, do not deploy unverified
scopes to your production traffic... use a staging environment or a test
project."* That warning is for apps that already have real users. healdesk has
**no clinic connected to Google Calendar yet**. The only clinic you will use is
healdesk's own made-up **demo clinic**, and the only Google account you will use
is healdesk's own **test (sandbox) account**. So recording on the live app at
`app.healdesk.io` is safe, and it is the only place where Google's real sign-in
screen for our real client appears.

One rule until Google approves: **do not connect a real clinic's Google
Calendar.** It would see the warning, and Google limits how many people can sign
in to an unverified app.

Google also says *"the unverified app screen will appear for your test account.
This is expected and must be shown in the video."* So in the video you show
that warning on purpose, and click past it.

---

## Part 1: Get ready (about 20 minutes, once)

### 1.1 Things you need

- [ ] A computer with **Google Chrome**.
- [ ] The **healdesk test (sandbox) Google account**: its email address and
      password. Never use your personal Google account, and never a real
      clinic's account.
- [ ] Your **operator email address**: the one you signed in to the demo
      clinic's portal with before.
- [ ] A screen recorder. On a Mac, press **Cmd + Shift + 5** and choose
      "Record Selected Portion". On Windows, use the **Snipping Tool**'s video
      button. Either is fine.
- [ ] A YouTube account. Any account works, but healdesk's own is best.

### 1.2 Make a clean Chrome profile for the recording

So that only the test account shows up on Google's screens:

1. In Chrome, click your profile picture (top right) → **Add** → **Continue
   without an account**. Name it "healdesk recording".
2. In that new window, go to `accounts.google.com` and sign in with the
   **test (sandbox) account**. Do not sign in to any other Google account in
   this window.
3. Use this window for everything below.

### 1.3 Sign in to the demo clinic's portal

1. In the recording window, go to `https://app.healdesk.io/sign-in`.
2. Type your **operator email address** and ask for a sign-in link.
3. Open the email and click the link. If the link opens in a different
   browser, copy it and paste it into the recording window instead.
4. If it asks for your passkey or authenticator code, give it.
5. You should now see the demo clinic's portal (Home, Settings, Knowledge,
   Conversations, Bookings, Billing).

### 1.4 If the calendar is already connected, disconnect it

The video has to show the connection from the start.

1. Go to **Settings** → the **Calendar** card.
2. If it shows a connected Google account, click **Disconnect the calendar**
   and confirm.

### 1.5 Turn "Auto-confirm bookings" off, for the recording only

With it off, a booking arrives as a request, and the Bookings page shows the
free times healdesk read from the calendar. That is the clearest way to show
Google what the calendar data is used for.

1. **Settings** → **Calendar** card → switch **Auto-confirm** off.
2. Write down that you did this. You will turn it back on at the end (step 4.4).

### 1.6 Put one made-up appointment in the test calendar

This lets the video show that a busy time is never offered.

1. In the recording window, open `calendar.google.com` (signed in as the test
   account).
2. Pick a weekday in the coming week, inside the demo clinic's opening hours,
   for example **Thursday 3:00 to 4:00 PM**.
3. Create an event called **"Busy (test)"** at that time. No guests.
4. Remember the day and time. You will need it in scene 8.

### 1.7 Find the client ID (to show at the start of the video)

1. In your **normal** Chrome window (not the recording one), go to
   `console.cloud.google.com` and choose project **healdesk-prod** at the top.
2. Menu → **Google Auth Platform** → **Clients**.
3. You will see one row: **healdesk production - calendar**, and its **Client
   ID**, a long code ending in `.apps.googleusercontent.com`.
4. **Do not click into the client.** Its page shows the secret, which must
   never be in the video. The list row is enough.

### 1.8 Do a practice run without recording

Go through Part 2 once without recording, so nothing surprises you. Then
disconnect the calendar again (step 1.4) and delete the test booking it made
from Google Calendar. Keep the "Busy (test)" event.

---

## Part 2: Record the video (aim for 3 to 4 minutes)

**Before you press record:**

- Make the browser window big, at least 1280 pixels wide (full screen on a
  laptop is fine).
- Close other tabs, email and chat apps, so no notification pops up.
- Have two tabs open in the recording window: **Tab A**, the demo clinic's
  portal; **Tab B**, Google Calendar.
- Keep your **normal** window ready on the Clients page (step 1.7) for scene 1.

You do not need to talk. The captions in the right-hand column are added
afterwards in YouTube (Part 3), or you can say them out loud while recording if
you prefer. Go slowly: **pause about 3 seconds on every screen.**

| Scene | What you do | Caption to add |
| --- | --- | --- |
| **1** | In your normal window: the **Clients** list in Google Cloud, project healdesk-prod, showing the row **healdesk production - calendar** and its Client ID. Hold for 5 seconds. Do not open the client. | "This is healdesk's only OAuth client for Google Calendar. Client ID: `<paste the client ID>`." |
| **2** | Switch to the recording window. Go to `https://healdesk.io`, scroll a little, then go to `https://healdesk.io/privacy` and scroll to **section 11** (Google user data). Hold for 5 seconds. | "healdesk is an AI front desk for clinics. Section 11 of our privacy policy explains what we do with Google user data, and includes the Limited Use statement." |
| **3** | Tab A, the portal: **Settings** → **Calendar** card (or **Setup**, step 3 "Your calendar"). Tick the box under **"Connecting your Google Calendar"**, then click **Sign in with Google**. | "A clinic connects the Google Calendar its bookings live in. The notice explains what each permission is for." |
| **4** | Google's account chooser opens. Click once into the address bar, so the text `client_id=...` can be read, and hold for 3 seconds. Then click the **test account**. | "Google's sign-in page shows the same client ID as scene 1." |
| **5** | Google shows **"Google hasn't verified this app"**. Hold for 3 seconds (it must be visible). Click **Advanced**, then **Go to healdesk (unsafe)**. | "Google's unverified app warning, shown for our test account. This is the warning we are asking Google to remove." |
| **6** | Google's permission page lists what healdesk asks for. Hold for 5 seconds. If there are checkboxes, tick them all. Click **Continue**. | "healdesk asks for: sign-in, the account's email address, the list of its calendars, when the calendar is free or busy, and the events healdesk itself creates." |
| **7** | Back in healdesk: the list of the account's calendars. Choose the one bookings should go into, then save. | "healdesk lists the account's calendars so the clinic chooses where bookings go." |
| **8** | **Settings** → **Calendar** card, showing the connected account. Then switch to Tab B (Google Calendar) and show the **"Busy (test)"** event from step 1.6. | "The clinic can see which Google account is connected. This is an existing appointment in the clinic's calendar." |
| **9** | Make a booking request for the **same day** as the "Busy (test)" event (see "How to make the booking request" below). Then in Tab A, open **Bookings** and open the new request. Point the mouse at **"Free in your calendar"**. The busy time is **not** in the list. | "When a patient asks for an appointment, healdesk checks only when the calendar is free or busy, never what the events are, and offers only free times. The busy 3 PM slot is not offered." |
| **10** | Choose one of the free times and **confirm** the booking. Wait for **"Added to your calendar."** | "calendar.events.owned: when the clinic confirms, healdesk adds the booking to the calendar the clinic chose." |
| **11** | Tab B, Google Calendar: refresh, go to that day, click the new event to open it. Hold for 5 seconds. | "The event holds only a first name, the service and the time. It is private, has no guests and sends no invitations. healdesk never reads, changes or deletes events it did not create." |
| **12** | Tab A: **Settings** → **Calendar** → **Disconnect the calendar**, and confirm. | "The clinic can disconnect at any time, which removes healdesk's access." |

Stop the recording.

### How to make the booking request (scene 9)

Use a **made-up name** and a fake **555** number, for example "Jordan,
212 555 0142". Never a real person.

- **Easiest: a test phone call** to the demo clinic's AYA number, as you have
  done before. Say something like: *"Hi, I'd like to book a consultation on
  Thursday afternoon. My name is Jordan, my number is 212 555 0142."* Then hang
  up. You can make the call before you start recording, and in scene 9 just
  open the request in Bookings. Say "the request came in from a phone call" in
  the caption.
- **Or the website chat**, if the demo clinic's website chat is live: type the
  same request in the chat.

If no request shows up in Bookings within a couple of minutes, stop and tell
Claude. Do not make up a workaround.

---

## Part 3: Edit and upload to YouTube (about 20 minutes)

1. Go to `studio.youtube.com` → **Create** → **Upload videos** → pick the
   recording.
2. Title: **"healdesk – Google Calendar OAuth verification demo"**.
3. Visibility: **Unlisted**. Not Private: Google's reviewers could not open
   it. Not Public.
4. After the upload: **Editor** (left menu) → **Blur** → **Custom blur**.
   Blur the address bar wherever it shows `code=`, `state=`, `nonce=` or
   `code_challenge=`. That is scenes 4 to 6, and the moment right after
   **Continue** in scene 6. It is fine to leave `client_id=` readable: Google
   wants to see it. If blurring is fiddly, cut those seconds instead with
   **Trim & cut**.
5. Add the captions: **Subtitles** → **Add** → **Type manually**, and type each
   scene's caption at its time. (Or skip this if you spoke the captions
   while recording.)
6. Watch the whole video once. Check there is **no** client secret, password,
   real person's name or number, or other browser tab with private things in
   it.
7. Copy the video's link.

---

## Part 4: Submit, and afterwards

1. In your normal window: Google Cloud → project **healdesk-prod** → Google Auth
   Platform → **Verification Center** (on some screens: **Data Access** →
   "Submit for verification", or **Audience** → "Prepare for verification").
2. Check the app details it shows match the Branding page: app name
   `healdesk`, logo, home page `https://healdesk.io`, privacy
   `https://healdesk.io/privacy`, terms `https://healdesk.io/terms`, authorised
   domain `healdesk.io`.
3. Where it asks why you need `calendar.events.owned`, paste the paragraph
   under "The written reason" below.
4. Paste the **YouTube link**.
5. Give a contact email you read. Google writes to it.
6. Submit, and write the date in [STATUS.md](./STATUS.md).

**Afterwards:**

- Google usually checks the app's details (branding) within a few days, and the
  permission itself within a few weeks.
- They often reply with a question or a request for a change, by email. Forward
  it to Claude to draft the answer. Reply from the same Google account.
- When Google approves, the warning disappears for clinics. No code change is
  needed.
- **Turn "Auto-confirm" back on** for the demo clinic (Settings → Calendar)
  once the video is recorded, and delete the "Busy (test)" event and the test
  booking from the test calendar.

---

## The written reason (paste this)

Only `calendar.events.owned` needs one. If Google also asks about another
permission, its paragraph is under "Other paragraphs, only if asked".

**`calendar.events.owned`**

> healdesk is an AI assistant that answers a clinic's patient calls and messages and books their appointments. We add each confirmed booking to the calendar the clinic chose: one event with the patient's first name, the service and the time, created when the assistant books or when the clinic's staff confirm a request in healdesk. Events are private, with no guests and no reminders, and no invitations are sent. We read back only events we created, by their ID, to confirm a booking and never write it twice. We never read, change or delete events we did not create.
>
> Narrower scopes do not work. freebusy and the read-only scopes cannot create events. calendar.app.created writes only to a new calendar created by healdesk, which the clinic's staff and booking software do not already check, so the same time could be booked twice. calendar.events.owned is the narrowest scope that writes to the clinic's existing calendar. We do not request calendar.events, which also reaches calendars shared with the account.

### Other paragraphs, only if asked

**`calendar.calendarlist.readonly`**

> When the clinic's administrator connects Google Calendar, or changes calendar later, we list the calendars that account owns or manages, so the administrator can choose which one bookings go into. We request only each calendar's ID, name, time zone and access role. There is no narrower scope that lists calendars.

**`calendar.events.freebusy`**

> We read when the clinic's chosen calendar is free or busy, so healdesk offers patients, and shows the clinic's front desk, only times that are open. This returns busy blocks only, never event titles or details. It is the most limited way to read availability, and we use it instead of reading events.

Each paragraph describes what the code on `main` does
(`packages/connectors/src/google/adapter.ts` and `event.ts`).

---

## For engineers: what must hold before submitting

- `apps/app` is live at `https://app.healdesk.io` with healdesk-prod's client
  (`GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` set in Parameter
  Store under `/healdesk/production/app/`); the demo clinic exists.
- The client's only redirect URI is
  `https://app.healdesk.io/api/calendar/google/callback`.
- The project has exactly one OAuth client (Google: "your video must include
  all OAuth clients that you assigned to this project").
- Data Access lists exactly `GOOGLE_SCOPES`, no more.
- `healdesk.io` is verified in Search Console by an Owner or Editor of
  healdesk-prod.
- If `GOOGLE_SCOPES` ever changes, the consent screen, this page, STATUS.md and
  the video must be redone before the change ships.
