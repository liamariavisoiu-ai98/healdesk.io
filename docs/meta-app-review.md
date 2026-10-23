# Meta app: setup and App Review

Launch plan steps 1.6, 2.4 and 2.5. Written 5 October 2026 against Meta's own
developer pages, read that day. Business verification of VIIXI FZC cleared on
4 October 2026. This file is the pack for everything after it: what to type
into each row of the app dashboard, which permissions to request and why, the
screen recordings, and the notes for the reviewer.

The app is **Healdesk**, under the VIIXI FZC business portfolio. It already has
the Instagram messaging use case, the Messenger use case and Facebook Login for
Business. It does not have WhatsApp yet.

## What is built

The clinic-facing connect flow, which is what every recording shows, exists
in `apps/app` as of 5 October 2026:

| Piece | Where |
| --- | --- |
| Facebook and Instagram connect page | `/channels/meta/[token]`: one "Log in with Facebook" button |
| Facebook Login for Business round trip | `/api/meta/login` → Meta's v25.0 dialog → `/api/meta/callback` |
| WhatsApp connect page and Embedded Signup v4 | `/channels/whatsapp/[token]`, finishing at `/api/meta/whatsapp` |
| Confirmation and dead-link pages | `/channels/done`, `/channels/invalid` |
| Issuing the links | On the AWS host: `bash run-task.sh channels-link <clinic id>` in CloudShell (the link lands in CloudWatch). Locally: `npm run channels-link -w @healdesk/app -- <clinic id>` |
| Graph calls, the decisions, the state cookie | `src/lib/meta/graph.ts`, `connect.ts`, `login-state.ts` |

Each link is single use and is spent in the same transaction that stores the
channels it connected. The clinic's link token never goes to Meta: only a
random nonce travels as the OAuth `state`, checked against an HttpOnly cookie
on the way back. Every Graph call runs on v25.0, the send path included.

It needs four environment variables on the host besides `META_APP_SECRET`
and `META_VERIFY_TOKEN`: `META_APP_ID`, `META_LOGIN_CONFIG_ID`,
`META_WHATSAPP_CONFIG_ID`, and `BETTER_AUTH_URL` set to
`https://app.healdesk.io`, which the redirect URI is built from. With any of
them unset the pages say the channel is not switched on yet and store nothing.

Not handled yet, and none of it is needed for review: a WhatsApp number that
stays on the WhatsApp Business app (coexistence), detecting that the person
signing in is not a Page admin (the spec's invite offer), and the connect
buttons moving into the onboarding wizard (launch plan 2.6), which retires the
`channels-link` script.

## What can be done today, and what waits

| Row on the dashboard | Can it be done today? | Waits on |
| --- | --- | --- |
| App settings → Basic | Yes | Nothing |
| Business and access verification | Business: done 4 Oct. Access verification: **start today** | Nothing. Meta decides in about 5 days, a separate clock from App Review |
| Add the WhatsApp use case | Yes | Nothing |
| Customize the Instagram use case | Yes, except webhooks | Webhooks need `app.healdesk.io` live |
| Customize the Messenger use case | Yes, except webhooks | Same |
| Facebook Login for Business: two configurations | Messenger and Instagram: yes. WhatsApp: no | The WhatsApp Embedded Signup login variation is only offered to a Tech Provider, so it waits on access verification. Both config ids go into the app's environment |
| Review and complete testing requirements | No | The host, the connect flow, and one successful call per permission at least two days before submitting |
| App Review | No | All of the above, plus the screen recordings |
| Publish | No | Approval |

The two things in front of App Review are ours, not Meta's: the product host
(`app.healdesk.io`, launch plan 1.2) and the clinic-facing connect flow, which
is what every recording shows. Meta reviews a working login and a real message
arriving and being answered. It does not review a description.

## Before submitting: ask Meta about the healthcare rule

Developer Policies § 5.6.5 (3 February 2026): "Don't use Messenger and/or
Instagram Messaging features … to facilitate direct conversations between
people and healthcare providers or to send or collect any patient data obtained
from healthcare providers." WhatsApp's Business Messaging Policy restricts
health information where regulations require heightened handling. Healdesk's
customers are clinics, so this rule is about Healdesk directly
([counsel brief](./counsel/brief.md), risk 1).

The counsel register's mitigation is to ask Meta Developer Support in writing
**before** submitting (launch plan 0.13). A rejection costs a review cycle. A
policy finding against a verified business portfolio costs more than that.
Send this from developers.facebook.com → Support → Developer Support, on the
Healdesk app:

> We are a Tech Provider building an assistant that answers a business's
> Instagram, Messenger and WhatsApp messages on its behalf. Our customers are
> cash-pay elective clinics in the US, such as medical spas and aesthetic
> clinics. The assistant answers questions about the clinic's services, prices,
> opening hours and location, and takes appointment requests. It never
> discusses medical conditions, symptoms or treatment suitability, never gives
> medical advice, and never collects health information: messages containing
> clinical content are detected before they are stored, are not saved, and the
> person is asked to call the clinic instead. It only replies inside the
> 24-hour window to someone who messaged first, and sends nothing else.
>
> Does Developer Policies section 5.6.5 permit this use on Instagram and
> Messenger? Does the WhatsApp Business Messaging Policy permit it on WhatsApp?
> If not, is there a scope of this use you would permit?

**Answered.** Meta Developer Support gave the green light, as reported by the
owner on 5 October 2026 and recorded in the launch plan (0.13). Keep the
written reply, ticket number and text, in the compliance folder: it is the
evidence if a reviewer or a later enforcement question raises § 5.6.5. If the
reply does not name WhatsApp as well as Instagram and Messenger, ask that one
again before WhatsApp ships.

## Row by row

### App settings → Basic

| Field | Value |
| --- | --- |
| Display name | Healdesk |
| App domains | `healdesk.io`, `app.healdesk.io` |
| Contact email | `hello@healdesk.io` |
| Privacy policy URL | `https://healdesk.io/privacy` (sections 11 and 12 cover Google Calendar and Meta data) |
| Terms of service URL | `https://healdesk.io/terms` |
| User data deletion | Choose "Data deletion instructions URL": `https://healdesk.io/data-deletion` |
| App icon | `apps/web/public/brand/healdesk-app-icon-1024.png` (1024 × 1024 PNG) |
| Category | Business and pages |
| Business use | "Support my clients" (Healdesk acts for other businesses) |

All three URLs were checked live on 5 October 2026.

### Business and access verification

Business verification is done. Access verification is how Meta decides that a
business acting on other businesses' data is a Tech Provider, and it applies
here. An admin of the VIIXI FZC portfolio categorises and describes the use.
Meta says it decides in about five days. Start it today, because it runs
alongside App Review rather than after it.

Suggested description:

> Healdesk provides an AI assistant that answers inbound messages for small
> businesses, specifically appointment-based cash-pay clinics in the US. Each
> business connects its own Facebook Page, Instagram professional account and
> WhatsApp Business number to Healdesk through Facebook Login for Business or
> Embedded Signup. Healdesk uses that access only to receive messages sent to
> the business and to reply to them within Meta's 24-hour customer-service
> window: answering questions about the business's services, prices and hours,
> booking appointments into the business's own calendar or passing the request
> to its staff to confirm, and, where the business has turned it on, sending a
> link to the business's own payment page for a deposit. Healdesk
> does not post content, run ads, read other conversations, or message anyone
> who has not messaged the business first. Message content is used only to
> answer that conversation, and no message content is used to train models.

### Use case: Manage messaging & content on Instagram

Choose **API setup with Facebook login**, not Instagram login. An app holds one
Instagram login type, Messenger needs Facebook Login anyway, and with Facebook
Login one sign-in connects the Page and its linked Instagram account together.

Permissions: `instagram_basic`, `instagram_manage_messages`,
`pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`,
`business_management`.

The last two are not optional (corrected 6 October 2026). Meta lists
`business_management` as a dependency of `instagram_manage_messages`,
`pages_messaging` and `pages_show_list`. Where a person's role on a Page comes
through a business portfolio, which is how most clinics hold theirs, Meta also
requires `pages_read_engagement` or `business_management`. Without them the
connect flow fails for exactly those clinics. On the dashboard, use **Add
required messaging permissions**, never **Add required content permissions**
(that one adds `instagram_content_publishing`; Healdesk does not post), then
add `pages_manage_metadata` by hand: the button leaves it out.

The clinic's side, which the connect screen tells them: the Instagram account
must be a professional account linked to the Page, and **Instagram Settings →
Messages and story replies → Message controls → Connected tools → Allow access
to messages** must be on. Without that toggle no message reaches the webhook.

### Use case: Engage with customers on Messenger from Meta

Permissions: `pages_messaging`, `pages_manage_metadata`, `pages_show_list`,
`business_management` (a dependency of `pages_messaging`, as above).

Do **not** request the Human Agent feature or any message tag. v1 sends nothing
outside the 24-hour window, and the adapter drops any send that would
(`apps/app/src/lib/meta/channels.ts`). Requesting a feature the app never uses
is a reason to reject.

### Add use case: Connect with customers through WhatsApp

Permissions: `whatsapp_business_management`, `whatsapp_business_messaging`.
WhatsApp needs nothing beyond these two. `business_management` is already
requested for the Page and Instagram use cases above, but not for WhatsApp:
Healdesk is not a Solution Partner sharing a credit line. The clinic pays Meta
directly for WhatsApp and attaches its own payment method.

Use **Embedded Signup v4**. Meta deprecates v2 on 15 October 2026.

### Facebook Login for Business: two configurations

Create both under Facebook Login for Business → Configurations. Each one gives
a configuration id, which goes into the app's environment.

Meta offers the **WhatsApp Embedded Signup** login variation only to a Solution
Partner or Tech Provider. Until access verification clears, the variation list
shows only General (seen 6 October 2026). Do not build the WhatsApp
configuration on General instead: the login variation cannot be changed later.

| | Messenger and Instagram | WhatsApp |
| --- | --- | --- |
| Name | Healdesk: Messenger and Instagram | Healdesk: WhatsApp |
| Login variation | General | WhatsApp Embedded Signup |
| Access token | System-user access token | System-user access token |
| Token expiry | Never | Never |
| Assets | Pages, Instagram accounts | WhatsApp accounts |
| Permissions | `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `business_management`, `instagram_basic`, `instagram_manage_messages` | `whatsapp_business_management`, `whatsapp_business_messaging` |
| Environment variable | `META_LOGIN_CONFIG_ID` | `META_WHATSAPP_CONFIG_ID` |
| Created | 6 October 2026, id `1119900017205430` | Not yet: waits on access verification |

A system-user token is chosen over a user token on purpose. A user token is
short-lived and belongs to whoever clicked. The assistant answers at 3am, long
after that person has logged out.

Facebook Login for Business → Settings:

| Setting | Value |
| --- | --- |
| Valid OAuth Redirect URIs | `https://app.healdesk.io/api/meta/callback` |
| Allowed domains for the JavaScript SDK | `https://app.healdesk.io` |
| Login with the JavaScript SDK | On (WhatsApp Embedded Signup runs in the SDK) |
| Enforce HTTPS, Use Strict Mode for redirect URIs | On |

The redirect URI is the one address Google and Meta both re-review if it
changes, which is why `app.healdesk.io` is settled now (launch plan 1.2).

### Webhooks (waits on the host)

| Field | Value |
| --- | --- |
| Callback URL | `https://app.healdesk.io/api/webhooks/meta` |
| Verify token | The value of `META_VERIFY_TOKEN`. Generate it with `openssl rand -hex 32` |
| Page fields | `messages` |
| Instagram fields | `messages` |
| WhatsApp Business Account fields | `messages` |

Meta calls the callback URL with a GET handshake when you press Verify and
save, so this row can only be completed once the host answers. The app secret
(App settings → Basic) goes into `META_APP_SECRET`. Every POST is rejected
without it.

Per-clinic subscription is done by the connect flow, not by hand: it calls
`POST /{page-id}/subscribed_apps` for each Page and
`POST /{waba-id}/subscribed_apps` for each WhatsApp account.

### Review and complete testing requirements

Meta will not let a permission go to review until the app has made at least
one successful API call with it, and the count can take up to a day to update.
Make the calls **at least two days before submitting**:

1. Issue the connect links for the internal demo clinic. On the AWS host,
   from AWS CloudShell with `infra/aws/scripts/run-task.sh` uploaded, first
   make the demo clinic, once ever (Stripe holds live keys, so a test
   purchase would be a real one):
   `bash run-task.sh demo-clinic "<fictional practice>" "<your name>" hello@healdesk.io <website|none>`
   then issue its links with the clinic id that task logs:
   `bash run-task.sh channels-link <clinic id> meta`
   Each prints the `aws logs get-log-events` command that reads its log
   stream; the link is there and nowhere else. Locally the same link comes
   from `npm run channels-link -w @healdesk/app -- <clinic id>`.
2. In healdesk.io/admin → Ops → the demo clinic → Onboarding, switch the Meta
   front door **on**. It is off for every clinic by default, and while it is
   off the webhook receives messages and answers none of them.
3. Connect the Healdesk Page and the Healdesk Instagram account through it.
   That calls `pages_show_list`, `pages_manage_metadata`, `instagram_basic`.
4. From the personal test Instagram account (launch plan 0.5), DM the
   Healdesk Instagram account, and message the Healdesk Page from a personal
   Facebook account. The replies call `pages_messaging` and
   `instagram_manage_messages`.
5. Connect a test WhatsApp number through Embedded Signup and message it.
   That calls both WhatsApp permissions.

Every account involved must have a role on the app (App roles → Roles: admin,
developer or tester) while the app is unpublished.

#### Starting the clock now, with Graph API Explorer

"Testing not started" on Review → Testing means the Healdesk app has not yet
made a successful call with that permission. The connect flow will make those
calls once the host is up, but Meta's own Testing page allows the calls to come
from **Graph API Explorer**, which needs no host. Meta takes up to 24 hours to
show a test and counts each one for 30 days, so doing it now runs that delay
in parallel with the build. Submit within 30 days or test again.

First add the personal Facebook account you will message from as a Tester
(App roles → Roles → Add People), and accept the invitation at
developers.facebook.com/requests. This is a real account given a role, not
App roles → Test Users: Meta's generated test users cannot be created on this
app ("The ability to create test users is disabled temporarily", 5 October
2026), and none are needed. Use a second account rather than the one that
administers the Page, so the conversation has a sender who is not the Page. While the app is unpublished, Meta delivers
messages and replies only for people with a role on it.

At developers.facebook.com/tools/explorer:

1. **Meta App**: Healdesk. **User or Page**: User Token. Add the permissions
   `pages_show_list`, `pages_manage_metadata`, `pages_messaging`,
   `pages_read_engagement`, `business_management`, `instagram_basic`,
   `instagram_manage_messages`.
   Generate Access Token, and in Facebook's dialog choose the Healdesk Page and
   the Healdesk Instagram account.
   `GET me/businesses` with this token tests `business_management`. Step 6's
   conversations read tests `pages_read_engagement`.
2. `GET me/accounts?fields=id,name,instagram_business_account{id,username}`.
   Tests `pages_show_list`. Note the Page id and the Instagram account id.
3. Switch **User or Page** to the Healdesk Page, so the token is the Page's.
4. `POST <page id>/subscribed_apps?subscribed_fields=messages`. Tests
   `pages_manage_metadata`. If Meta answers that no webhook is configured,
   leave this one for the host; the connect flow makes the same call.
5. `GET <instagram id>?fields=id,username`. Tests `instagram_basic`.
6. From the personal Facebook account, message the Healdesk Page. Then
   `GET <page id>/conversations?platform=messenger&fields=participants` and copy
   the participant id that is not the Page's.
7. `POST <page id>/messages` with parameters
   `recipient` = `{"id":"<that id>"}`, `messaging_type` = `RESPONSE`,
   `message` = `{"text":"Test reply from Healdesk"}`. Tests `pages_messaging`.
8. From the personal Instagram account, DM the Healdesk Instagram account. Then
   `GET <page id>/conversations?platform=instagram&fields=participants,messages{message}`.
   Tests `instagram_manage_messages`. Reply the same way as step 7, using the
   Instagram participant's id, to exercise the send as well.

WhatsApp appears on the Testing page once its use case is added. Its own API
Setup page offers a Meta test number and a temporary token, and sending one
message from there tests `whatsapp_business_messaging`.

These calls satisfy the Testing row only. The recordings still have to show
Healdesk's own connect flow and its own replies, which needs the host.

### App Review: one submission, every permission

Submit all nine permissions in **one** submission. Separate submissions are
separate round trips. For each permission, paste the description below and
attach its recording.

## Permission descriptions

Each answers Meta's two questions: what the app does with the permission, and
how that adds value for the person or business.

**`pages_show_list`**
> When a business connects Healdesk, we list the Facebook Pages its admin
> selected in Facebook Login for Business so the business can confirm which
> Page Healdesk should answer messages for. We store only the Page's id and
> name. Without it the business cannot choose which Page to connect.

**`pages_manage_metadata`**
> After the business connects a Page, we subscribe our app to that Page's
> `messages` webhook (POST /{page-id}/subscribed_apps) so that messages sent to
> the Page, and to the Instagram professional account linked to it, are
> delivered to Healdesk's assistant. It is used for that subscription and
> nothing else.

**`pages_messaging`**
> Healdesk's assistant replies to people who message the business's Facebook
> Page, answering questions about the business's services, prices, opening
> hours and location and taking appointment requests for the business's staff
> to confirm. It replies only inside the 24-hour window after the person's own
> message, uses no message tags, and never messages anyone first. Messages
> about medical conditions or symptoms are not answered or stored; the person
> is asked to call the business.

**`instagram_basic`**
> We read the id and username of the Instagram professional account linked to
> the Page the business connected, so we can show the business which account
> Healdesk will answer for and route incoming direct messages to the right
> business.

**`instagram_manage_messages`**
> Healdesk's assistant replies to direct messages sent to the business's
> Instagram professional account: questions about services, prices, opening
> hours and location, and appointment requests that the business's staff then
> confirm. Replies are sent only inside the 24-hour window after the person's
> message. Healdesk never sends the first message, and does not read
> conversations it was not part of.

**`pages_read_engagement`**
> When a business connects its Facebook Page, we read the Page's id and name
> and the Instagram professional account linked to it, so the right Page and
> account are connected. Most of our customers manage their Page through a
> Meta business portfolio, and Meta requires this permission for Pages held
> that way. We do not read posts, comments, followers or insights.

**`business_management`**
> Our customers are small businesses that usually hold their Facebook Page and
> Instagram account in a Meta business portfolio. When a business connects
> Healdesk through Facebook Login for Business, we use this permission only so
> that the Page and Instagram account it selected, which its portfolio owns,
> can be listed and subscribed to messages. We do not read or change the
> portfolio's settings, people, ad accounts or billing.

**`whatsapp_business_management`**
> When a business connects its WhatsApp Business account through Embedded
> Signup, we read the account and phone number it selected, register that
> number for the Cloud API, and subscribe our app to the account's `messages`
> webhook so that its customers' messages reach Healdesk's assistant. We do not
> create or send message templates.

**`whatsapp_business_messaging`**
> Healdesk's assistant replies to WhatsApp messages sent to the business's
> number: questions about its services, prices and hours, and appointment
> requests for its staff to confirm. It replies only inside the 24-hour
> customer-service window, sends no templates and no business-initiated
> messages, and asks anyone who writes about a medical condition to call the
> business rather than answering it.

## Screen recordings

Meta's rules, from its submission guide: English interface, start logged out,
show the whole login including asset selection, show each permission being
granted and then used, 1080p or better, a window no wider than 1440 px, a
visible enlarged cursor, mouse not keyboard, no audio. Add on-screen captions
naming the permission when it is used.

Record in a clean browser profile with only the test accounts signed in.

**Recording 1: Messenger** (`pages_show_list`, `pages_manage_metadata`,
`pages_messaging`)
1. Open the clinic's connect link. Caption: "A clinic connects its Facebook Page to Healdesk."
2. Click **Log in with Facebook**. Log in as the Page admin.
3. In the dialog, select the Healdesk Page, continue, and approve. Caption each permission as it is listed.
4. Land back on the connect page showing "Facebook Page connected: Healdesk". Caption: "`pages_show_list`: the Page the business selected."
5. Caption: "`pages_manage_metadata`: Healdesk subscribes to this Page's messages."
6. Switch to a personal Facebook account. Open the Page in Messenger and ask "What are your opening hours?"
7. Show the reply arriving within seconds. Caption: "`pages_messaging`: the assistant replies inside the 24-hour window."
8. Send "I have a rash after my treatment, is that normal?" Show the fixed reply asking them to call the clinic. Caption: "Clinical messages are not answered or stored."

**Recording 2: Instagram** (`instagram_basic`, `instagram_manage_messages`)
1. Start from the same login as recording 1, and show the Instagram account selected alongside the Page.
2. Connect page shows "Instagram connected: @healdeskio". Caption: "`instagram_basic`: the linked professional account."
3. From the personal test Instagram account, DM @healdeskio "How much is a consultation?"
4. Show the reply in the Instagram inbox. Caption: "`instagram_manage_messages`."

**Recording 3: WhatsApp** (`whatsapp_business_management`,
`whatsapp_business_messaging`)
1. Open the connect link, click **Connect WhatsApp**.
2. Walk through Embedded Signup: choose the business, create or select the WhatsApp Business account, add and verify the test number.
3. Connect page shows "WhatsApp connected: +1 …". Caption: "`whatsapp_business_management`: number registered and subscribed."
4. From a personal phone, WhatsApp the number "Are you open Saturday?" Show the reply. Caption: "`whatsapp_business_messaging`."

## Notes for the reviewer

Paste into the submission's reviewer instructions:

> Healdesk answers inbound messages for appointment-based businesses. To see
> it working, message our Facebook Page "Healdesk" or our Instagram account
> @healdeskio, or our WhatsApp test number <number>. The assistant replies within
> a few seconds. Try "What are your opening hours?" or "Can I book a
> consultation?". It only replies to messages you send, inside the 24-hour
> window.
>
> To see the connect flow, open <connect link for the demo clinic> and log in
> with any Facebook account that is an admin of a Page. No Healdesk password is
> needed: the link is the business's access. The recordings attached to each
> permission show the full flow.

The connect link expires (14 days by default, 30 at most), so issue a fresh one
on the day of submission (`bash run-task.sh channels-link <clinic id> meta 30`)
and again if Meta asks for more information.

## After approval

1. Publish the app (Publish → switch to Live).
2. Set `META_SOLD_ALONE` to `true` in `packages/catalog/src/plans.ts` if 0.13 came back yes, so the Meta-only package can be bought.
3. Mark 2.4 and 2.5 in the launch plan.
