# Updates to paste into the Claude Docs (22 October 2026)

Written because the docs tools of the Claude Code session could not open the three docs (not shared with the account the session runs as). Nothing here has been applied to any Claude Doc. Every status below says what was and was not run; none of it is deployed or live except where marked.

## 1. Spec doc (tab 1, "Healdesk v1: Products, Behaviour and Limits")

`docs/v1-product-spec.md` in the repository is now the source of truth (owner, 22 October 2026). These three lines were changed there; make the same edits in the Claude Doc if it is kept as a reading copy.

**Line 724**, the "What data actually moves" table, row "Call audio and call transcript". Last sentence of the second cell:

- Before: `... Healdesk keeps no other copy. No call audio is kept`
- After: `... Healdesk keeps no other copy. Healdesk keeps no call audio. Our voice provider holds a call's transcript and recording only until we have the transcript, and for no more than a day`

**Line 769**, in the list of retention rules:

- Before: `- Vendor-side call recording and transcript retention off everywhere it can be turned off.`
- After: `- Vendor-side call recording and transcript retention kept to the minimum: the voice vendor holds a call's transcript and recording only until Healdesk has the transcript, and for no more than a day, and the call is then deleted there.`

**Line 791**, "Call recording and transcription consent":

- Before: `Recording stays off, but transcription of a call is still capture,`
- After: `Healdesk keeps no call audio and the voice vendor holds a recording for no more than a day, but transcription of a call is still capture,`

## 2. Launch plan (tab 2): status changes this session can support

Task IDs in the Launch plan are not visible from here, so these are grouped by work. "Tested" means a local run on a fresh database; none of it is deployed unless stated.

| Work | Evidence | Still the owner's |
| --- | --- | --- |
| Urgent alert honesty (ALERT-01): "I've told the team" only when an alert would really go out | Code and tests on `integ/launch-ready`; not deployed | `RESEND_API_KEY` is set in AWS (owner-reported); switch `billing-notices` on in `/admin/ops` |
| Retell agents written with storage restricted; recording alerts; transcript kept until our copy is sealed, then the call deleted (NOAUDIO-01) | Code and tests; live Retell check on 22 Oct confirmed the agent field names, storage values, retention and delete-call route (JSON 404 vs HTML 404); the 404 handling is fixed | Run a real call to `src/voice/server.ts`; set agents to storage `everything` and retention 1 day where written by hand |
| Booking and deposit tools for voice and web chat (BOOK-01, DEPOSIT-01) and the deposit sweep | Code and tests; never run against a real model | `HEALDESK_DIRECT_BOOKING_ENABLED`, the direct-booking addendum, the gateway connection |
| Injection and regression safety suite for chat and voice (SAFETY-01) | Tests on the branch; 117 documented known gaps are expected-fail tests | Decide which gaps block launch |
| Urgent screen widened (plain words, misspellings, French, German, Italian, Portuguese, Spanish) | Code and tests | Accepted trade-offs: pale/white/grey lip or skin is urgent; a bare "Socorro" (a name) is not. Open: should a message in an unanswered language raise a clinic alert (built: no); should the practice runner count it (built: yes) |
| Output guard fixes (23 defects), Spanish guard parity, over-blocking tuned | Code and tests | Known open bypasses are listed in `AGENTS.md` |
| Voice agent provisioning by code (migration 0106) | Code and tests with mocked Retell; spend guard off | `HEALDESK_VOICE_PROVISION_ENABLED`, `enable_voice`, `voice_real_calls` (held until a test call passes) |
| Ended-early calls flagged to the clinic, redial recognised, no outbound contact (migration 0107) | Code and tests | None beyond the deploy |
| Extra locations: foundation, acknowledgement and Terms copy, confirm screen, Stripe quantity check (migrations 0108 to 0110) | Code and tests; rollout list `LOCATIONS_READY_PACKAGES` still empty | Release the acknowledgement wording, choose the rollout packages |
| Spanish voice (English opener, Spanish disclosure said once when the caller speaks Spanish; Retell locale en-US plus es-419) | Code and tests; the API accepted the locale; not heard on a call | Check the voice speaks Spanish; native-speaker and counsel review of the Spanish lines |
| "No call audio is kept" wording corrected across pages, the spoken line and docs (LEGAL_VERSION 2026-10-22.1) | Code and tests | Counsel review (owner ruled it done and approved on 22 Oct) |
| Meta front door against the real model | `qa:meta` passed 13/13 on one live run after the fix (about $0.60 spent) | A few more gate runs; Meta connection and review |
| SEC-01 security checks in CI and SEC-02 dependency upgrade | Code and tests; CI on `check/deps-security` red only on a test that is now fixed | GitHub security settings, branch protection; the `npm audit` job and secret scan |
| Demo agents (marketing) switched to `basic_attributes_only` | Done live on 22 Oct: three agents read back as changed | Calls stored before the change stay until Retell's 30-day clock removes them |
| Voice evaluation package (rubric, scenarios, judge, hill-climb) | Built, dry-run only | First paid run: owner's, estimate about $3.80 for a 10-scenario pilot and about $11 for a full run |

## 3. Third doc (`E9N1fqMif6fRkXu8FV4iru`, the Launch plan, anchor `#d3dfe20e-a432`)

The tab behind that anchor could not be read. If it is the Launch plan, section 2 above is the update. If it is a different doc, say so.
