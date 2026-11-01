# docs/counsel

The legal position of healdesk v1, as adopted by the owner on 1 October 2026
without external counsel review. Not legal advice.

## What is here

| File | What it is |
| --- | --- |
| [brief.md](./brief.md) | One page: the decisions taken, and every open risk with its owner, mitigation and the trigger that would force a lawyer's engagement. Start here |
| [guarantee-and-refund.md](./guarantee-and-refund.md) | The first-month guarantee: the decisions, the adopted text, how it sits with the 14-day refund and terms §§ 3, 5, 12, 13 and 19, and how it may be advertised |
| [dpa.md](./dpa.md) | The Data Protection Agreement for practices HIPAA does not cover (`dpa/1.0.0`, drafted 6 October 2026, released by the owner on 20 October 2026 without external counsel, with its calendar election form): who signs it, how it is built, every sentence that rests on a code fact and where, the gaps found, and its open questions |
| [agreement-changes.md](./agreement-changes.md) | BAA 1.2.0 checked against 45 CFR 164.504(e) and 164.314(a), clause by clause with the fixes the next version needs; the terms and privacy page; the subprocessor position as verified against the vendors' own pages; the one Meta rule; the state-law clause for clinics outside HIPAA |
| [state-disclosure.md](./state-disclosure.md) | The AI-disclosure and call-transcription consent position, state by state, each row checked against the statute where it could be reached and marked where it could not |

Each file ends with a **Review log** dated 2026-10-01: the findings of an
adversarial pass, the fix applied to each, and the residual risks.

## The no-external-counsel decision

The owner decided on 1 October 2026 to adopt these documents, publish BAA
1.2.0 and the rewritten terms, and launch without a lawyer's review. The
adversarial pass that produced these documents found five factual defects
in 1.2.0 the same day, before any clinic had signed it; 1.2.1 corrected
them. On 9 October 2026 the owner released 1.2.2, 1.2.1 with three changes
(the subcontractor list on request, hello@healdesk.io as the only email
address, the spec's 60-day breach wording; `agreement-changes.md` § 13),
again before any clinic had signed. On 12 October 2026 the owner released
1.3.0, the calendar-dependent version, with the calendar election, after
Claude's own audit of the full text against the code (`agreement-changes.md`
§ 12.15), and again before any clinic had signed, so 1.3.0 replaced 1.2.2
outright. On 13 October 2026 the owner decided that healdesk keeps no
transcript (each is emailed to the practice when its conversation ends) and
released 1.4.0, which is 1.3.0 with its transcript passages said that way
(`agreement-changes.md` § 14), on the owner's own instruction and without
external counsel; no clinic had signed 1.3.0, so 1.4.0 replaced it
outright, and § 14 recommends that counsel review it. On 14 October 2026
the owner decided that a transcript's encrypted copy is deleted the moment
delivery is confirmed (kept and sent again until it is, but never past 30
days) and released 1.5.0, which is 1.4.0 with that said in clauses 11 and
14 (`agreement-changes.md` § 15), on the owner's own instruction and
without external counsel; no clinic had signed 1.4.0, so 1.5.0 replaced it
outright, and § 15 recommends that counsel review it. On 19 October 2026
the owner decided that the agreement says what the website chat asks for:
the optional booking details (a last name, the service, new or returning,
consultation or treatment, a practitioner), which 1.5.0 said are asked only
on a call. The owner released 1.5.1, which is 1.5.0 with clause 11's items
(b) and (c) saying "on a call or in a website chat" (`agreement-changes.md`
§ 16), on the owner's own instruction and without external counsel; no
clinic had signed 1.5.0, so 1.5.1 replaced it outright: it is the only
version offered (`docs/baa-v1.5.1.txt`) and the go-live floor, and § 16
recommends that counsel review it. The same day BAA 1.6.0 was drafted, not
released: 1.5.1 with Anthropic's retention said as Anthropic's
documentation says it for the models the product calls, correcting finding
A3's misquote (`agreement-changes.md` § 17, `docs/baa-v1.6.0.txt`); its
`approvedByCounsel` was false until the owner released it on 29 October
2026, without external counsel (`agreement-changes.md` § 17): since then
1.6.0 is the only version offered and the go-live floor, and 1.5.1 is
frozen below it. On 30 October 2026 the owner released BAA 1.7.0 and DPA
1.2.0, without external counsel: both report a breach or incident in no case
later than 10 calendar days after discovery and give 15 days' notice of a new
subcontractor, and the DPA carries the payment-link text exception
(`agreement-changes.md` § 22). 1.7.0 is the only BAA offered and the go-live
floor; 1.6.0 is frozen below it. On 20 October
2026 the owner released the Data Protection Agreement (`dpa/1.0.0`), which
a veterinary practice and a practice that answers "No" to billing health
insurance electronically sign in place of the BAA, with its own calendar
election form (`calendar-election-dpa/1.0.0`), on the owner's own
instruction and without external counsel (`agreement-changes.md` § 18,
`dpa.md`, `docs/dpa-v1.0.0.txt`); counsel approved its clauses as they
stood on 6 October 2026, not the edits since, and § 18 recommends that
counsel review it before the first live DPA practice. The
reasoning: no clinic is live and no real patient data has been processed;
the regulatory skeleton of the BAA is checkable against the text of 45 CFR
164.504(e) and was checked; the open points that a lawyer would settle are
mostly questions about enforcement and platform policy that reasoning cannot
close and that no clinic yet raises; and each of those points has a named
trigger in `brief.md` at which a lawyer is engaged, state by state or
counterparty by counterparty, instead of up front.

**The decision is permanent (owner, 30 October 2026: "I won't hire a
lawyer").** The triggers in `brief.md` no longer promise that a lawyer will
be engaged. Each one marks the point where the owner looks at that risk
again. The same day, the owner declined liability insurance for now and a
separate US agent for service of process, and confirmed that the trade
licence, Meta's healthcare rule and call-transcription consent are covered
(`brief.md`, "Decisions taken (30 October 2026)").

What that decision costs, stated plainly: the documents were drafted and
reviewed by an AI assistant, not a licensed attorney. A defect in the BAA
makes both healdesk and the clinic non-compliant. Several statutes in the
state table could not be read on the state's own site this session and are
marked as unverified with the one action that would verify each. The
`approvedByCounsel` flag in `packages/catalog/src/baa.ts` is set true for
1.5.1 (and the superseded 1.5.0, 1.4.0, 1.3.0, 1.2.2, 1.2.1 and 1.2.0) on the owner's own
review, and its doc comment says so; the same flag in
`packages/catalog/src/dpa.ts` is true for `dpa/1.0.0` since 20 October 2026,
on the owner's own instruction, and says so too.

## Rules for this folder

- Every claim about a law or a vendor's terms cites the primary source it
  rests on, with the URL, and says whether the source was read or only
  reported. A row or sentence that could not be verified says so.
- A decision is recorded with its basis. A question that reasoning cannot
  settle is recorded as an open risk with an owner, a mitigation and a
  trigger, never as a bare question.
- `docs/v1-product-spec.md` decides what the product does. Where a document
  here or elsewhere disagrees with it about the product, the spec wins and
  the document is wrong.
- Nothing here edits a released agreement text. A change to the BAA is a new
  version in `baa.ts`; a change to the terms bumps `LEGAL_VERSION` in
  `apps/web/src/lib/legal.ts`.
- Superseded analysis lives in `docs/counsel-audit.md` (21–29 September
  2026), kept so the reasoning survives.
