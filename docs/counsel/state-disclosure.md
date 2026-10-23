# AI disclosure and call-transcription consent, by state (launch step 1.13)

> **Adopted by the owner on 1 October 2026 without external counsel review.
> Residual risks are listed in the Review log. Not legal advice.**
>
> Every row below was checked on 1 October 2026 against the statute on the
> state legislature's site, or an unofficial mirror of the statute text where
> the official site refused the connection. The last column says which. A row
> marked **unverified** names the one action that would verify it. Statutes
> change; several AI laws here were enacted, amended or replaced in 2025 and
> 2026.

## What the product says (decided 1 October 2026)

Voice, `apps/app/src/lib/compliance/disclosure.ts` `voiceDisclosure()`:

> "Hi, this is the AI assistant for {clinic}. This call is transcribed by
> our service providers; we keep no audio, and they hold a recording for a
> day at most."

followed by the clinic's phone greeting, by default "Are you looking to book
an appointment, or do you have a question?" (shortened 23 October 2026; see
decision 10).

Web chat: "You're chatting with an AI assistant for {clinic}. Ask for a
person any time and the practice team will get back to you within a day."

Instagram, Messenger and WhatsApp: "Hi! I'm an AI assistant for {clinic}.
This channel isn't secure, so please don't share medical details here — I
can take your number and the practice will continue by phone."

"Transfer live calls" stays Off by default; "representative" logs a handover
request to the contact the clinic named. The lines are fixed, first, and not
editable through the greeting field (spec, "Five rules", first and fifth).
They play on 100% of calls: area codes do not track location and callers
roam, so there is no state matrix in the product. The table below is the
check that the one line is enough, state by state.

## The two legal questions

1. **Recording consent.** About a dozen states require every party's consent
   to record a call; the rest, and the District of Columbia, need one
   party's. The product keeps no audio of its own (the voice vendor holds a recording
   for a day at most, below), but
   the voice vendor processes audio live to transcribe it, and Illinois'
   statute names "transcription" expressly, so the product is treated as
   recording everywhere. The decided line gives notice of transcription in
   its second sentence; a caller who continues after notice has consented in
   the ordinary reading of every all-party statute (California's Supreme
   Court said so in *Kearney v. Salomon Smith Barney*, 39 Cal.4th 95 (2006)).
   Two states add a mechanical element, a recorded announcement, that the
   no-audio design complicates (Washington, Connecticut).
2. **AI disclosure.** The line says "AI assistant" and "not a human" first.
   That satisfies every general chatbot-disclosure statute found (Maine,
   California's bot law online, Utah's consumer rule). The health-specific
   statutes (Texas TRAIGA, California AB 3030, Utah's regulated-occupation
   rule) put the duty on the clinic, and two of them contemplate a written
   disclosure, which a spoken line cannot be.

## The table

Legend for "Decided line covers it?": **Yes** = the line meets the rule as
the statute reads; **Partly** = covers the core, misses a listed element;
**N/A** = no relevant rule found; **Open** = depends on a question reasoning
cannot settle. "Verification" says whether the statute text was read this
session, and where.

| State | Recording / transcription consent | AI-disclosure law relevant to a booking assistant | Decided line covers it? | Primary sources | Verification |
| --- | --- | --- | --- | --- | --- |
| **California** | All-party. Penal Code § 632: no recording of a confidential communication "without the consent of all parties". § 631(a): no reading or learning the contents of a message in transit "without the consent of all parties"; this is the section *Ambriz v. Google* (N.D. Cal., order of 10 Feb 2025) applied to an AI contact-centre vendor on a "capability to use the data" test. § 632.7 (cellular) is read the same way. *Kearney* (2006): advising all parties at the outset of intent to record does not violate § 632 | **SB 1001** (Bus. & Prof. Code § 17941): no bot communicating with a Californian online to mislead about its artificial identity to incentivise a sale; a disclosure that is "clear, conspicuous, and reasonably designed to inform" is the safe harbour. **AB 3030** (Health & Safety Code § 1339.75, from 1 Jan 2025): a health facility, clinic, physician's office or group practice using generative AI for communications "pertaining to patient clinical information" must disclose, for audio "at the start and the end", and say how to reach a human provider; "patient clinical information" excludes "appointment scheduling, billing, or other clerical or business matters". **AB 489** (Bus. & Prof. Code §§ 4999.8–4999.9, chaptered 11 Oct 2025, in force 1 Jan 2026): AI may not use terms implying care is given by a licensed professional | **Partly.** § 632 and § 631 consent: yes, by notice and continuing. SB 1001: yes for web chat ("AI assistant" first); voice is not "online". AB 489: yes ("AI assistant, not a human"); the clinic's greeting must not undo it. AB 3030: engaged only if a reply strays into clinical content; then the end-of-call disclaimer and the "how to reach a provider" line are missing. *Ambriz*: the line does not say a third party transcribes; the defence is contractual (vendor no-use terms) | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=632 ; …sectionNum=631 ; https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=17941 ; https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=HSC&sectionNum=1339.75 ; https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260AB489 ; *Ambriz* order: https://www.courthousenews.com/wp-content/uploads/2025/02/ambriz-v-google-order-denying-motion-dismiss.pdf | §§ 632, 631, 17941, 1339.75 and AB 489 read on leginfo. § 632.7 and the *Kearney* and *Ambriz* opinions not re-read this session; holdings as widely reported |
| **Texas** | One-party. Penal Code § 16.02(c)(4): lawful where the person is a party or "one of the parties to the communication has given prior consent" | **TRAIGA**, Bus. & Com. Code ch. 552 (HB 149, from 1 Jan 2026). § 552.051(f): "If an artificial intelligence system is used in relation to health care service or treatment, the provider of the service or treatment shall provide the disclosure … to the recipient … not later than the date the service or treatment is first provided", emergencies excepted. § 552.051(d): the disclosure "must be clear and conspicuous", "must be written in plain language" and "may not use a dark pattern". Attorney general enforces, 60-day cure. **SB 1188** (Health & Safety Code § 183.005, from 1 Sep 2025): a practitioner using AI for diagnostic purposes must disclose it; v1 does no diagnosis | **Open.** The duty is the clinic's. Whether a booking assistant is AI "used in relation to health care service or treatment" is unsettled; the text does not exclude scheduling the way AB 3030 does. "Written in plain language" reads as a written notice. Mitigation: the written notice template below, for the clinic's website and intake form | https://capitol.texas.gov/tlodocs/89R/billtext/html/HB00149F.htm (enrolled text) ; https://texas.public.law/statutes/tex._penal_code_section_16.02 | HB 149 read (enrolled bill). § 16.02 read on a mirror (statutes.capitol.texas.gov did not render). SB 1188 from secondary sources |
| **Florida** | All-party. § 934.03(2)(d): lawful where "all of the parties to the communication have given prior consent". Third-degree felony | None in force. SB 482 ("Artificial Intelligence Bill of Rights") passed the Senate and "Died in Messages" on 13 Mar 2026 | **Yes**, on the usual reading that notice at the start plus continuing is prior consent. Florida case law on implied consent was not checked this session | http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0900-0999/0934/Sections/0934.03.html ; https://www.flsenate.gov/Session/Bill/2026/482 | § 934.03 read. SB 482 status from the official bill page as shown in search results. Implied-consent point **unverified**: action, read one Florida appellate decision on notice-and-continue consent before the first Florida clinic |
| **New York** | One-party. Penal Law § 250.00: wiretapping is overhearing or recording "without the consent of either the sender or receiver"; mechanical overhearing "without the consent of at least one party". § 250.05 makes eavesdropping a class E felony | **GBL Article 47** (from 5 Nov 2025) covers "AI companions" and excludes systems used solely for customer service; not a booking assistant. **S7263A** (chatbots impersonating licensed professionals): amended on third reading 26 May 2026, committed to Rules 5 Jun 2026; not law | **Yes** / N/A | https://www.nysenate.gov/legislation/laws/PEN/250.00 ; https://www.nysenate.gov/legislation/laws/PEN/250.05 ; https://www.nysenate.gov/legislation/bills/2025/S7263 ; https://www.nysenate.gov/legislation/laws/GBS/1700 | §§ 250.00, 250.05 and the S7263 action history read. Article 47 text not opened; scope from secondary sources |
| **Arizona** | One-party. A.R.S. § 13-3005: lawful with "the consent of either a sender or receiver" (wire) or "a party" (oral) | None in force for this use. HB 2311 (chatbot disclosure, aimed at minors) vetoed 19 Jun 2026 | N/A | https://www.azleg.gov/ars/13/03005.htm | § 13-3005 read. HB 2311 veto from secondary sources; the Behavioral Health board rule from the earlier draft is **unverified**: action, read the rule on the board's site if a behavioural-health clinic is ever sold |
| **Washington** | All-party. RCW 9.73.030(1). (3): consent "shall be considered obtained whenever one party has announced to all other parties … in any reasonably effective manner" that the conversation is about to be recorded or transmitted, "PROVIDED, That if the conversation is to be recorded that said announcement shall also be recorded" | No general AI-interaction law. **My Health My Data Act**, RCW 19.373.030: a regulated entity may collect consumer health data without consent where "necessary to provide a product or service that the consumer … has requested"; a booking the consumer asked for sits inside that. Applies to clinics outside HIPAA | **Open.** The line is the announcement. The proviso wants the announcement recorded; no audio is kept, so the record is the transcript line and its timestamp, plus the fixed audio asset the line is played from. Since 13 October 2026 healdesk keeps no transcript (it is emailed to the clinic; BAA 1.4.0), so the record healdesk holds is `conversations.disclosure_played_at` and that asset (decision 3). Whether live transcription is "recording" under (1), and whether a transcript satisfies the proviso, is not settled by the text | https://app.leg.wa.gov/RCW/default.aspx?cite=9.73.030 ; https://app.leg.wa.gov/RCW/default.aspx?cite=19.373.030 | Both read on the Legislature's site |
| **Illinois** | All-party for private conversations, and the statute reaches anyone who "intercepts, records, or transcribes" a private electronic communication "in a surreptitious manner". 720 ILCS 5/14-2(a)(1), (a)(3) | **WOPR Act** (P.A. 104-0054, from 1 Aug 2025) bars AI providing therapy; it expressly permits administrative support including appointment scheduling. Relevant only to mental-health services | **Yes.** An announced transcription is not surreptitious | https://codes.findlaw.com/il/chapter-720-criminal-offenses/il-st-sect-720-5-14-2.html (mirror); official: https://www.ilga.gov/legislation/ilcs/fulltext.asp?DocName=072000050K14-2 | § 14-2 read on a mirror (ilga.gov refused the connection). WOPR from the IDFPR release and secondary sources |
| **Pennsylvania** | All-party. 18 Pa.C.S. § 5704(4): lawful "where all parties to the communication have given prior consent" | None found | **Yes**, on the notice-and-continue reading; Pennsylvania courts have found consent implied where the person knew of the recording (not re-read) | https://codes.findlaw.com/pa/title-18-pacsa-crimes-and-offenses/pa-csa-sect-18-5704.html (mirror) | § 5704 read on a mirror (legis.state.pa.us refused the connection). Implied-consent case law **unverified**: action, read *Commonwealth v. Proetto*, 771 A.2d 823 (Pa. Super. 2001) |
| **Massachusetts** | All-party; the statute bans "secret" recording. G.L. c. 272 § 99 B(4) | None found | **Yes**, if B(4) reads as remembered: an announced transcription is not secret (*Commonwealth v. Hyde*, 2001) | https://malegislature.gov/Laws/GeneralLaws/PartIV/TitleI/Chapter272/Section99 | **Unverified this session**: malegislature.gov refused the connection twice and no mirror had the text. Action: open § 99 B(4) and confirm "secretly" and "all parties" |
| **Maryland** | All-party. Cts. & Jud. Proc. § 10-402(c)(3): lawful where "all of the parties to the communication have given prior consent" | None found | **Yes**, on the notice-and-continue reading | https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gcj&section=10-402&enactments=false | § 10-402 read |
| **Montana** | All-party by knowledge. § 45-8-213(1)(c): no recording "without the knowledge of all parties"; exception for "persons given warning of the transcription or recording" | None found | **Yes.** The line is the warning the statute names, and it names transcription | https://mca.legmt.gov/bills/mca/title_0450/chapter_0080/part_0020/section_0130/0450-0080-0020-0130.html | § 45-8-213 read |
| **New Hampshire** | All-party. RSA 570-A:2 | None found | **Yes**, if the statute reads as remembered | https://gc.nh.gov/rsa/html/LVIII/570-A/570-A-2.htm | **Unverified this session**: four sources returned 403 or 404. Action: open RSA 570-A:2 II and confirm "all parties … prior consent" |
| **Connecticut** | Phone recording: civil. § 52-570d(a) permits recording only with (1) prior consent of all parties, in writing or "obtained at the start of the recording" as part of it; (2) "verbal notification which is recorded at the beginning and is part of the communication"; or (3) a tone every fifteen seconds. (c): civil action for damages, costs and attorney's fees. Criminal statutes are one-party | None found | **Open.** The line is the verbal notification, and it is captured in the transcript the clinic is emailed (healdesk keeps none since 13 October 2026), but the statute says "recorded". Same questions as Washington: is live transcription without audio a recording, and is a transcript line the recorded notification | https://codes.findlaw.com/ct/title-52-civil-actions/ct-gen-st-sect-52-570d.html (mirror); official: https://www.cga.ct.gov/current/pub/chap_925.htm | § 52-570d read on a mirror (cga.ct.gov certificate error) |
| **Michigan** | MCL § 750.539c: no device "to eavesdrop upon the conversation without the consent of all parties"; *Sullivan v. Gray* (1982) lets a participant record. The exposure is the vendor as a non-participant | None found | **Yes** with notice | https://codes.findlaw.com/mi/chapter-750-michigan-penal-code/mi-comp-laws-750-539c.html (mirror) | § 750.539c read on a mirror (legislature.mi.gov returned 403). *Sullivan* not re-read |
| **Nevada** | NRS 200.620(1) permits interception only with "the prior consent of one of the parties" and an emergency or court order; *Lane v. Allstate*, 114 Nev. 1176 (1998) reads it as requiring every party's consent to a participant's own recording. In-person: one-party (NRS 200.650) | None found for this use. Nevada's consumer health data law (SB 370, 2023) applies to clinics outside HIPAA | **Yes**, on the notice-and-continue reading | https://codes.findlaw.com/nv/title-15-crimes-and-punishments/nv-rev-st-200-620.html (mirror); official: https://www.leg.state.nv.us/NRS/NRS-200.html | § 200.620 read on a mirror (leg.state.nv.us returned 403). *Lane* not re-read |
| **Oregon** | Phone: one-party. ORS 165.540(1)(a): a telecommunication may be obtained with consent of "at least one participant". In-person: all participants "specifically informed" ((1)(c)) | Companion-chatbot law (SB 1546, from 1 Jan 2027) does not reach a booking assistant | **Yes** | https://oregon.public.law/statutes/ors_165.540 (mirror) | § 165.540 read on a mirror. SB 1546 from secondary sources |
| **Delaware** | Conflicting sections: 11 Del. C. § 2402(c)(4) is one-party ("where one of the parties … has given prior consent"); § 1335(a)(4) bans intercepting "without the consent of all parties". Treat as all-party | None found | **Yes**, treating it as all-party with notice | https://delcode.delaware.gov/title11/c024/sc01/index.html ; https://delcode.delaware.gov/title11/c005/sc07/index.html | Both sections read |
| **Utah** | One-party. § 77-23a-4(7)(b): lawful where "one of the parties to the communication has given prior consent" | **AI Policy Act**, Utah Code Title 13, ch. 77 (as amended by SB 226, from 7 May 2025): a person in a regulated occupation (licensed health professions included) must disclose generative AI in a "high-risk" interaction, which includes collecting health information; verbally at the start of an oral exchange, and by electronic message before a written exchange. Consumers generally: disclose when asked | **Voice: yes. Web chat: yes**, the line shows before the visitor types. **Meta: Open**, the patient writes first, so a disclosure "before" the written exchange can only come from the account's own greeting or profile text (see decision 6) | https://codes.findlaw.com/ut/title-77-utah-code-of-criminal-procedure/ut-code-sect-77-23a-4.html (mirror); ch. 77: https://le.utah.gov/xcode/Title13/Chapter77/13-77.html | § 77-23a-4 read on a mirror. **Chapter 77 text not retrieved** (the Legislature's site did not render); the summary is from secondary sources. Action: read 13-77 on le.utah.gov before the first Utah clinic |
| **Colorado** | One-party | SB 24-205's "interacting with AI" disclosure never took effect: enforcement was stayed by a federal magistrate on 27 Apr 2026 and **SB 26-189** (signed 14 May 2026, effective 1 Jan 2027) repealed and re-enacted the law around automated decision-making technology for consequential decisions, with no general AI-interaction disclosure | N/A. A booking assistant makes no consequential decision | https://leg.colorado.gov/bills/sb26-189 | SB 26-189 read on the General Assembly's site. The stay from secondary sources |
| **Maine** (not a target) | One-party | **P.L. 2025, c. 294** (LD 1727, from 24 Sep 2025): no AI chatbot in trade and commerce "in a manner that may mislead or deceive a reasonable consumer into believing" they are engaging with a human unless notified "in a clear and conspicuous manner"; a violation of the Unfair Trade Practices Act | **Yes** | https://legislature.maine.gov/legis/bills/display_ps.asp?LD=1727&snum=132 | Statute text from the Legislature's bill page summary and the Governor's release; the chaptered PDF did not render this session |

Not in the table: the District of Columbia and the remaining states are
one-party for calls and have no AI-disclosure statute found for this use.
The product announces on every call regardless.

## Decisions on the lines, and recommendations not yet adopted

1. **The opening lines above are adopted** (owner, 1 Oct 2026). The old
   "to reach a person" promised a live transfer the default configuration
   does not make; the new line promises a handover and a call back by the
   practice. Two residual points. (a) "Who will get back to you within a
   day" is a promise made on the clinic's behalf; the terms should make it
   the clinic's duty (§ 8: respond to handover requests by the end of the
   next business day) and the portal should show open handovers, otherwise
   the FTC Act's deception standard is met by the assistant's own words.
   (b) "I'll pass you to the practice team" can be heard as a transfer;
   "I'll pass your details to the practice team" cannot. Recommended, not
   adopted.
2. **"No audio recording is kept" must be true before the first call.**
   The voice vendor documents per-agent retention from one day to two years
   and per-agent storage controls (https://docs.retellai.com/general/compliance).
   The line is true only with recording storage off on every agent,
   verified by screenshot (risk analysis T5). A disclosure that understates
   what happens is worse than none.
   **Changed 22 October 2026 (owner).** The owner reversed the storage-off
   setting on 21 October 2026: Retell now holds a call's transcript, and with
   it the recording, until healdesk has its own copy of the transcript, then
   healdesk deletes the call there, and Retell's own retention for anything
   left is one day. The line therefore no longer says "no audio recording is
   kept". It says that healdesk keeps no audio and that the providers hold a
   recording for no more than a day (`voiceDisclosure()`, its Spanish mirror
   and the written notice in decision 8). Counsel has not reviewed the new
   wording.
3. **Washington and Connecticut: the record of the announcement.** Decision:
   the disclosure is written into the transcript verbatim with its timestamp
   (`disclosure_played_at`), the fixed audio asset the line is synthesised
   from is retained with its version, and the vendor's call log shows the
   line played. That is the best record a no-audio design can produce.
   Whether it satisfies "said announcement shall also be recorded" and
   "recorded at the beginning" is an open risk (Review log R1).
   **Changed 13 October 2026.** The owner decided that day that healdesk
   keeps no transcript: each call's transcript is emailed to the clinic when
   the call ends, and healdesk's one encrypted copy is deleted seven days
   after the email goes (BAA 1.4.0, clause 11; agreement-changes.md § 14).
   So the record healdesk holds is `conversations.disclosure_played_at`, kept
   on the conversation's 90-day record clock, with the fixed audio asset and
   the vendor's call log; the transcript line, where the transcript carries
   it, is in the clinic's own email, not with healdesk. No clause of BAA
   1.3.0 or 1.4.0 relies on a stored transcript as the record (both say only
   that the line is given and cannot be switched off), and the Terms annex
   no longer calls the line "the first line of every transcript"
   (LEGAL_VERSION 2026-10-13.3). Since 14 October 2026 (BAA 1.5.0;
   agreement-changes.md § 15) healdesk's copy is deleted as soon as the
   clinic's mail server confirms delivery, never later than 30 days after it
   was queued, so this record is unchanged and the transcript line is only
   ever in the clinic's own email. Whether a timestamp and a fixed asset
   are "the announcement recorded" is part of R1.
4. **California § 631 after *Ambriz*.** The court's test was whether the
   vendor *can* use call content for its own purposes. The defence is the
   Retell and Anthropic agreements forbidding it, kept in writing by version
   (`counsel-audit.md` § 2), plus the fact that both are the clinic's agents
   through us rather than strangers to the call. Recommended, not adopted:
   add three words so the caller is told a third party is involved,
   "transcribed by an automated system run by our service providers".
5. **A closing line for AB 3030.** The product is not meant to discuss
   clinical information, but callers ask about downtime and aftercare and
   the pivot to a consultation is close to the line. "This was {clinic}'s AI
   assistant. To reach the practice team, call {direct line}." at every
   call end removes the question at no cost and gives the "how to reach a
   human" element. Recommended, not adopted.
6. **Meta channels cannot disclose first.** The patient writes before the
   assistant says anything. Decision: the wizard sets the Messenger greeting
   text and Instagram ice-breaker text to the AI disclosure where Meta's
   APIs allow it, and the WhatsApp business profile description states it;
   the assistant's first reply still opens with the disclosure. Utah's
   "before the written exchange" remains open for WhatsApp (Review log R3).
7. **The greeting field.** The fixed disclosure plays before the clinic's
   greeting and cannot be edited out (spec). Recommended: validate the
   greeting against a human name presented as the speaker ("Hi, this is
   Sarah") and against professional titles, so a clinic cannot undo AB 489
   or the "not a human" statement one line later.
8. **The written notice template.** Texas § 552.051(d) says the disclosure
   "must be written in plain language"; Utah wants written disclosure
   before a written exchange; AB 3030 wants the disclaimer in writing for
   written communications. Decision: healdesk gives every clinic a short
   plain-language notice for its website and intake form ("{clinic} uses an
   AI assistant to answer calls and messages and to book appointments. It is
   not a person and gives no medical advice. Calls it answers are
   transcribed, and its provider holds any recording for no more than a day.
   To reach a person, call {direct
   line}."), and the terms keep the duty where it is: § 8 "Your own
   notices". The notice is a convenience, not a warranty that it satisfies
   any state.
9. **No state matrix in the product.** The line plays on every call and
   opens every chat. Nothing routes by area code.
10. **The voice line shortened (owner, 23 October 2026).** After test calls
   in which callers said "hello?" into the 75-word opener, the owner cut it
   to the facts the statutes need: an AI assistant, transcribed by our
   service providers, no audio kept by healdesk and the provider's recording
   held a day at most. Removed: "not a human" ("the AI assistant" says it,
   which is what every AI-disclosure statute in the table asks); the "say
   representative" handover line (a caller who asks for a person still gets
   the handover, and the transcript email shows it, but the opener no longer
   offers one before AYA has tried to help); and "an automated system run
   by", keeping "by our service providers" for decision 4. Decision 1's
   residual point (a) now applies to the handover AYA offers during the call,
   not to the opener. The Spanish line changed with it. Counsel has not
   reviewed the new wording.

## Review log (2026-10-01)

Adversarial pass on the draft table of 1 October 2026. Finding → fix applied.

- **Rows rested on aggregators.** Twelve of twenty rows cited
  recordinglaw.com or Wikipedia and nothing else. → Every row now cites the
  statute. The recording statute was read on the legislature's site or an
  exact mirror for 17 of the 20 rows; Massachusetts and New Hampshire could
  not be reached and Maine rests on the Legislature's bill page, each marked
  with the action that verifies it; within Utah's row the AI statute's text
  (ch. 77) was not retrieved; Florida's SB 482 status is from the official
  bill page as reported in search results.
- **New York was mis-stated.** The draft cited §§ 250.00/250.05 as one-party
  without the words; the wiretapping definition reads "without the consent
  of either the sender or receiver", which is one-party, and the S7263
  status had moved: amended on third reading 26 May 2026, committed to Rules
  5 Jun 2026, not enacted. → Corrected.
- **Texas TRAIGA was summarised as "a health care provider must disclose";
  the enrolled text is narrower and wider at once.** The trigger is an AI
  system "used in relation to health care service or treatment", the duty
  falls on "the provider of the service or treatment", and the format rule
  says "must be written in plain language". → Row rewritten from the
  enrolled bill; the written-form point now drives decision 8.
- **Colorado's replacement law was described as having no disclosure duty.**
  SB 26-189 does impose point-of-interaction notices, but only on deployers
  of automated decision-making technology for consequential decisions,
  which a booking assistant does not make. → Row corrected; still N/A.
- **Nevada's statute was described as all-party on its face.** It is not:
  § 200.620(1) speaks of "one of the parties"; the all-party result comes
  from *Lane v. Allstate*. → Row says so, and marks *Lane* as not re-read.
- **Washington's row did not quote the proviso.** → Quoted from RCW
  9.73.030(3); the evidence design is now decision 3.
- **Connecticut's row said the statute was not read.** → Read via a mirror;
  the three permitted methods are quoted; the open point is sharper.
- **Utah's row cited a Justia page for § 13-77-103 without the text.** →
  Marked unverified with the action; the recording statute was verified.
- **The "Findings that change the wording" section proposed a new line.**
  The owner has since decided the lines. → Replaced by decisions and
  clearly labelled recommendations, so nobody mistakes a proposal for the
  shipped text.
- **The promise "within a day" was not examined.** → Decision 1(a): a
  clinic duty in the terms and a portal view, or the assistant is making a
  promise nobody is bound to keep.
- **Residual risks.** **R1** Washington and Connecticut: a transcript line
  may not be "the announcement recorded", and since 13 October 2026
  healdesk holds no transcript line at all, only `disclosure_played_at`, the
  fixed audio asset and the vendor's call log (decision 3). Mitigation:
  decision 3. Trigger for a lawyer: the first clinic in either state, before
  its voice channel goes live. **R2** California § 631: a vendor's capability to use content
  is the test in *Ambriz*; the three-word addition in decision 4 is the
  cheapest further step. Trigger: a CIPA demand letter, or the owner's
  decision to adopt the words. **R3** Utah on WhatsApp: no mechanism puts a
  disclosure before the patient's first message. Trigger: the first Utah
  clinic connecting WhatsApp; mitigation is the profile text and the
  written notice. **R4** Texas TRAIGA scope: unsettled whether scheduling is
  "in relation to health care service or treatment". Trigger: the first
  Texas clinic; mitigation is the written notice and the clinic's § 8 duty.
  **R5** Florida and Pennsylvania implied-consent case law not checked.
  Trigger: the first clinic in either state. **R6** Massachusetts and New
  Hampshire statute text not retrieved. Trigger: before the first clinic in
  either, open the statute (one action each, named in the rows).
