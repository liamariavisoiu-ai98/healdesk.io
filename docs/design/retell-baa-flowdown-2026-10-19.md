# Retell's BAA against the clinic BAA: what does not flow down

Written 19 October 2026 against Retell's click-through BAA v3.1 (DocuSign
envelope 94E4FEDE-4C27-87E7-801B-634A9DBC19A8) and DPA v1.1 (envelope
111BB5A6-0AF7-8186-834B-BB6A9E53462E) and clinic BAA 1.4.0
(`docs/baa-v1.4.0.txt`). Retell will not change its text, so every fix is on our
side. **Draft for counsel. Not released, not wired into checkout.** Risk T19 in
[hipaa-risk-analysis.md](../hipaa-risk-analysis.md) tracks it.

## The three differences

| | Retell's BAA | Clinic BAA 1.4.0 | Gap |
| --- | --- | --- | --- |
| Where PHI goes | §3.1: may use and disclose PHI outside the United States to provide the Services | Clause 10: healdesk keeps PHI at rest only in the United States, and lets a subcontractor handle PHI only if it does the same | Yes, unless Retell confirms in writing that PHI at rest stays in the US |
| De-identification | §§3.2–3.3: may de-identify and aggregate PHI for its own purposes | Clause 8: only healdesk de-identifies, only for aggregate statistics about the Services; no PHI to train any model. Clause 13 requires each subcontractor to accept the same restrictions | Yes. A subcontractor may use PHI only as the clinic BAA lets healdesk, so granting Retell this right without the clinic's agreement breaches clause 13 |
| Incident reporting | §4.1: up to 21 business days | Clause 12: without unreasonable delay, at most 60 calendar days from discovery | No. Inside the limit, with less margin; handled in [incident-response.md](../incident-response.md) |

Retell's other terms (safeguards, subcontractor flow-down, HHS books and
records, ten-business-day help with individual rights, return or destruction at
termination) meet or sit inside what the clinic BAA promises. Clause 14's own
ten-business-day figure leaves no slack against Retell's ten, so ask Retell for
a request early.

## Options

**A. Amend the clinic BAA (the only change fully in our hands).** A new
release, in the pattern of 1.4.0 (migration, `baa-golden` and agreement-match
tests, checkout and `what-it-says.ts`, Terms and Privacy). Proposed wording
follows. Cost: clinics read that the telephony provider may process PHI abroad
and de-identify it, which some will not accept.

**B. Get Retell's US-only storage in writing, then narrow clause 10.** Email
legal@retellai.com for a statement that PHI at rest stays in the US and for the
current location of each subprocessor that touches it
(trust.retellai.com/subprocessors). That fixes (a) only. Clause 10 already says
"at rest", so no amendment is needed if the answer is yes. (b) still needs
Option A's last paragraph, or Retell's written agreement not to de-identify
Company data, which it may decline.

**C. Both.** Recommended. B costs one email and may remove the loudest term; A's
de-identification paragraph is unavoidable while Retell holds the right.

## Proposed wording (Option A), for clause 13

Add after the paragraph on language models:

> healdesk's telephony and speech provider is Retell AI, Inc. Retell receives a
> caller's speech and number, and the transcript of the call, only under a
> business associate agreement with healdesk signed before any patient's
> information reaches it. Under that agreement Retell may process PHI outside
> the United States to provide its service, and may de-identify PHI in
> accordance with 45 CFR 164.514(b) and aggregate the de-identified information
> for its own purposes. healdesk configures Retell to keep the least it can:
> call recording is off, and transcript retention and personal-information
> redaction are set to the provider's minimum, so that little is held to
> transfer or de-identify. healdesk does not permit Retell to use PHI that has
> not been de-identified to train, fine-tune or evaluate any model.

Two statements in it must be true before it ships, and neither can be checked
from here: that Retell has no right to train on identifiable PHI, which is not
in the BAA text and must come from its terms of service or an email, and that
its console settings really keep the least. Verify both and attach the
screenshots (T5).

And in clause 10, only if Retell does not confirm US-only storage (Option B),
change the first sentence to:

> healdesk keeps PHI at rest only in the United States, always encrypted,
> except where the clause headed "Subcontractors" says a named subcontractor
> may process it elsewhere.

Clause 8's last paragraph ("healdesk will not use PHI to train...") needs no
change: it binds healdesk, and the new clause 13 text states Retell's separate
position.

## Not decided here

Whether to release before the first clinic signs. The Launch plan says checkout
offers 1.5.0, but this repo holds the text only up to 1.4.0: find which version
checkout serves, and whether any clinic has signed it, before choosing. If none
has, a release can replace it outright, as 1.4.0 did for 1.3.0; if one has,
changing it means notice and re-acceptance. Counsel (step 1.14) should choose
the option and word the clause.

## What Retell's DPA (v1.1) changes

It does not close either gap. It applies only "to the extent such Processing is
subject to Data Protection Laws" (§2.2) and the CCPA exempts PHI, so its bar on
selling, sharing or combining data (Schedule 4 §A) protects the owner contacts
on demo calls, not patient data. It repeats that Retell may process data
"globally" (§11.1).

What it adds, and what to do with it:

- **48-hour incident notice** (§5.2), against 21 business days in the BAA.
  Whether it reaches PHI is unconfirmed: ask (below).
- **Subprocessor changes** are announced only by editing the web list, 15 days
  before, with a 10-day window to object (§4.3–4.4). Someone must read
  trust.retellai.com/subprocessors at least every 10 days. Clinic BAA clause 13
  gives clinics notice before a PHI subprocessor is added.
- **Backups** may be kept under Retell's own policy, with no stated period
  (§8.2); the clinic BAA says a backup of anything healdesk deletes expires
  within 35 days.
- **Audit** is by SOC 2 Type II report only (§9.3): request it and file it.
- **Liability** follows the cap in Retell's SaaS agreement (§10), which is not
  in the file. Compare it with the clinic BAA's liability clause before the
  first clinic goes live.
- Schedule 1 lists healdesk as controller of business contacts, with the
  address and activities blank. It describes the demo calls, not patients.

## Email to Retell (legal@retellai.com, copy support@retellai.com)

> Subject: VIIXI FZC (healdesk.io): confirmations on the BAA and DPA signed 19 October 2026
>
> We signed Retell's Business Associate Agreement (v3.1) and Data Processing
> Addendum (v1.1) on 19 October 2026 and would like written answers to five
> questions, for our records:
>
> 1. Is protected health information at rest, including transcripts, stored
>    only in the United States, and which subprocessors on
>    trust.retellai.com/subprocessors handle PHI, and where?
> 2. Does the 48-hour incident notice in DPA §5.2 apply to PHI, or only the 21
>    business days in BAA §4.1? Will notices state the date Retell discovered
>    the incident?
> 3. Does Retell use PHI that has not been de-identified, including
>    transcripts, to train or improve any model? Can the de-identification
>    and aggregation in BAA §§3.2–3.3 be switched off for our account?
> 4. How long do backups containing deleted data persist?
> 5. Please send your current SOC 2 Type II report and a copy of the SaaS
>    agreement (the "Agreement") our account is bound by.
>
> Thank you,
> Thomas Bruneau, Founder, VIIXI FZC
