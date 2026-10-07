# docs/counsel

The legal position of healdesk v1, as adopted by the owner on 1 October 2026
without external counsel review. Not legal advice.

## What is here

| File | What it is |
| --- | --- |
| [brief.md](./brief.md) | One page: the decisions taken, and every open risk with its owner, mitigation and the trigger that would force a lawyer's engagement. Start here |
| [guarantee-and-refund.md](./guarantee-and-refund.md) | The first-month guarantee: the decisions, the adopted text, how it sits with the 14-day refund and terms §§ 3, 5, 12, 13 and 19, and how it may be advertised |
| [dpa.md](./dpa.md) | The Data Protection Agreement for practices HIPAA does not cover (`dpa/1.0.0`, drafted 6 October 2026, unreleased): who signs it, how it is built, every sentence that rests on a code fact and where, the gaps found, and its open questions |
| [agreement-changes.md](./agreement-changes.md) | BAA 1.2.0 checked against 45 CFR 164.504(e) and 164.314(a), clause by clause with the fixes the next version needs; the terms and privacy page; the subprocessor position as verified against the vendors' own pages; the one Meta rule; the state-law clause for clinics outside HIPAA |
| [state-disclosure.md](./state-disclosure.md) | The AI-disclosure and call-transcription consent position, state by state, each row checked against the statute where it could be reached and marked where it could not |

Each file ends with a **Review log** dated 2026-10-01: the findings of an
adversarial pass, the fix applied to each, and the residual risks.

## The no-external-counsel decision

The owner decided on 1 October 2026 to adopt these documents, publish BAA
1.2.0 and the rewritten terms, and launch without a lawyer's review. The
adversarial pass that produced these documents found five factual defects
in 1.2.0 the same day, before any clinic had signed it; 1.2.1 corrected
them and is the version offered (`docs/baa-v1.2.1.txt`). The
reasoning: no clinic is live and no real patient data has been processed;
the regulatory skeleton of the BAA is checkable against the text of 45 CFR
164.504(e) and was checked; the open points that a lawyer would settle are
mostly questions about enforcement and platform policy that reasoning cannot
close and that no clinic yet raises; and each of those points has a named
trigger in `brief.md` at which a lawyer is engaged, state by state or
counterparty by counterparty, instead of up front.

What that decision costs, stated plainly: the documents were drafted and
reviewed by an AI assistant, not a licensed attorney. A defect in the BAA
makes both healdesk and the clinic non-compliant. Several statutes in the
state table could not be read on the state's own site this session and are
marked as unverified with the one action that would verify each. The
`approvedByCounsel` flag in `packages/catalog/src/baa.ts` is set true for
1.2.1 (and the superseded 1.2.0) on the owner's own review, and its doc
comment says so.

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
