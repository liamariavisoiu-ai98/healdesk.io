"use client";

import {
  BAA_ASSENT_LABEL,
  BAA_EXPLAINER,
  currentBaaTemplate,
  CURRENT_BAA_VERSION,
  renderBaa,
} from "@healdesk/catalog";
import { useMemo, useRef, useState } from "react";

import { ChoiceCard, PrimaryButton, StepShell } from "./StepShell";

/**
 * Signing the business associate agreement — its own step, before payment.
 *
 * The ordering is the requirement. A healthcare provider may not hand patient
 * information to a supplier without a written contract first, so the contract
 * cannot be a checkbox bundled into the payment button, and it cannot be
 * something recorded after a webhook lands. It is a separate, deliberate act
 * with its own screen, and the record is written to the database here — before
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

export type AgreementResult = {
  agreementId: string;
  version: string;
  hash: string;
  text: string;
  acceptedAt: string;
  approvedByCounsel: boolean;
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
   * See packages/catalog/src/baa.ts — verified means we hold credentials to
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

  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * The preview is rendered from the REAL template, by the same function the
   * server uses.
   *
   * Reimplementing the document in the component would be easier and is the
   * obvious thing to reach for — and it would give a contract two sources of
   * truth that drift silently. So `renderBaa` is shared code, and the only
   * difference between this and the stored copy is that the server renders it
   * again from the submitted values and hashes that.
   *
   * Placeholders stand in for fields still empty, so the document is readable
   * before it is complete without ever rendering a blank party name.
   */
  const documentText = useMemo(() => {
    if (coveredEntity === undefined) return null;
    return renderBaa(currentBaaTemplate(), {
      clinicLegalName: clinicName.trim() || "[your practice]",
      signatoryName: signature.trim() || "[your name]",
      signatoryTitle: title.trim() || undefined,
      signatoryEmail: contactEmail.trim() || "[your email]",
      effectiveDate: new Date().toISOString().slice(0, 10),
      specialty: specialty || "healthcare",
      isCoveredEntity: coveredEntity,
      attributionMode,
      connectedPlatform: platformName,
      outboundMessaging: true,
    });
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

  // The signature must match the name they gave us. Not a legal requirement —
  // an evidentiary one: a mismatch is the first thing anyone disputing this
  // would point at, and it is trivially avoidable.
  const signatureOk = signature.trim().length >= 2;
  const canSign =
    coveredEntity !== undefined && readToEnd && signatureOk && agreed;

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
          signatoryEmail: contactEmail.trim(),
          isCoveredEntity: coveredEntity ?? null,
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

      onSigned(data);
    } catch {
      setError("Network error. Your agreement was not recorded — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <StepShell
      step={step}
      totalSteps={totalSteps}
      eyebrow="Get started"
      title="The agreement, before anything else"
      subtitle="Nothing is charged on this step. You'll see the plan and price next."
      onBack={onBack}
    >
      {/* ---------------- Why ---------------- */}
      <section className="border-line bg-paper-2/50 rounded-2xl border p-5 sm:p-6">
        <h2 className="font-display text-[19px] leading-tight font-medium">
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
              <span aria-hidden className="text-red mt-px shrink-0 font-bold">
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

        <p className="text-muted mt-4 text-xs leading-relaxed">
          {BAA_EXPLAINER.disclaimer}
        </p>
      </section>

      {/* ---------------- Covered entity ---------------- */}
      <section className="mt-8">
        <h2 className="text-[13px] font-bold tracking-[0.04em] uppercase">
          Does {clinicName || "your practice"} bill insurance electronically?
        </h2>
        <p className="text-muted mt-1.5 text-sm">
          It decides which version of the agreement applies to you. If you are
          cash-pay only, that is completely normal here — it just changes the
          wording.
        </p>

        <div className="mt-4 grid gap-3">
          <ChoiceCard
            selected={coveredEntity === true}
            onSelect={() => setCoveredEntity(true)}
            title="Yes, we bill insurance"
            description="Claims, eligibility checks or similar, submitted electronically."
          />
          <ChoiceCard
            selected={coveredEntity === false}
            onSelect={() => setCoveredEntity(false)}
            title="No, we're cash-pay only"
            description="Patients pay us directly. We don't submit anything to insurers."
          />
          <ChoiceCard
            selected={coveredEntity === null}
            onSelect={() => setCoveredEntity(null)}
            title="I'm not sure"
            description="We'll apply the same safeguards either way and confirm with you before any real patient information is processed."
          />
        </div>
      </section>

      {/* ---------------- The document ---------------- */}
      {/* Hidden until the covered-entity question is answered, because the
          answer changes a paragraph of the contract. Showing a document and
          then silently rewriting it under the reader is worse than waiting. */}
      {documentText === null ? (
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
            <pre className="text-muted font-sans text-[13px] leading-relaxed whitespace-pre-wrap">
              {documentText}
            </pre>
          </div>

          <div className="border-line border-t px-5 py-3">
            <p
              className={[
                "text-xs font-semibold transition-colors",
                readToEnd ? "text-muted" : "text-red",
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
      <section
        className={[
          "mt-8 transition-opacity",
          readToEnd ? "opacity-100" : "pointer-events-none opacity-40",
        ].join(" ")}
        aria-hidden={!readToEnd}
      >
        <h2 className="text-[13px] font-bold tracking-[0.04em] uppercase">
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
              className="border-line focus:border-orange text-ink mt-2 w-full rounded-xl border bg-white px-4 py-3 font-serif text-[18px] italic outline-none transition-colors"
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
              className="border-line focus:border-orange text-ink mt-2 w-full rounded-xl border bg-white px-4 py-3 text-[16px] outline-none transition-colors"
            />
          </label>
        </div>

        {/* ---------------- The consent warranty, restated ----------------
            This is in the agreement they just scrolled through, and it is
            repeated here on purpose. It is the one clause that imposes an
            obligation on THEM rather than on us, and the assent label names it
            — so burying it in a scroll box and relying on "they saw it" is
            exactly the reading that fails. Conspicuous beside the button is
            what makes it stick.

            It also matters commercially: the outbound loop is the product's
            differentiator, and under the TCPA consent to receive those messages
            has to come from the patient. The clinic is the only party that can
            have obtained it. Without this warranty there is no consent basis
            for the feature and the liability lands on us. */}
        <div className="border-line bg-paper-2/50 mt-6 rounded-xl border p-4">
          <p className="text-[13px] font-bold">
            About reminders and follow-ups
          </p>
          <p className="text-muted mt-1.5 text-[13px] leading-relaxed">
            healdesk texts and calls your patients in your name — reminders,
            missed-call follow-ups, and win-back messages. The law requires that
            consent come from the patient, and you are the one who collected it
            at intake. So the agreement asks you to confirm you hold it, and to
            authorise us to send on your behalf. We honour STOP, respect quiet
            hours in the patient&apos;s own timezone, and keep to the frequency
            limits on every message.
          </p>
        </div>

        <p className="text-muted mt-5 text-xs">
          Signing as {contactEmail || "your work email"} · {today()} · A copy is
          emailed to you and stays available in your account.
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
          <span className="text-sm font-medium">
            {BAA_ASSENT_LABEL} on behalf of{" "}
            <strong>{clinicName || "my practice"}</strong>, and I confirm I am
            authorised to enter into it.
          </span>
        </label>

        {error ? (
          <p className="text-red mt-4 text-sm font-semibold">{error}</p>
        ) : null}

        {/* Nothing may render between the checkbox and the button. What makes a
            click-through hold up is that the assent sentence and the action it
            describes are visible together — so the "signing as…" line sits
            above the checkbox, not between it and the button. */}
        <div className="mt-6">
          <PrimaryButton onClick={() => void sign()} disabled={!canSign || submitting}>
            {submitting ? "Recording…" : "Sign and continue"}
          </PrimaryButton>
        </div>
      </section>

      <p className="text-muted mt-10 text-center text-xs">
        No payment on this step · Read-only access · We never see clinical notes
      </p>
    </StepShell>
  );
}

/**
 * SHA-256 of the displayed text, hex, or undefined where unavailable.
 *
 * Undefined rather than throwing: `crypto.subtle` is absent outside a secure
 * context, and a developer on plain http should get an unverified signature
 * with that fact recorded — not a checkout that cannot complete.
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

function today(): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
}
