# WEBCHAT-2: can website chat confirm its own snippet? (proposal, no code)

Lane WEBCHAT-2, 29 October 2026. Designer only; nothing here is built. Names below were read out of the code on `origin/main` (c50d9019).

## Summary

- Today an operator presses "The line is on their website" (ops `confirmWebWidget`, `confirmWidgetOnSite`) to record `runtime_seen`; until then the bubble opens to "Please call the practice".
- The only automatic signal is `noteWidgetLoaded`, called from `startWebChat` when `isClinicSiteOrigin` holds. It writes nothing and raises the `web_widget_to_confirm` ops alert once.
- An Origin header cannot be forged by a hostile web page (browsers set it), but it can be forged by any script that knows the slug and the clinic's website, both public. So Origin is evidence of "a browser on that site", not proof.
- **Recommendation: build a smaller variant.** Record sightings from the registered host (exact or `www`), confirm automatically after two real bubble opens at least five minutes apart, show the host in the portal, and keep the operator button as an override. Do not confirm on one hit.
- Cost about 3 to 4 days (one migration, one definer branch, no widget change). Go-live stays gated by every other input, and billing still starts at first answer, so a false confirmation cannot charge anyone.

**Owner decisions**
1. Accept that a script (not a page) that knows the slug and website can forge two sightings and set `runtime_seen`, because go-live still needs audit, platform, ops_ready and the rest; or also require a server-side page-source check (my default: accept).
2. Which hosts count: exact host and `www` only (my default), or any subdomain as `originAllowed` accepts today (this would let `staging.` or a third-party-hosted subdomain confirm).
3. Whether the operator alert and button stay as the fallback, and `web-chat-on-paste` stays `building` until a live check on one real clinic site (my default: yes to both).

## 1. What exists

- Widget: `apps/app/src/widget/v1.js` sends nothing on load. Its first request is `post("start", {})` from `start()`, on the first bubble open, so "first load" is really "first open". Nothing carrying a visitor's words is sent until the chat starts.
- Route: `app/api/widget/v1/[slug]/start/route.ts` calls `widgetRequest` (`lib/chat/widget-http.ts`: clinic by slug, `originAllowed(origin, clinic.website)` else 403, `rateLimited` at 20 calls a minute per address and clinic in an in-process Map, a body limit), then `startWebChat(clinic, now, origin)`.
- `startWebChat` calls `noteWidgetLoaded` when `isClinicSiteOrigin(origin, clinic.website)` (not localhost, website on file, `originAllowed`). `assistantMayAnswer` then returns pass-through while website chat is not live, so the widget shows the call panel.
- `noteWidgetLoaded` reads `clinicChannels` for `liveAt === null && waitingOn === "snippet"` and calls `notifyOpsOnce("web_widget_to_confirm", ...)`. Its comment records the rule this proposal must respect: taking the channel live on an Origin alone would let anyone do it to any clinic.
- `decideChannel` (`lib/channels/events.ts`) makes `clinic_step` for web the `runtime_seen` event; `app_channel_record_input('web','runtime_seen','ops_confirmed')` (drizzle 0079, restated in 0080 and 0090) is the only writer and accepts only that `p_via`. Live also needs `audit`, `runtime`, setup, prices, covered status, `platform` and `go_live` (opsReady).
- `originAllowed` matches `host === site`, `www.site` or `*.site` over https, plus http localhost; no website on file allows every origin. `isClinicSiteOrigin` is the tightened form.
- Copy: `setupLine` (`lib/setup/channels.ts`) says "after setup, you paste one line on your website, and AYA is designed to start answering there"; `actionLine("snippet")` says "Paste one line on your website". The `LAUNCH_PROMISES` item `web-chat-on-paste` (`apps/web/src/lib/admin/seo/launch.ts`) is `building`, `blocksGoLive: false`.

## 2. Evidence analysis

| Threat or case | Effect on an Origin-based rule |
| --- | --- |
| Hostile page on another domain | Its Origin is its own, so `originAllowed` returns 403 before anything is recorded. It cannot confirm another clinic's snippet. |
| Non-browser client (curl, script) with a forged Origin | Passes. Needs the slug (in the public snippet) and the website (public). The rate limit slows it but does not stop it. This is the residual risk. |
| Clinic pastes the line on a staging site (`staging.clinic.com`) | Matches today's `*.site` rule: a false positive while production has no bubble. Fixed by exact host plus `www` only. |
| Registered domain differs from the live site (moved `.com` to `.co`, website field mistyped) | Never matches, so the clinic waits and the operator path is the way out. Safe failure; the portal says which host we expect. |
| CDN or a site builder's preview domain (`*.wixsite.com`, `*.squarespace.com`) | Origin is the preview host, so no match. If the registered website is itself a platform apex, another tenant's page could match, so refuse auto-confirm for a small blocklist of platform apexes. |
| Subdomain and `www` | `www` and apex are one site and both count. Other subdomains do not, unless decision 2 says so. |
| Referer | Not needed. The widget's own comment notes `keepalive` sends the real Origin and no Referer. Origin is the only header used. |
| Staff testing the bubble from the real site | Wanted. This is the intended trigger, and the portal tells them to do it. |
| Iframes, AMP, a translation proxy's cached copy | A different Origin, so no match. Not a false positive. |
| Snippet later removed | Not detected by any version here. Same as today. |

A page-source check would remove the forging risk: apps/web's fetch guard (`lib/site-read/fetch.ts`) reached through the signed `/api/clinic-site` call that `lib/website/client.ts` already makes, looking for the script URL and `data-clinic`. It fails for tag managers and JavaScript-injected installs and adds a signed round trip, so it is not in the slice; it is the option if decision 1 goes the other way.

## 3. What "confirmed" should require

One hit is too weak: a single probe produces it. A rule needing many distinct visitors is too strong: a clinic whose only visitor is staff would never confirm.

- **Sighting**: a `start` that passes `widgetRequest`, whose Origin host equals the registered host or `www.` of it, not localhost, not on the platform blocklist, while `waitingOn === "snippet"`.
- **Confirmed**: two sightings at least five minutes apart (default; the owner may change it), counted in the database, not in the per-process rate-limit Map, which resets on restart and is not shared between tasks.
- No cookie, fingerprint or visitor input is used or stored.
- Confirmation records `runtime_seen` through a new `p_via = 'origin_seen'` branch of `app_channel_record_input` (new migration; the three earlier definers each restate the whole function, so it is restated again). The audit row names `via: "origin_seen"`; `confirmWidgetOnSite` keeps `ops_confirmed`.

## 4. Failure mode

- Before confirmation nothing changes: `assistantMayAnswer` passes through, the bubble shows the call panel with the practice's number, and no chat is answered.
- A false confirmation moves one input of `decideChannel`. The channel still needs the others, including `go_live` (opsReady). Billing starts at first answer (`recordFirstAnswer`), not at live, so nobody is charged for a snippet that is not installed.
- The bubble only renders on pages that load the script, so "bubble live where the snippet is not" cannot happen by itself. The real harm is a clinic told "live" with no bubble on its production site. The portal text below keeps this honest by naming the host seen.
- Existing gap, not fixed here: a first answer from `staging.` counts, because `localTest` excludes only localhost. Exact-host matching for sightings does not change the answering rule.

## 5. PHI boundary

- A sighting is business data: clinic id, host string, timestamps, a count. No visitor words, IP, user agent or token are stored; `start` carries an empty body.
- It lives only in `apps/app`. `apps/web` sees only the host, through a field added to the existing ops reply, not a new crossing.
- Storage: one small table `widget_sightings` (clinic_id, host, day, count, first_at, last_at) with RLS like `channel_events`, written through a definer, dropped by the retention sweep once the channel is live. No new Vercel runtime.

## 6. Rate limits and abuse

- Keep the existing 20 a minute per address and clinic; add a cap of one sighting-row write per clinic per minute so a flood costs one upsert.
- Write only while `waitingOn === "snippet"`, so the cost stops at confirmation.
- Cross-clinic: the slug picks the clinic and the Origin is checked against that clinic's website, so a page can only ever confirm its own registered site.
- Keep `web_widget_to_confirm` for the case where sightings exist but do not meet the rule (for example another host), with the host seen in the wording.

## 7. What the portal says (Setup, wizard channel screen, ops Setup tab)

- **Waiting**: "Paste one line on your website" (unchanged), then "Then open your website and click the chat bubble once."
- **Seen**: "We saw the chat on example.com. Open it once more in a few minutes to finish." No duration promised beyond that step.
- **Confirmed**: "Website chat is on example.com." Then the existing go-live wording for whatever else it waits on.
- **Seen on another host**: "We saw the chat on staging.example.com, not example.com. Paste the line on your main site or tell us your site's address." No auto-confirm.
- The ops Setup tab shows the same states beside the existing "The line is on their website" button.

## 8. Effect on the setup promise copy

"Website chat live once the snippet is pasted" (spec, set-up promise) describes the step, never the time, so it stands, and stays true only for a clinic whose other inputs are done. `setupLine` stays phrased as design until the change is deployed and live-verified on a real clinic site, then drops "designed to". In that same commit: move `web-chat-on-paste` to `on` in `launch.ts` and rewrite its `left`, and update `/admin/map` (`system-map.ts` BRIDGES wording), since the confirmation path changes.

## 9. Tests needed

- Host matcher: exact, `www`, other subdomain, staging, localhost, http, uppercase, platform apex, no website on file.
- Rule: one sighting is not enough; two within five minutes is not; two apart confirms; sightings ignored once not `waitingOn === "snippet"`.
- Database (real Postgres; report skip counts): the definer accepts `origin_seen` only for web `runtime_seen`, records once, writes the audit row, refuses outside a tenant and for a clinic that did not buy web; the SQL and TypeScript parity test in `tests/channel-events.test.ts` is extended.
- Route: a hostile Origin gets 403 and records nothing; a missing Origin records nothing; the 21st request in a minute is 429; the stored row holds no body content.
- Portal: each of the four states in `tests/setup-pages.test.tsx`; the ops Setup tab; alert wording for `web_widget_to_confirm`.
- Copy guards and `system-map.test.ts` pass after the wording and map edits.

## 10. Effort and risks

- Effort about 3 to 4 days with review: migration and definer 1; rule and route 1; portal and ops text 1; tests and a live check on one real site 0.5 to 1. No widget change, so no cache concern for `v1.js`.
- Risks: a forging script (decision 1); a clinic whose real site is on another host never auto-confirms and falls back to the operator, as today; the migration needs a deploy, which needs the owner's yes.
- Not covered: detecting that the snippet was removed later.

## 11. Alternatives

- **Do not build**: the operator click stays. Cost is one click per clinic and a delay; risk is zero. Reasonable while there is one clinic.
- **Full variant** with a page-source check: strongest, but fails for tag managers and costs a signed round trip.
- **Smaller variant (recommended)**: as above. The least change is a sub-variant that only shows "seen on <host>" in the portal and the ops alert and still needs the click.
