# Google OAuth verification: status

The one place to check where Google's verification of healdesk's Calendar
connection stands. Until it is approved, a clinic connecting Google Calendar
sees Google's "unverified app" warning. Update this page whenever a step moves,
with the date and who confirmed it. How to do each step:
[SUBMISSION.md](./SUBMISSION.md).

**Overall: NOT SUBMITTED.** Last updated 1 November 2026. Next: check Branding (6a), then the practice run and the video (SUBMISSION.md, Parts 1 and 2).

| # | Step | State | Confirmed by, date |
| --- | --- | --- | --- |
| 1 | Sign-in with Google built in the app (five permissions, `GOOGLE_SCOPES`) | Done | Code on `main` |
| 2 | Privacy policy section 11 (Google user data, Limited Use) live at healdesk.io/privacy | Done | Checked live, 31 Oct 2026 |
| 3 | healdesk.io verified in Google Search Console | Done | Owner, 31 Oct 2026 |
| 4 | Project is **healdesk-prod**; one OAuth client, "healdesk production - calendar", redirect `https://app.healdesk.io/api/calendar/google/callback` | Done | Owner, 31 Oct 2026 |
| 5 | Data Access lists exactly the five permissions; Google marks only `calendar.events.owned` sensitive | Done | Owner, 31 Oct 2026 |
| 6 | Audience: External, "In production" | Done | Owner, 1 Nov 2026 |
| 6a | Branding page (name, logo, home, privacy, terms, authorised domain) | Not confirmed | |
| 7 | Client ID and secret set on the AWS host (Parameter Store), the ID matching healdesk-prod's client | Done (the secret's correctness shows at the first connect) | Owner, CloudShell, 31 Oct 2026 |
| 7a | Test Google account for the recording: `healdesk.testclinic@gmail.com` (free Gmail, recovery address hello@healdesk.io) | Done | Owner, 1 Nov 2026 |
| 7b | YouTube channel to upload the video to: `@healdeskio` | Done | Owner, 1 Nov 2026 |
| 8 | Demo video recorded and uploaded to YouTube as Unlisted | Not started | |
| 9 | Submitted in the Verification Center (date) | Not started | |
| 10 | Google's branding review passed | Waiting on 9 | |
| 11 | Google's review of `calendar.events.owned` approved | Waiting on 9 | |
| 12 | Demo clinic set back: Auto-confirm on, test events deleted | After 8 | |

Screenshots 02 and 07 in [README.md](./README.md) are **not needed** for the
submission. Google asks for the video. They are optional.

**Until step 11 is approved: never connect a real clinic's Google Calendar.**
Only the demo clinic and healdesk's test Google account.

## Log

- 1 Nov 2026: owner created the test account healdesk.testclinic@gmail.com
  and the YouTube channel @healdeskio, and confirmed Audience is "In
  production".

- 31 Oct 2026: owner confirmed in CloudShell that GOOGLE_OAUTH_CLIENT_ID and
  GOOGLE_OAUTH_CLIENT_SECRET are set on the host (step 7).
- 31 Oct 2026: status reconstructed from the repo and the owner's report of the
  Google Cloud console (steps 3 to 5). SUBMISSION.md rewritten as a
  non-engineer's guide to the video.
