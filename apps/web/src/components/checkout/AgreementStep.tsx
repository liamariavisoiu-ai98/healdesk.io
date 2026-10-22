"use client";

import {
  agreementKindFor,
  agreementPlatformFor,
  asksCoveredQuestion,
  type BookingSystemId,
  type CalendarAccount,
  type CoveredAnswer,
  type SpecialtyId,
} from "@healdesk/catalog";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";

import { site } from "@/lib/site";

import { agreementCopyFor, effectiveDateToday, versionLabel } from "./agreement-kinds";
import { FIELD_LABEL, PrimaryButton, RadioGroup, type RadioOption, StepShell, TextField } from "./StepShell";

/**
 * Signing the agreement, its own step, before payment.
 *
 * The ordering is the requirement. A healthcare provider may not hand patient
 * information to a supplier without a written contract first, so the contract
 * cannot be a checkbox bundled into the payment button, and it cannot be
 * something recorded after a webhook lands. It is a separate, deliberate act
 * with its own screen, and the record is written to the database here, before
 * anyone sees a payment form.
 *
 * ## Which agreement
 *
 * Never chosen here. `agreementKindFor` decides from the specialty and the
 * covered-entity answer (plan Part L), and the document, its explainer and its
 * assent wording come from AGREEMENT_COPY for that kind. Until the owner
 * released the Data Protection Agreement on 20 October 2026 every practice
 * offered signed the Business Associate Agreement; since then a veterinary
 * practice, and one HIPAA reaches only if covered that answers "No", sign the
 * DPA here.
 *
 * ## Why this is heavier than a checkbox
 *
 *   - **The explanation** sits above the document, not behind a link.
 *   - **The covered-entity question** decides a paragraph of the agreement,
 *     so it is asked rather than assumed, worded around what decides it: how
 *     the practice bills. "Not sure" is a real answer.
 *   - **The typed name is the signature**, rendered into the document itself,
 *     which is why the preview refreshes as it is typed.
 *   - **Reading to the end is required** before the signature unlocks: the
 *     end of a scroll box on a wider screen, and below 640px, where a box in
 *     a page is a trap, the end of the agreement inline in the page. Either
 *     way a marker after the last line is what unlocks it, and a change to
 *     the document (another answer, another kind) locks it again.
 *
 * The document shown here is rendered by the same catalog function the server
 * uses, and hashed; the server renders its own and refuses a mismatch. The
 * preview is a courtesy; the stored text is the authority.
 */

/**
 * What the server says became of the copy it emails the signer. An absent
 * field means "we were not told", never either answer.
 */
export type CopyDelivery =
  | { status: "sent" }
  | { status: "not_sent"; reason: string };

export type AgreementResult = {
  agreementId: string;
  version: string;
  hash: string;
  text: string;
  acceptedAt: string;
  approvedByCounsel: boolean;
  copy?: CopyDelivery;
};

const COVERED_OPTIONS: readonly RadioOption<CoveredAnswer>[] = [
  {
    id: "yes",
    label: "Yes",
    description:
      "We, or a billing service for us, send claims, eligibility checks or prior authorisations to insurers, Medicare or Medicaid electronically.",
  },
  {
    id: "no",
    label: "No",
    description:
      "Patients pay us directly and nobody bills an insurer for us. A receipt a patient claims with themselves doesn't count.",
  },
  {
    id: "not_sure",
    label: "Not sure",
    description: "The agreement applies the full safeguards either way, and setup asks you again.",
  },
];

export function AgreementStep({
  step,
  totalSteps,
  onBack,
  onClose,
  headingRef,
  clinicName,
  specialty,
  bookingSystem,
  calendarAccount,
  covered,
  onCovered,
  contactName,
  contactTitle,
  contactEmail,
  onContact,
  lockedEmail,
  signed,
  copyLink,
  notice,
  onSigned,
  onContinue,
  onResign,
}: {
  step: number;
  totalSteps: number;
  onBack: () => void;
  /** Present only when hosted in a modal. See StepShell. */
  onClose?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
  clinicName: string;
  specialty: SpecialtyId;
  bookingSystem: BookingSystemId;
  calendarAccount: CalendarAccount;
  covered: CoveredAnswer | null;
  onCovered: (answer: CoveredAnswer) => void;
  contactName: string;
  contactTitle: string;
  contactEmail: string;
  onContact: (field: "contactName" | "contactTitle" | "contactEmail", value: string) => void;
  /** The address a setup link was sent to: the only one the purchase may use. */
  lockedEmail?: string;
  /** A signature whose answers still match this purchase, or null. */
  signed: AgreementResult | null;
  /** The download for a signed agreement, rendered by the flow, which owns the PDF fallback. */
  copyLink?: ReactNode;
  /** Said at the top of the step, such as why an earlier signature no longer applies. */
  notice?: string | null;
  onSigned: (result: AgreementResult) => void;
  onContinue: () => void;
  onResign: () => void;
}) {
  const asks = asksCoveredQuestion(specialty);
  const choice = agreementKindFor({ specialty, covered: asks ? covered : null });
  const kind = choice.ok ? choice.kind : null;
  const isCoveredEntity = choice.ok ? choice.isCoveredEntity : null;
  const copy = kind ? agreementCopyFor(kind) : null;
  const unanswered = asks && covered === null;

  const [agreed, setAgreed] = useState(false);
  /** The end marker has been seen. `readToEnd`, below, is what the step uses. */
  const [reachedEnd, setReachedEnd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * A signature that succeeded while its copy did not go out. Held here
   * rather than passed straight on, because passing it on moves the buyer to
   * the next step, and a notice on a screen nobody stops at is no notice.
   */
  const [signedWithoutCopy, setSignedWithoutCopy] = useState<{
    result: AgreementResult;
    reason: string;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * The end marker, held as state through a callback ref rather than in a
   * ref object, so that the marker appearing is itself what (re)attaches the
   * observer below. The step can open on the signed view, which has no
   * marker, and "Sign again with different answers" then draws the document
   * in this same component with nothing else the observer watched having
   * changed; a ref object read in an effect would never see it arrive.
   */
  const [endMarker, setEndMarker] = useState<HTMLDivElement | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (signedWithoutCopy) noticeRef.current?.focus();
  }, [signedWithoutCopy]);

  const today = effectiveDateToday();
  const email = (lockedEmail ?? contactEmail).trim().toLowerCase();

  /**
   * The preview, from the real template and the catalog's one renderer, with
   * placeholders for what is still empty so the document reads before it is
   * complete without ever naming a blank party.
   *
   * Rendered on every render, not memoized: nearly every render here is a
   * keystroke in a field the document prints, which changes it anyway, and
   * the rest (the tick, the end marker, submitting) are a handful per
   * signature. A useMemo keyed on `copy` was one the React Compiler could not
   * keep, since `copy.render` may, as far as it can tell, change `copy`.
   */
  let preview: ReturnType<NonNullable<typeof copy>["render"]> | null = null;
  if (copy && !unanswered) {
    try {
      preview = copy.render({
        clinicLegalName: clinicName.trim() || "[your practice]",
        specialty,
        isCoveredEntity,
        bookingSystem,
        calendarAccount,
        signatoryName: contactName.trim() || "[your name]",
        signatoryTitle: contactTitle.trim() || undefined,
        signatoryEmail: email || "[your email]",
        effectiveDate: today,
      });
    } catch {
      preview = null;
    }
  }

  /**
   * What the document says apart from its signature block. When this changes
   * (another covered-entity answer, another kind of agreement), the reader
   * has not read the document in front of them, so "read to the end" and the
   * assent tick both reset. Typing the signature does not count: it changes
   * only the signature block, below the line the reader already reached.
   */
  const documentKey = JSON.stringify([
    kind,
    copy?.version ?? null,
    clinicName.trim(),
    specialty,
    asks ? covered : null,
    bookingSystem,
    calendarAccount,
  ]);

  // Reset while rendering, as React documents for state that follows a
  // changed input, so no frame shows the new document with the old tick.
  const [readKey, setReadKey] = useState(documentKey);
  if (readKey !== documentKey) {
    setReadKey(documentKey);
    setReachedEnd(false);
    setAgreed(false);
  }

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [documentKey]);

  // After the recorded text replaces the preview, it is what is shown.
  const shownText = signedWithoutCopy?.result.text ?? preview?.text ?? null;
  const hasDocument = shownText !== null;

  /**
   * The end marker. One observer covers both layouts: inside the scroll box
   * the marker is clipped until the box is scrolled to it, and inline it
   * enters the viewport when the page is. A browser with no observer is let
   * through rather than left with a Sign button that can never unlock; that
   * is worked out while rendering, once the marker exists, which it only
   * ever does in the browser, so the server's render never differs.
   * Keyed on the marker element itself, which exists only while the document
   * is shown (see `endMarker`).
   */
  const readToEnd =
    reachedEnd || (endMarker !== null && typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (!endMarker || readToEnd) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setReachedEnd(true);
    });
    observer.observe(endMarker);
    return () => observer.disconnect();
  }, [endMarker, readToEnd, documentKey]);

  const nameOk = contactName.trim().length >= 2;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  const canSign = Boolean(copy) && !unanswered && readToEnd && nameOk && emailOk && agreed;

  async function sign() {
    if (!copy || !preview) return;
    setSubmitting(true);
    setError(null);

    try {
      // Hash exactly what this browser rendered. The server renders its own
      // copy and refuses if they differ. Optional by necessity: crypto.subtle
      // exists only in a secure context.
      const displayedHash = await sha256(preview.text);

      const response = await fetch("/api/agreement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clinicLegalName: clinicName.trim(),
          specialty,
          // Phase two is fenced out of v1: no clinic gives us credentials.
          attributionMode: "estimated",
          // The released agreement still names the phase-two platform, and
          // apps/app still requires it; derived from the booking system, the
          // same way the preview derives it.
          platform: agreementPlatformFor(bookingSystem),
          bookingSystem,
          calendarAccount,
          signatoryName: contactName.trim(),
          signatoryTitle: contactTitle.trim() || undefined,
          signatoryEmail: email,
          isCoveredEntity,
          // The fixed half of the sentence, as proof this UI showed it. The
          // server stores the full sentence it derives itself, never this.
          assentLabel: copy.assentLabel,
          templateVersion: copy.version,
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

  const shell = (children: ReactNode) => (
    <StepShell
      step={step}
      totalSteps={totalSteps}
      eyebrow={site.cta.primary.label}
      title="Your agreement"
      subtitle="Signed before anything is charged. You'll review the price next."
      onBack={onBack}
      onClose={onClose}
      headingRef={headingRef}
    >
      {notice ? (
        <p className="border-red/30 bg-red/[0.06] mb-6 rounded-sm border px-4 py-3 text-[15.6px] font-semibold">
          {notice}
        </p>
      ) : null}
      {children}
      <p className="text-muted mt-10 text-center text-xs">
        No payment on this step · No access to your clinical records
      </p>
    </StepShell>
  );

  if (!choice.ok || !copy) {
    return shell(
      <p className="border-line rounded-md border bg-white px-5 py-6 text-[15.6px]">
        We can&apos;t offer an agreement for this practice here. Go back and check your
        specialty, or email{" "}
        <a href={`mailto:${site.email}`} className="font-semibold underline underline-offset-4">
          {site.email}
        </a>
        .
      </p>,
    );
  }

  // ---------------- Already signed, for these very answers ----------------
  if (signed && !signedWithoutCopy) {
    return shell(
      <section className="border-line rounded-md border bg-white">
        <div className="border-line flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
          <span className="text-sm font-bold">
            <span aria-hidden className="text-red-deep">✓ </span>
            {copy.title} signed
          </span>
          <span className="text-muted text-xs font-semibold">Version {versionLabel(signed.version)}</span>
        </div>
        <div className="scroll-subtle px-5 py-4 sm:max-h-80 sm:overflow-y-auto" tabIndex={0} role="region" aria-label={`${copy.title} you signed`}>
          <pre className="text-muted font-sans text-[15.6px] leading-relaxed whitespace-pre-wrap">{signed.text}</pre>
        </div>
        <div className="border-line border-t px-5 py-3">{copyLink}</div>
        <div className="border-line flex flex-wrap items-center gap-4 border-t px-5 py-5">
          <PrimaryButton onClick={onContinue}>Continue to review</PrimaryButton>
          <button
            type="button"
            onClick={onResign}
            className="text-muted hover:text-ink min-h-11 text-sm font-semibold underline underline-offset-4"
          >
            Sign again with different answers
          </button>
        </div>
      </section>,
    );
  }

  return shell(
    <>
      {/* ---------------- Why ---------------- */}
      <section className="border-line bg-paper-2/50 rounded-md border p-5 sm:p-6">
        <h2 className="font-display text-[22.8px] leading-tight font-medium">
          {copy.explainer.heading}
        </h2>
        <p className="text-muted mt-3 text-sm leading-relaxed font-medium">{copy.explainer.lead}</p>
        <p className="text-muted mt-3 text-sm leading-relaxed font-medium">{copy.explainer.objection}</p>

        <ul className="mt-4 grid gap-2.5">
          {copy.explainer.terms.map((term) => (
            <li key={term.citation} className="flex gap-2.5 text-sm">
              <span aria-hidden className="text-red-deep mt-px shrink-0 font-bold">
                ·
              </span>
              <span>
                <span className="font-medium">{term.plain}</span>{" "}
                <span className="text-muted text-xs whitespace-nowrap">{term.citation}</span>
              </span>
            </li>
          ))}
        </ul>

        {preview && preview.notes.length > 0 ? (
          <ul className="mt-4 grid gap-2.5">
            {preview.notes.map((note) => (
              <li key={note.id} className="flex gap-2.5 text-sm">
                <span aria-hidden className="text-red-deep mt-px shrink-0 font-bold">
                  ·
                </span>
                <span>
                  <span className="font-medium">{note.heading}: </span>
                  <span className="font-medium">{note.plain}</span>{" "}
                  <span className="text-muted text-xs whitespace-nowrap">{note.citation}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="text-muted mt-4 text-xs leading-relaxed">{copy.explainer.disclaimer}</p>
      </section>

      {/* ---------------- Covered entity ---------------- */}
      {asks ? (
        <section className="mt-8">
          <RadioGroup<CoveredAnswer>
            name="covered"
            layout="cards"
            label="Do you bill any health insurance electronically, yourself or through a clearinghouse?"
            hint="That is what makes a practice a covered entity under HIPAA. Cash-pay only is a no, and common here. It changes the wording of the agreement, not the protection."
            // Fixed once a signature is on its way or recorded: the answer is in the document.
            options={COVERED_OPTIONS.map((option) => ({
              ...option,
              disabled: signedWithoutCopy !== null || submitting,
            }))}
            value={covered}
            onChange={onCovered}
          />
        </section>
      ) : null}

      {/* ---------------- The document ----------------
          Hidden until the question is answered, because the answer changes a
          paragraph of the contract. Inline below 640px, in a scroll box above. */}
      {!hasDocument ? (
        <p className="border-line text-muted mt-8 rounded-md border border-dashed px-5 py-6 text-center text-sm">
          Answer the question above and your agreement will appear here.
        </p>
      ) : (
        <section className="mt-8">
          <div className="border-line rounded-md border bg-white">
            <div className="border-line flex items-center justify-between gap-3 border-b px-5 py-3">
              <span className="text-sm font-bold">{copy.title}</span>
              <span className="text-muted text-xs font-semibold">Version {versionLabel(copy.version)}</span>
            </div>

            <div
              ref={scrollRef}
              tabIndex={0}
              role="region"
              aria-label={`${copy.title} text`}
              className="scroll-subtle px-5 py-4 sm:max-h-80 sm:overflow-y-auto"
            >
              <pre className="text-muted font-sans text-[15.6px] leading-relaxed whitespace-pre-wrap">
                {shownText}
              </pre>
              <div ref={setEndMarker} aria-hidden className="h-px" data-agreement-end />
            </div>

            <div className="border-line border-t px-5 py-3">
              <p
                role="status"
                aria-live="polite"
                className={["text-xs font-semibold", readToEnd ? "text-muted" : "text-red-deep"].join(" ")}
              >
                {readToEnd ? "✓ You've read to the end." : "Read to the end of the agreement to sign it."}
              </p>
            </div>
          </div>
        </section>
      )}

      {/* ---------------- Signature ----------------
          `inert` until read: it takes the fields, the tick and the button out
          of hit-testing, the accessibility tree and the tab order together. */}
      <section
        className={["mt-8 transition-opacity", readToEnd ? "opacity-100" : "opacity-40"].join(" ")}
        inert={!readToEnd}
      >
        <h2 className={FIELD_LABEL}>Sign</h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextField
            label="Your full name"
            value={contactName}
            onChange={(value) => onContact("contactName", value)}
            placeholder="Alex Chen"
            autoComplete="name"
            maxLength={120}
            disabled={signedWithoutCopy !== null || submitting}
            inputClassName="font-serif text-[21.6px] italic"
          />
          <TextField
            label="Your title at the practice"
            value={contactTitle}
            onChange={(value) => onContact("contactTitle", value)}
            placeholder="Owner"
            autoComplete="organization-title"
            maxLength={120}
            disabled={signedWithoutCopy !== null || submitting}
          />
        </div>
        <div className="mt-4">
          {lockedEmail ? (
            <TextField
              label="Your clinic's email"
              type="email"
              value={lockedEmail}
              onChange={() => undefined}
              readOnly
              hint="This is where healdesk signs you in and sends everything. Your setup link is for this address; to use another, reply to the email your link came in."
            />
          ) : (
            <TextField
              label="Your clinic's email"
              type="email"
              value={contactEmail}
              onChange={(value) => onContact("contactEmail", value)}
              placeholder="info@glowmedspa.com"
              autoComplete="email"
              inputMode="email"
              disabled={signedWithoutCopy !== null || submitting}
              hint="This is where healdesk signs you in and sends everything. One address for the whole clinic; a shared inbox such as info@ is fine."
            />
          )}
        </div>

        {/* Interface copy beside the agreement, not part of it: v1 only
            answers, so nothing is placed in the clinic's name and there is
            nothing for it to warrant. */}
        <div className="border-line bg-paper-2/50 mt-6 rounded-sm border p-4">
          <p className="text-[15.6px] font-bold">Inbound only</p>
          <p className="text-muted mt-1.5 text-[15.6px] leading-relaxed">
            {/* In the practice's word (audienceFor): the covered-entity question is
                skipped exactly where HIPAA cannot reach, a vet's, whose people are clients. */}
            healdesk only answers. It never calls or texts your {asks ? "patients" : "clients"}, and
            sends no reminders, follow-ups, win-backs or call-backs: every conversation it has is
            one a {asks ? "patient" : "client"} started. It says it is an AI assistant first, on
            every channel. You give no consent warranty, because nothing is ever placed in your name.
          </p>
        </div>

        {!copy.released ? (
          <p className="border-red/30 bg-red/[0.06] mt-4 rounded-sm border px-4 py-3 text-[15.6px] font-semibold">
            This agreement is a draft pending legal review. Until it is finalised, accounts are
            created for synthetic data only and cannot receive real patient information.
          </p>
        ) : null}

        {signedWithoutCopy ? (
          <div
            ref={noticeRef}
            tabIndex={-1}
            role="status"
            className="border-line bg-paper-2/50 mt-5 rounded-md border p-5 outline-none"
          >
            <p className="text-[15.6px] font-bold">✓ Your agreement is signed and on file.</p>
            <div className="mt-3 flex gap-2.5">
              <span aria-hidden className="text-red-deep mt-px shrink-0 font-bold">
                ·
              </span>
              <p className="text-[15.6px] leading-relaxed font-semibold">{signedWithoutCopy.reason}</p>
            </div>
            <p className="text-muted mt-3 text-[15.6px] leading-relaxed">
              This changes nothing about your signature. We recorded the agreement exactly as it
              appears above, and it stands whether or not the email reaches you.
            </p>
            <p className="text-muted mt-3 text-[15.6px] leading-relaxed">
              We have a record that your copy is outstanding. Email{" "}
              <a
                href="mailto:hello@healdesk.io?subject=My%20signed%20agreement"
                className="text-ink font-semibold underline underline-offset-4"
              >
                hello@healdesk.io
              </a>{" "}
              and a person will get it to you, at {email || "the address you signed with"} or at a
              different one.
            </p>
            <div className="mt-5">
              <PrimaryButton onClick={() => onSigned(signedWithoutCopy.result)}>Continue to review</PrimaryButton>
            </div>
          </div>
        ) : (
          <>
            <p className="text-muted mt-5 text-xs">
              Signing as {email || "your clinic's email"} · {signingDate()} · A copy is emailed to
              you, and this page says if it can&apos;t be.
            </p>

            <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                // Never restored from autofill or a back-navigation cache: an
                // assent box that arrives ticked is not assent.
                autoComplete="off"
                className="accent-red mt-1 size-5 shrink-0"
              />
              {/* From the same function the server stores, so the words on
                  screen and the words in the record are one string. */}
              <span className="text-sm font-medium">{copy.assentSentence(clinicName)}</span>
            </label>

            {error ? (
              <p className="text-red-deep mt-4 text-sm font-semibold" role="alert">
                {error}
              </p>
            ) : null}

            {/* Nothing between the tick and the button: the assent sentence
                and the action it describes are seen together. */}
            <div className="mt-6">
              <PrimaryButton onClick={() => void sign()} disabled={!canSign || submitting}>
                {submitting ? "Recording…" : copy.actionLabel}
              </PrimaryButton>
            </div>
          </>
        )}
      </section>
    </>,
  );
}

/** SHA-256 of the displayed text, hex, or undefined outside a secure context. */
async function sha256(text: string | null): Promise<string | undefined> {
  if (!text || typeof globalThis.crypto?.subtle?.digest !== "function") {
    return undefined;
  }
  try {
    const bytes = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

/**
 * The date beside "Signing as", in UTC, because the document's own effective
 * date is the UTC date: in local time a signer on the US west coast after 5pm
 * saw one date here and another inside the agreement.
 */
function signingDate(): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date());
}
