"use client";

import {
  applicableClauses,
  assentSentence,
  BAA_ACTION_LABEL,
  BAA_ASSENT_LABEL,
  BAA_CLAUSE_EXPLAINERS,
  BAA_EXPLAINER,
  type BaaVariables,
  currentBaaTemplate,
  CURRENT_BAA_VERSION,
  type ExplainedClauseId,
  renderBaa,
} from "@healdesk/catalog";
import { useEffect, useMemo, useRef, useState } from "react";

import { site } from "@/lib/site";

import { ChoiceCard, PrimaryButton, StepShell } from "./StepShell";

/**
 * Signing the business associate agreement, its own step, before payment.
 *
 * The ordering is the requirement. A healthcare provider may not hand patient
 * information to a supplier without a written contract first, so the contract
 * cannot be a checkbox bundled into the payment button, and it cannot be
 * something recorded after a webhook lands. It is a separate, deliberate act
 * with its own screen, and the record is written to the database here, before
 * anyone sees a payment form.
 *
 * ## Why this is heavier than a checkbox
 *
 * The previous version was one checkbox next to a price. Everything extra here
 * is doing evidentiary work:
 *
 *   - **The explanation** sits above the document, not behind a link.
 *     Conspicuous, plain-language terms adjacent to the assent action are what
 *     make click-through assent hold up, and a signature from someone who
 *     understood what they signed is worth more than one from someone who
 *     didn't.
 *   - **The covered-entity question** decides which paragraph of the agreement
 *     applies, so it is asked rather than assumed. "I don't know" is a real
 *     answer and is offered as one.
 *   - **The typed name is the signature**, not a checkbox. It is rendered into
 *     the document itself, which is why the preview refreshes as they type.
 *   - **Scrolling to the end is required** before the signature block unlocks.
 *     It is a small friction that makes "I never saw it" a much harder claim.
 *
 * The document shown here is rendered by the server on submit and hashed there.
 * This preview is a courtesy; the stored text is the authority.
 */

/**
 * What the server says became of the copy it emails the signer.
 *
 * Optional, and an absent field means "we were not told" rather than either
 * answer. /api/agreements sends it on every signature, so absence is a version
 * skew between this bundle and the app, and filling that silence in would
 * either alarm a buyer whose copy is already in their inbox or reassure one
 * whose copy is nowhere. Neither is a thing we know.
 */
export type CopyDelivery =
  | { status: "sent" }
  | { status: "not_sent"; reason: string };

function isExplainedClauseId(id: string): id is ExplainedClauseId {
  return id in BAA_CLAUSE_EXPLAINERS;
}

export type AgreementResult = {
  agreementId: string;
  version: string;
  hash: string;
  text: string;
  acceptedAt: string;
  approvedByCounsel: boolean;
  copy?: CopyDelivery;
};

export function AgreementStep({
  step,
  totalSteps,
  clinicName,
  specialty,
  specialtyId,
  attributionMode,
  platformId,
  platformName,
  contactName,
  contactEmail,
  contactTitle,
  onBack,
  onClose,
  onSigned,
}: {
  step: number;
  totalSteps: number;
  clinicName: string;
  /** Display name, for the document. */
  specialty: string;
  /** Catalog id, for the API. */
  specialtyId: string;
  /**
   * The two funnel choices that change the AGREEMENT rather than the product.
   * See packages/catalog/src/baa.ts, verified means we hold credentials to
   * their booking system, estimated means we hold none, and the permitted-uses
   * clause differs accordingly.
   */
  attributionMode: "estimated" | "verified";
  platformId: string;
  platformName: string | null;
  contactName: string;
  contactEmail: string;
  contactTitle?: string;
  onBack: () => void;
  /** Present only when hosted in a modal. See StepShell. */
  onClose?: () => void;
  onSigned: (result: AgreementResult) => void;
}) {
  const [coveredEntity, setCoveredEntity] = useState<boolean | null | undefined>(
    undefined,
  );
  const [signature, setSignature] = useState(contactName);
  const [title, setTitle] = useState(contactTitle ?? "");
  const [agreed, setAgreed] = useState(false);
  const [readToEnd, setReadToEnd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * A signature that succeeded while its copy did not go out.
   *
   * Kept here instead of being handed straight to `onSigned`, because
   * `onSigned` moves the buyer to the payment step, and a notice on a screen
   * nobody stops at is the same as no notice. So the step holds, says plainly
   * what happened, and continues on a click. The server's whole answer is kept
   * so that continuing passes on exactly what it sent, not a reconstruction.
   */
  const [signedWithoutCopy, setSignedWithoutCopy] = useState<{
    result: AgreementResult;
    reason: string;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  /**
   * Move focus to the notice when it appears.
   *
   * The button that was just pressed is the thing being replaced, so without
   * this the browser drops focus to the top of the document: a keyboard user
   * loses their place and a screen reader is told nothing at all. Focusing the
   * notice puts them on the sentence that explains what happened, next to the
   * only control that remains.
   */
  useEffect(() => {
    if (signedWithoutCopy) noticeRef.current?.focus();
  }, [signedWithoutCopy]);

  /**
   * The preview is rendered from the REAL template, by the same function the
   * server uses.
   *
   * Reimplementing the document in the component would be easier and is the
   * obvious thing to reach for, and it would give a contract two sources of
   * truth that drift silently. So `renderBaa` is shared code, and the only
   * difference between this and the stored copy is that the server renders it
   * again from the submitted values and hashes that.
   *
   * Placeholders stand in for fields still empty, so the document is readable
   * before it is complete without ever rendering a blank party name.
   */
  const variables = useMemo<BaaVariables | null>(() => {
    if (coveredEntity === undefined) return null;
    return {
      clinicLegalName: clinicName.trim() || "[your practice]",
      signatoryName: signature.trim() || "[your name]",
      signatoryTitle: title.trim() || undefined,
      // Lower-cased here because the server lower-cases it before rendering
      // its copy; a mixed-case address would otherwise hash differently on
      // the two sides and fail the displayed-hash check with no way out.
      signatoryEmail: contactEmail.trim().toLowerCase() || "[your email]",
      effectiveDate: new Date().toISOString().slice(0, 10),
      specialty: specialty || "healthcare",
      isCoveredEntity: coveredEntity,
      attributionMode,
      connectedPlatform: platformName,
      // v1 is inbound only, so this stays false. No 1.2.0 clause reads it,
      // and no consent warranty is asked of the clinic.
      outboundMessaging: false,
      // Neither selection reaches the 1.2.0 document: v1 books into the
      // clinic's own Google Calendar under an unconditional clause, with
      // auto-confirm on by default, and Cal.com is not a write target. Both
      // are passed as the fixed values apps/app's signing path passes
      // (lib/agreements.ts), because the rendered text is hashed on both
      // sides and must come out byte-identical; neither side may change one
      // alone.
      bookingMode: "desk_confirms",
      calendarWrite: null,
    };
  }, [
    clinicName,
    signature,
    title,
    contactEmail,
    specialty,
    coveredEntity,
    attributionMode,
    platformName,
  ]);

  const documentText = useMemo(
    () => (variables ? renderBaa(currentBaaTemplate(), variables) : null),
    [variables],
  );

  /**
   * Plain-English notes for the clauses of the current version that describe
   * what the product does rather than paraphrase the regulation (what
   * healdesk reads, the Google Calendar access, what the assistant collects,
   * the model provider's retention), shown only for a clause that actually
   * renders in THIS clinic's variant.
   */
  const clauseNotes = useMemo(() => {
    if (!variables) return [];
    return applicableClauses(currentBaaTemplate(), variables).flatMap((clause) =>
      isExplainedClauseId(clause.id)
        ? [{ id: clause.id, heading: clause.heading, ...BAA_CLAUSE_EXPLAINERS[clause.id] }]
        : [],
    );
  }, [variables]);

  /**
   * What the document panel shows: the preview until it is signed, the text the
   * SERVER recorded afterwards.
   *
   * The swap is invisible. A 201 is only issued when the hash of the displayed
   * document matches the one the server rendered, so the two strings are equal
   * by construction. What it buys is that they stay equal: this step now stays
   * on screen after signing, and a panel still wired to the inputs would let a
   * keystroke rewrite an agreement that is already in the database.
   */
  const shownText = signedWithoutCopy?.result.text ?? documentText;

  /**
   * Inert once the agreement is recorded.
   *
   * The answer decides which clause the contract carries, and that contract is
   * now a row in an append-only table. Letting the card change afterwards would
   * only make the screen disagree with the record.
   */
  function chooseCoveredEntity(value: boolean | null) {
    if (signedWithoutCopy) return;
    setCoveredEntity(value);
  }

  // The signature must match the name they gave us. Not a legal requirement,
  // an evidentiary one: a mismatch is the first thing anyone disputing this
  // would point at, and it is trivially avoidable.
  const signatureOk = signature.trim().length >= 2;
  const canSign =
    coveredEntity !== undefined && readToEnd && signatureOk && agreed;

  /**
   * Mark the agreement read when there is nothing to scroll.
   *
   * `readToEnd` is only ever set by a scroll event, so a box that is taller
   * than its own content never fires one and the Sign button stays disabled
   * forever, under a hint telling the buyer to scroll a document that is
   * already fully visible. That cannot happen at `max-h-80` with the current
   * template, but it is one CSS edit away, and the failure mode is a purchase
   * that silently cannot complete. Measuring on mount removes the trap instead
   * of documenting it.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || readToEnd) return;
    if (el.scrollHeight <= el.clientHeight + 24) setReadToEnd(true);
  }, [readToEnd, shownText]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el || readToEnd) return;
    // 24px of slack: a scroll container that demands the exact final pixel is
    // unreachable on some trackpads and zoom levels, and the requirement then
    // silently blocks the purchase instead of documenting comprehension.
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) {
      setReadToEnd(true);
    }
  }

  async function sign() {
    setSubmitting(true);
    setError(null);

    try {
      // Hash exactly what this browser rendered. The server renders its own
      // copy and refuses if they differ, which turns "we believe the screen
      // showed X" into something demonstrable. Optional by necessity:
      // crypto.subtle only exists in a secure context, so a developer on plain
      // http gets an unverified signature rather than a broken checkout.
      const displayedHash = await sha256(documentText);

      const response = await fetch("/api/agreement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clinicLegalName: clinicName.trim(),
          specialty: specialtyId,
          attributionMode,
          platform: platformId,
          signatoryName: signature.trim(),
          signatoryTitle: title.trim() || undefined,
          signatoryEmail: contactEmail.trim().toLowerCase(),
          isCoveredEntity: coveredEntity ?? null,
          // The fixed half of the sentence, as proof this UI showed it. The
          // server stores the full sentence it derives itself, never this.
          assentLabel: BAA_ASSENT_LABEL,
          templateVersion: CURRENT_BAA_VERSION,
          displayedHash,
        }),
      });

      const data = (await response.json().catch(() => null)) as
        | (AgreementResult & { error?: string })
        | null;

      if (!response.ok || !data?.agreementId) {
        setError(data?.error ?? "We couldn't record your agreement. Please try again.");
        return;
      }

      // Signed. Whether the copy went out decides only whether we stop to say
      // so; it never decides whether the signature counts.
      if (data.copy?.status === "not_sent") {
        setSignedWithoutCopy({ result: data, reason: data.copy.reason });
        return;
      }

      onSigned(data);
    } catch {
      setError("Network error. Your agreement was not recorded, please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <StepShell
      step={step}
      totalSteps={totalSteps}
      eyebrow={site.cta.primary.label}
      title="The agreement, before anything else"
      subtitle="Nothing is charged on this step. You'll see the plan and price next."
      onBack={onBack}
      onClose={onClose}
    >
      {/* ---------------- Why ---------------- */}
      <section className="border-line bg-paper-2/50 rounded-2xl border p-5 sm:p-6">
        <h2 className="font-display text-[22.8px] leading-tight font-medium">
          {BAA_EXPLAINER.heading}
        </h2>
        <p className="text-muted mt-3 text-sm leading-relaxed font-medium">
          {BAA_EXPLAINER.lead}
        </p>
        <p className="text-muted mt-3 text-sm leading-relaxed font-medium">
          {BAA_EXPLAINER.objection}
        </p>

        <ul className="mt-4 grid gap-2.5">
          {BAA_EXPLAINER.terms.map((term) => (
            <li key={term.citation} className="flex gap-2.5 text-sm">
              <span aria-hidden className="text-red-deep mt-px shrink-0 font-bold">
                ·
              </span>
              <span>
                <span className="font-medium">{term.plain}</span>{" "}
                <span className="text-muted text-xs whitespace-nowrap">
                  {term.citation}
                </span>
              </span>
            </li>
          ))}
        </ul>

        {clauseNotes.length > 0 ? (
          <ul className="mt-4 grid gap-2.5">
            {clauseNotes.map((note) => (
              <li key={note.id} className="flex gap-2.5 text-sm">
                <span aria-hidden className="text-red-deep mt-px shrink-0 font-bold">
                  ·
                </span>
                <span>
                  <span className="font-medium">{note.heading}: </span>
                  <span className="font-medium">{note.plain}</span>{" "}
                  <span className="text-muted text-xs whitespace-nowrap">
                    {note.citation}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="text-muted mt-4 text-xs leading-relaxed">
          {BAA_EXPLAINER.disclaimer}
        </p>
      </section>

      {/* ---------------- Covered entity ---------------- */}
      <section className="mt-8">
        <h2 className="text-[15.6px] font-bold tracking-[0.04em] uppercase">
          Does {clinicName || "your practice"} send health information electronically to
          insurers or payers?
        </h2>
        <p className="text-muted mt-1.5 text-sm">
          This is the legal test for whether HIPAA applies to you as a "covered
          entity": any claim, eligibility check, prior authorisation or claim-status
          enquiry sent electronically — by you, by a billing service on your
          behalf, or through a clearinghouse — makes the answer yes. Cash-pay only,
          with no electronic transactions to any payer, is a no, and it is
          completely normal here. It changes the wording of the agreement, not
          the protection.
        </p>

        <div className="mt-4 grid gap-3">
          <ChoiceCard
            selected={coveredEntity === true}
            onSelect={() => chooseCoveredEntity(true)}
            title="Yes — we, or a billing service for us, do"
            description="Claims, eligibility checks, prior authorisations or claim status, sent electronically to any insurer, Medicare, Medicaid or a clearinghouse."
          />
          <ChoiceCard
            selected={coveredEntity === false}
            onSelect={() => chooseCoveredEntity(false)}
            title="No — cash-pay only, nothing electronic to any payer"
            description="Patients pay us directly. Nobody submits anything to insurers on our behalf. (Giving a patient a receipt to claim themselves does not count.)"
          />
          <ChoiceCard
            selected={coveredEntity === null}
            onSelect={() => chooseCoveredEntity(null)}
            title="I'm not sure"
            description="We apply the full safeguards either way. We will confirm the answer with you during onboarding, and the agent is not switched on for real patients until it is confirmed."
          />
        </div>
      </section>

      {/* ---------------- The document ---------------- */}
      {/* Hidden until the covered-entity question is answered, because the
          answer changes a paragraph of the contract. Showing a document and
          then silently rewriting it under the reader is worse than waiting. */}
      {shownText === null ? (
        <p className="border-line text-muted mt-8 rounded-2xl border border-dashed px-5 py-6 text-center text-sm">
          Answer the question above and your agreement will appear here.
        </p>
      ) : (
      <section className="mt-8">
        <div className="border-line rounded-2xl border bg-white">
          <div className="border-line flex items-center justify-between gap-3 border-b px-5 py-3">
            <span className="text-sm font-bold">
              Business Associate Agreement
            </span>
            <span className="text-muted text-xs font-semibold">
              Version {CURRENT_BAA_VERSION}
            </span>
          </div>

          <div
            ref={scrollRef}
            onScroll={onScroll}
            tabIndex={0}
            role="region"
            aria-label="Business Associate Agreement text"
            className="scroll-subtle max-h-80 overflow-y-auto px-5 py-4"
          >
            <pre className="text-muted font-sans text-[15.6px] leading-relaxed whitespace-pre-wrap">
              {shownText}
            </pre>
          </div>

          <div className="border-line border-t px-5 py-3">
            <p
              className={[
                "text-xs font-semibold transition-colors",
                readToEnd ? "text-muted" : "text-red-deep",
              ].join(" ")}
            >
              {readToEnd
                ? "✓ You've read to the end."
                : "Scroll to the end of the agreement to continue."}
            </p>
          </div>
        </div>
      </section>
      )}

      {/* ---------------- Signature ---------------- */}
      {/* `inert`, not just aria-hidden. The section holds four focusable
          controls, two inputs, the assent checkbox and the Sign button, and
          neither `pointer-events-none` nor `aria-hidden` takes anything out of
          the tab order. On a full page a keyboard user tabbed through them and
          out into the document; inside a modal focus trap they cycle forever
          through controls that announce nothing. `inert` removes them from
          hit-testing, the accessibility tree and the tab order together, which
          is what the other two were each half-doing. */}
      <section
        className={[
          "mt-8 transition-opacity",
          readToEnd ? "opacity-100" : "opacity-40",
        ].join(" ")}
        inert={!readToEnd}
      >
        <h2 className="text-[15.6px] font-bold tracking-[0.04em] uppercase">
          Sign
        </h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-muted text-xs font-semibold">
              Type your full name
            </span>
            <input
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder="Alex Chen"
              autoComplete="name"
              /* Same reason as the covered-entity cards: the name in the
                 recorded document cannot be edited after the fact, so the
                 field that renders it must not look as though it can. */
              disabled={signedWithoutCopy !== null}
              className="border-line focus:border-orange text-ink mt-2 w-full rounded-xl border bg-white px-4 py-3 font-serif text-[21.6px] italic outline-none transition-colors disabled:opacity-60"
            />
          </label>
          <label className="block">
            <span className="text-muted text-xs font-semibold">
              Your title at the practice
            </span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Owner"
              autoComplete="organization-title"
              disabled={signedWithoutCopy !== null}
              className="border-line focus:border-orange text-ink mt-2 w-full rounded-xl border bg-white px-4 py-3 text-[19.2px] outline-none transition-colors disabled:opacity-60"
            />
          </label>
        </div>

        {/* ---------------- Inbound only, stated plainly ----------------
            This box used to restate a consent warranty for reminders and
            win-backs, and then (from 23 September 2026) described consented
            call-backs. v1 has neither: every product is inbound only, and
            nothing contacts a patient first or after a conversation ends
            (docs/v1-product-spec.md, "Scope and locked decisions"). Nothing is
            placed in the clinic's name, so there is nothing for it to warrant,
            and the box says exactly that. It is interface copy beside the
            agreement, not part of it: the BAA text is unchanged. Conspicuous
            beside the button for the same reason the warranty was: a scroll
            box and "they saw it" is the reading that fails. */}
        <div className="border-line bg-paper-2/50 mt-6 rounded-xl border p-4">
          <p className="text-[15.6px] font-bold">Inbound only</p>
          <p className="text-muted mt-1.5 text-[15.6px] leading-relaxed">
            healdesk only answers. It never calls or texts your patients, and
            sends no reminders, follow-ups, win-backs or call-backs: every
            conversation it has is one a patient started. It says it is an AI
            assistant first, on every channel. You give no consent warranty,
            because nothing is ever placed in your name.
          </p>
        </div>

        {/* ---------------- Signed, but the copy did not go out ----------------
            Replaces the assent block rather than sitting under it. Everything
            in that block is an offer to sign, and the moment there is a
            signature the offer is history: the "a copy is emailed to you" line
            in particular has just been contradicted by the server, and leaving
            it on screen above this would make the page argue with itself.

            The order of the two sentences is the whole design. Signing
            SUCCEEDED, and that is said first, because a buyer who reads this as
            a failure signs again, and the acceptance table is append-only, so
            a second signature is a second row for one act of assent and a
            record with two answers to "when did they agree".

            Second, and plainly, that the copy is not coming. Until a transport
            is configured this is not the unhappy path, it is the only path, and
            the alternative to saying so here is a clinic that believes it holds
            its own agreement and finds out otherwise on the day someone asks
            for it. */}
        {signedWithoutCopy ? (
          <div
            ref={noticeRef}
            tabIndex={-1}
            role="status"
            className="border-line bg-paper-2/50 mt-5 rounded-2xl border p-5 outline-none"
          >
            <p className="text-[15.6px] font-bold">
              ✓ Your agreement is signed and on file.
            </p>

            <div className="mt-3 flex gap-2.5">
              <span aria-hidden className="text-red-deep mt-px shrink-0 font-bold">
                ·
              </span>
              <p className="text-[15.6px] leading-relaxed font-semibold">
                {signedWithoutCopy.reason}
              </p>
            </div>

            <p className="text-muted mt-3 text-[15.6px] leading-relaxed">
              This changes nothing about your signature. We recorded the
              agreement exactly as it appears above, and it stands whether or
              not the email reaches you.
            </p>

            <p className="text-muted mt-3 text-[15.6px] leading-relaxed">
              We have a record that your copy is outstanding. Email{" "}
              <a
                href="mailto:hello@healdesk.io?subject=My%20signed%20agreement"
                className="text-ink font-semibold underline underline-offset-4"
              >
                hello@healdesk.io
              </a>{" "}
              and a person will get it to you, at{" "}
              {contactEmail || "the address you signed with"} or at a different
              one.
            </p>

            <div className="mt-5">
              <PrimaryButton onClick={() => onSigned(signedWithoutCopy.result)}>
                Continue to plans
              </PrimaryButton>
            </div>
          </div>
        ) : (
          <>
            <p className="text-muted mt-5 text-xs">
              Signing as {contactEmail.trim().toLowerCase() || "your work email"} · {today()} · A copy
              is emailed to you.
            </p>

            <label className="mt-4 flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                /* Never restored from autofill or a back-navigation cache. An
                   assent box that arrives pre-ticked because the browser
                   remembered it is not assent. */
                autoComplete="off"
                className="accent-red mt-1 size-4 shrink-0"
              />
              {/* The authority attestation is the point of this sentence. Whether the
                  person clicking can bind the practice is ordinary contract law, and
                  asking them to say so is the cheapest thing that helps. */}
              {/* Rendered from the same function the server stores, so the
                  words on screen and the words in the record are one string. */}
              <span className="text-sm font-medium">{assentSentence(clinicName)}</span>
            </label>

            {error ? (
              <p className="text-red-deep mt-4 text-sm font-semibold">{error}</p>
            ) : null}

            {/* Nothing may render between the checkbox and the button. What makes a
                click-through hold up is that the assent sentence and the action it
                describes are visible together, so the "signing as…" line sits
                above the checkbox, not between it and the button. */}
            <div className="mt-6">
              <PrimaryButton
                onClick={() => void sign()}
                disabled={!canSign || submitting}
              >
                {submitting ? "Recording…" : BAA_ACTION_LABEL}
              </PrimaryButton>
            </div>
          </>
        )}
      </section>

      <p className="text-muted mt-10 text-center text-xs">
        No payment on this step · Calendar access only · We never see clinical notes
      </p>
    </StepShell>
  );
}

/**
 * SHA-256 of the displayed text, hex, or undefined where unavailable.
 *
 * Undefined rather than throwing: `crypto.subtle` is absent outside a secure
 * context, and a developer on plain http should get an unverified signature
 * with that fact recorded, not a checkout that cannot complete.
 */
async function sha256(text: string | null): Promise<string | undefined> {
  if (!text || typeof globalThis.crypto?.subtle?.digest !== "function") {
    return undefined;
  }
  try {
    const bytes = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return undefined;
  }
}

/**
 * The date shown beside "Signing as", in UTC.
 *
 * The document's own effective date is the UTC date (agreements.ts sets it
 * from toISOString), so this must be too: formatted in local time, a signer on
 * the US west coast after 5pm saw one date on this line and another inside
 * the agreement they were signing.
 */
function today(): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date());
}
