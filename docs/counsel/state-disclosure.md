# AI disclosure and call-transcription consent, by state (launch step 1.13)

> **DRAFT for counsel review — not legal advice.** Compiled by an AI
> assistant on 1 October 2026 from web sources, most of them secondary
> (law-firm alerts, recording-law aggregators). Every row needs a lawyer's
> check before launch. "Unverified" means the claim was not confirmed
> against a primary source or a law-firm analysis in this session. Statutes
> change; several AI laws below were enacted, amended or replaced in
> 2025–2026.

## What the product says today

Voice, from `apps/app/src/lib/compliance/disclosure.ts` `voiceDisclosure()`:

> "Hi, I'm an AI assistant for {clinic} — not a human. This call is
> transcribed by an automated system; no audio recording is kept. Say
> "representative" at any time to reach a person."

Web chat: "You're chatting with an AI assistant for {clinic}. Ask for a
person any time."

Instagram and WhatsApp: "Hi! I'm an AI assistant for {clinic}. This channel
isn't secure, so please don't share medical details here — I can take your
number and the practice will continue by phone."

The spec ("Five rules", first and fifth) requires the AI line on every
channel, first, not editable, and on calls "transcribed" in the same breath.

## The table

Legend for the last column: **Yes** = the current voice line appears to
satisfy the rule as summarised; **Partly** = it covers the core but misses a
listed element; **N/A** = no relevant rule found; **?** = depends on a
question counsel must answer.

| State | Call recording / transcription consent | AI-disclosure law relevant to healthcare or customer calls | Current line covers it? | Sources | Confidence |
| --- | --- | --- | --- | --- | --- |
| **California** | All-party. Penal Code §632 (confidential communications), §631 (wiretapping, includes third-party "eavesdroppers"), §632.7 (cellular). *Ambriz v. Google* (N.D. Cal., Feb 2025) let a §631 claim proceed against an AI contact-centre vendor on a "capability" test: the vendor could use transcripts for its own purposes | **SB 1001** (Bus. & Prof. Code §17941): no bot misleading about its artificial identity to sell; disclosure is a safe harbour; applies "online". **AB 3030** (Health & Safety Code §1339.75, from 1 Jan 2025): a clinic or physician office using generative AI for patient communications about **clinical** information must say so — for audio, at the start **and the end** — and say how to reach a human provider. "Patient clinical information" excludes "appointment scheduling, billing, or other clerical or business matters". **AB 489** (from 1 Jan 2026): AI may not imply it is a licensed health professional | **Partly.** Notice at the start covers §632 and SB 1001. Does not address the *Ambriz* third-party point, which is contractual (vendor no-use terms), not verbal. AB 3030: only if a reply strays into clinical content; then the end-of-call disclaimer and "how to reach a licensed provider" are missing from the voice line (`clinicalAddendum()` exists in code, unused) | [Wikipedia, recording laws](https://en.wikipedia.org/wiki/Telephone_call_recording_laws); [AB 3030 text](https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240AB3030); [SB 1001 text](https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=201720180SB1001); [ZwillGen on *Ambriz*](https://www.zwillgen.com/privacy/federal-judge-allows-google-customer-service-ai-class-action-to-proceed/); [Hooper Lundy on AB 489](https://hooperlundy.com/californias-ab-489-signed-into-law-targeting-ai-misrepresentation-in-health-care-communications/) | AB 3030 definition and timing: confirmed from bill text. Rest: secondary |
| **Texas** | One-party. Penal Code §16.02 | **TRAIGA (HB 149)**, from 1 Jan 2026: a health care provider must disclose AI used "in relation to" a health care service or treatment, no later than the date of service, clear and conspicuous, plain language. Duty falls on the clinic. **SB 1188** (from 1 Sep 2025): practitioners using AI for diagnosis must disclose; v1 does no diagnosis | **?** Whether a scheduling assistant is AI "in relation to health care service" is open. If it is, the spoken line probably discloses, but the law's wording ("written in plain language") may want a written notice too | [recordinglaw.com](https://www.recordinglaw.com/united-states-recording-laws/); [TMLT on HB 149 / SB 1188](https://www.tmlt.org/resource/new-ai-disclosure-requirements-for-physicians-passed-into-texas-law); [Holland & Knight on TRAIGA](https://www.hklaw.com/en/insights/publications/2025/06/texas-enacts-comprehensive-ai-governance-laws) | Secondary. Scope for scheduling: unverified |
| **Florida** | All-party. Fla. Stat. §934.03. Notice at the start, followed by continuing, is commonly treated as consent | None found. A 2026 "AI Bill of Rights" (SB 482) reportedly died in the House on 13 Mar 2026 | **Yes** for recording, if implied consent by continuing is accepted | [Wikipedia](https://en.wikipedia.org/wiki/Telephone_call_recording_laws); AI status from search summary only | AI status: **unverified** |
| **New York** | One-party. Penal Law §§250.00, 250.05 | **GBL Article 47** (from 5 Nov 2025) covers "AI companions" only, not a booking assistant. S7263 (chatbots impersonating licensed professionals; requires an AI notice) was pending in March 2026; not known to be enacted | **Yes** / N/A | [recordinglaw.com](https://www.recordinglaw.com/united-states-recording-laws/); [Fenwick on Article 47](https://www.fenwick.com/insights/publications/new-yorks-ai-companion-safeguard-law-takes-effect); [Holland & Knight on S7263](https://www.hklaw.com/en/insights/publications/2026/03/new-york-bill-would-create-liability-for-chatbot-proprietors) | S7263 status after March 2026: **unverified** |
| **Arizona** | One-party. A.R.S. §13-3005 | None found for this use. A 2026 chatbot-disclosure bill (HB 2311) was reportedly vetoed on 19 Jun 2026. A Behavioral Health board rule from 1 Jan 2027 covers clinical services only | N/A | [recordinglaw.com](https://www.recordinglaw.com/united-states-recording-laws/); AI status from search summary only | AI status: **unverified** |
| **Washington** | All-party. RCW 9.73.030. Consent is deemed given where the recording is announced "in a reasonably effective manner" **and the announcement is recorded** | No general AI-disclosure law found for this use. A companion-chatbot law (from 1 Jan 2027) does not reach a booking assistant. **My Health My Data Act** applies to non-HIPAA clinics: consumer health data needs consent unless necessary to provide the service the consumer asked for | **?** The line is an announcement, but no audio is kept, so the statutory "announcement is recorded" proof does not exist. Evidence would be the transcript and `disclosure_played_at`. Counsel: is that enough? | [Wikipedia](https://en.wikipedia.org/wiki/Telephone_call_recording_laws); [Orrick 2026 chatbot laws](https://www.orrick.com/en/Insights/2026/04/2026-State-Chatbot-Laws-Key-Provisions-and-Regulatory-Trends); MHMDA per `docs/counsel-audit.md` §1 | MHMDA reading: **unverified** this session |
| **Illinois** | All-party for private conversations; the statute expressly reaches the surreptitious "interception, recording, or **transcription**" of a private electronic communication. 720 ILCS 5/14-2 | **WOPR Act (HB 1806)**, from 1 Aug 2025: bars AI providing therapy or psychotherapy; requires written consent to AI recording or transcribing therapy sessions. Relevant only to mental-health services (e.g., ketamine clinics) | **Yes** for transcription: notice makes it not surreptitious. Mental-health clinics: out of scope for this line | [720 ILCS 5/14-2](https://www.ilga.gov/documents/legislation/ilcs/documents/072000050K14-2.htm); [Orrick on HB 1806](https://www.orrick.com/en/Insights/2025/08/Illinois-Enacts-Law-Regulating-AI-with-Sweeping-Implications-for-Behavioral-Health-Delivery) | Secondary |
| **Pennsylvania** | All-party. 18 Pa.C.S. §§5703, 5704(4) | None found | **Yes**, if notice plus continuing is consent | [recordinglaw.com](https://www.recordinglaw.com/united-states-recording-laws/) | Implied-consent point: **unverified** |
| **Massachusetts** | All-party; bans "secret" recording. G.L. c. 272 §99 | None found | **Yes** — an announced transcription is not secret | [recordinglaw.com](https://www.recordinglaw.com/united-states-recording-laws/) | Secondary |
| **Maryland** | All-party. Cts. & Jud. Proc. §10-402 | None found | **Probably.** Whether notice plus continuing is "prior consent" under §10-402 should be confirmed | [recordinglaw.com](https://www.recordinglaw.com/united-states-recording-laws/) | **Unverified** |
| **Montana** | All-party; notification satisfies it. Mont. Code Ann. §45-8-213 | None found | **Yes** | [recordinglaw.com](https://www.recordinglaw.com/united-states-recording-laws/) | Secondary |
| **New Hampshire** | All-party. RSA 570-A:2 | None found | **Yes**, if notice plus continuing is consent | [Wikipedia](https://en.wikipedia.org/wiki/Telephone_call_recording_laws) | **Unverified** |
| **Connecticut** | Phone: all-party, civil. Conn. Gen. Stat. §52-570d (criminal statutes §§53a-187, 53a-189 are one-party). §52-570d is understood to accept consent, a verbal notice **recorded** at the start, or a warning tone | None found | **?** Same problem as Washington: the verbal notice is not recorded because no audio is kept. Also: is AI transcription without audio a "recording" under §52-570d at all? | [recordinglaw.com](https://www.recordinglaw.com/united-states-recording-laws/) | §52-570d mechanics: **unverified** (statute not read this session) |
| **Michigan** | Statute reads all-party (MCL §750.539c), but *Sullivan v. Gray* (1982) lets a participant record. The risk is the vendor as a non-participant eavesdropper | None found | **Yes** with notice | [recordinglaw.com](https://www.recordinglaw.com/united-states-recording-laws/) | Secondary |
| **Nevada** | Phone: all-party. NRS 200.620 as read by *Lane v. Allstate* (Nev. 1998). In-person: one-party | None found for this use | **Yes**, if notice plus continuing is consent. *Lane* speaks of consent, not notice | [Lane v. Allstate (Justia)](https://law.justia.com/cases/nevada/supreme-court/1998/25670-1.html) | Implied-consent point: **unverified** |
| **Oregon** | Phone: one-party. ORS 165.540 (all-party applies to in-person) | Companion-chatbot law (SB 1546, from 1 Jan 2027) does not reach a booking assistant | **Yes** | [recordinglaw.com](https://www.recordinglaw.com/united-states-recording-laws/); [Orrick 2026](https://www.orrick.com/en/Insights/2026/04/2026-State-Chatbot-Laws-Key-Provisions-and-Regulatory-Trends) | Secondary |
| **Delaware** | Unresolved conflict: 11 Del. C. §2402(c)(4) is one-party; §1335(a)(4) requires all parties. Treat as all-party | None found | **Yes**, treating it as all-party with notice | [recordinglaw.com, Delaware](https://www.recordinglaw.com/party-two-party-consent-states/delaware-recording-laws/) | Secondary |
| **Utah** (AI law) | One-party. Utah Code §77-23a-4 | **AI Policy Act** as amended by SB 226 (from 7 May 2025): a person in a **regulated occupation** (licensed health professions) must disclose generative AI where the interaction is "high-risk" — which includes collecting sensitive personal information such as health data. Verbal: at the start. Written: **before** the written interaction starts | **Voice: yes.** Web chat: yes if the AI line shows before the visitor types. **Meta: no** — on a DM the patient always writes first, so the disclosure cannot come "before the start" of the written interaction | [Utah Code 13-77-103 (Justia)](https://law.justia.com/codes/utah/title-13/chapter-77/part-1/section-103/); [Davis Wright Tremaine on SB 226](https://www.dwt.com/blogs/artificial-intelligence-law-advisor/2025/04/utah-regulation-ai-policy-mental-health-chatbots) | Secondary; whether a med spa booking is "high-risk": **unverified** |
| **Colorado** (AI law) | One-party | SB 24-205's general "you are interacting with AI" duty never took effect: enforcement was paused by a federal court in April 2026, and SB 26-189 (signed 14 May 2026, effective 1 Jan 2027) replaced it **without** a general AI-interaction disclosure | N/A | [McDermott on SB 26-189](https://www.mcdermottlaw.com/insights/colorado-ai-law-in-flux-comprehensive-replacement-bill-signed-after-federal-court-blocks-predecessors-enforcement/) | Secondary |
| **Maine** (AI law, not a target) | One-party | **LD 1727** (from 24 Sep 2025): businesses using an AI chatbot in trade must disclose it clearly where a consumer could think it is human | **Yes** | [Maine House Democrats](https://www.maine.gov/housedems/news/governor-signs-kuhn-legislation-protect-mainers-deceptive-artificial-intelligence) | Secondary |

## Findings that change the wording

1. **"Say 'representative' at any time to reach a person" may be false.**
   "Transfer live calls" defaults to **Off** (spec, "Escalation"). With it
   off, "representative" can only log a handover request. A disclosure that
   promises a person and does not deliver one is the kind of statement the
   FTC Act reaches. Proposed: "…say 'representative' and I'll pass your
   request to the team" when transfer is off; the current line only when it
   is on. Same issue for web chat's "Ask for a person any time": v1 has no
   live staff inbox.
2. **"No audio recording is kept" needs proof.** Retell processes audio live
   and has per-agent retention settings (1 day to 2 years). The line is true
   only if recording storage is off at Retell, verified by screenshot per
   agent (risk analysis T5). Confirm before the line ships.
3. **Washington and Connecticut want the announcement recorded.** With no
   audio kept, the evidence is the transcript plus `disclosure_played_at`.
   Counsel: is that enough, or is a short retained audio clip of the
   disclosure alone the safer design?
4. **The vendor point is not answered by any spoken line.** In California,
   *Ambriz* turns on whether the vendor *can* use call content for its own
   purposes. The defence is the Retell and Anthropic contracts forbidding
   it. Keep both, in writing, by version (`counsel-audit.md` §2).
   Optional: say "transcribed by our service providers" rather than "by an
   automated system", so the caller is told a third party is involved.
5. **A closing line is cheap.** AB 3030 wants the AI disclaimer at the end
   of an audio interaction too, when clinical information is discussed. The
   product is not meant to discuss clinical information, but a caller will
   ask about downtime or aftercare. Adding "This was {clinic}'s AI
   assistant. To speak to someone at {clinic}, call {direct line}." to every
   call ending removes the question.
6. **Meta channels cannot disclose first.** The patient writes before the
   assistant says anything. Utah's rule (written: before the interaction
   starts) cannot be met in a DM. Mitigations to ask about: the account's
   welcome message or ice-breaker text, and the Instagram bio. Also see
   `brief.md` on Meta's own healthcare policy, which may matter more.
7. **The greeting field.** The portal lets a clinic edit "Phone greeting:
   the first line a caller hears". The AI line must come before it and must
   not be editable (spec). Confirm the build order puts the fixed
   disclosure first, and that a clinic cannot write a greeting that
   contradicts it (e.g. "Hi, this is Sarah").
8. **Texas puts the duty on the clinic.** TRAIGA and SB 1188 bind the
   provider, not healdesk. Terms §8 already says the clinic owns "any
   disclosure your state requires". Counsel: is a spoken line enough for
   TRAIGA, or should the clinic be told to add a written notice (e.g. on its
   site or intake form)?

## Proposed voice line, for counsel to edit

> "Hi, you've reached {clinic}. I'm an AI assistant, not a person. This call
> is transcribed by an automated system run by our service providers; no
> audio recording is kept. [If transfer is on:] Say 'representative' at any
> time to reach the team. [If off:] Say 'representative' at any time and
> I'll pass your message to the team."

Closing, every call:

> "This was {clinic}'s AI assistant. To speak to someone at {clinic}, call
> {direct line}."

## Questions for counsel

1. In the all-party states above, is notice at the start plus the caller
   continuing valid consent to **transcription**, in each state?
2. Is AI transcription with no audio kept a "recording" under Washington
   RCW 9.73.030 and Connecticut §52-570d, and if so, how is the
   "announcement recorded" element proved?
3. Is healdesk (and Retell, and Anthropic) a party to the call as the
   clinic's agent, or a third party, under California §631 after *Ambriz*?
4. Is a med spa or aesthetic clinic's booking assistant within Texas
   TRAIGA's health-care disclosure, Utah's "high-risk" interaction, or
   California AB 3030?
5. Does any target state require consent beyond notice for a non-HIPAA
   clinic collecting "the treatment asked about" (Washington MHMDA; also
   Nevada and Connecticut consumer-health-data laws)?
6. Which unverified rows above need a full check before launch, given the
   first states the owner expects to sell into?
