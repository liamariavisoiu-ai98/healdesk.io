"use client";

import { type BillingInterval, type ChatChannel, type CoveredAnswer, demoSetupCreditUsd } from "@healdesk/catalog";
import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";

import { track } from "@/lib/analytics";
import { campaignCode, leadIdFromUrl } from "@/lib/attribution";
import {
  clearStoredAgreement,
  readStoredAgreement,
  type StoredAgreement,
  storeAgreement,
} from "@/lib/agreement-recovery";
import {
  agreementInputs,
  asksCovered,
  chooseCard,
  chooseChat,
  choosePlan,
  chosenPlan,
  clearStoredFunnel,
  clinicComplete,
  type FunnelSeed,
  type FunnelState,
  initialFunnel,
  purchaseWebsite,
  readStoredFunnel,
  restoreFunnel,
  resumeStep,
  sameAgreementInputs,
  type StepNumber,
  storeFunnel,
  TOTAL_STEPS,
} from "@/lib/checkout/funnel";
import {
  profileForPurchase,
  readStoredSiteRead,
  requestSiteRead,
  type SiteRead,
  siteReadLine,
  storeSiteRead,
} from "@/lib/checkout/site-read";
import { LEGAL_VERSION } from "@/lib/legal";
import { checkoutStart } from "@/lib/pricing";

import { AgreementCopyLink, filenameFrom } from "./AgreementCopy";
import { agreementCopyFor } from "./agreement-kinds";
import { type AgreementResult, AgreementStep } from "./AgreementStep";
import { ClinicStep } from "./ClinicStep";
import type { DemoCheckout } from "./DemoPackageExtras";
import { PackageStep } from "./PackageStep";
import { ReviewStep } from "./ReviewStep";

// Exported from here, where the tests have always found them.
export { AgreementCopyLink, filenameFrom } from "./AgreementCopy";
export { ChatChannelField } from "./PackageStep";

/**
 * "Get AYA": the purchase, in four steps (plan Part A3).
 *
 *   1. Package.      Five cards; on a twin card the chat channel picks the
 *                    package itself.
 *   2. Your clinic.  Legal name, website or none, specialty, where bookings
 *                    live and which Google account. The website is read in
 *                    the background once the buyer moves on.
 *   3. Agreement.    The agreement `agreementKindFor` names, signed and
 *                    recorded before any payment form exists.
 *   4. Review & pay. Today's setup fee, the plan-start sentence, the
 *                    allowance, the guarantee in full and the terms, then
 *                    Stripe.
 *
 * The rules live in lib/checkout (funnel.ts, review.ts, site-read.ts), as
 * plain functions with their own tests; this component is their rendering,
 * plus the three things only a browser can do: keep the answers for the tab,
 * ask for the website read, and send the purchase.
 *
 * ## The answers are kept for the length of the tab
 *
 * Every step is mirrored to sessionStorage (lib/checkout/funnel.ts), and so
 * are the signature (lib/agreement-recovery.ts) and the website read
 * (lib/checkout/site-read.ts). A closed modal, a reload and Stripe's cancel
 * page (`/get-started?cancelled=1`) all come back to where the buyer was, the
 * last of them to Review and pay with every step intact. The signature is
 * reused only while every answer that selects or names its document still
 * matches; change one and the step asks for a signature on the new document.
 *
 * ## Signing is step 3, payment is step 4, and that order is load-bearing
 *
 * A healthcare provider may not hand patient information to a supplier
 * without a written contract first, so the agreement is its own step, and it
 * is recorded in the database before the buyer ever sees a payment form.
 * Abandoning at step 4 leaves a signed agreement with no account behind it,
 * which is correct: far better than taking money for an account with no
 * agreement.
 */

/** How long this browser waits for its own server before it calls the PDF a fallback. */
const PDF_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Where the PDF download anchor is attached. Inside a <dialog> opened with
 * showModal() the document outside the dialog is inert, so the modal passes
 * its own element.
 */
export type DownloadHost = () => HTMLElement | null;

/** Reported upward so a host can decide whether it is safe to close. */
export type CheckoutProgress = {
  step: number;
  /** A signature for the current answers exists. Closing now would only set it aside. */
  signed: boolean;
  done: boolean;
};

/** What the flow may start from, besides the package: the setup link's request, or the demo. */
export type CheckoutSeed = Pick<FunnelSeed, "clinicName" | "website" | "specialty" | "contactEmail">;

const RETURNED_NOTICE =
  "You left the payment page, so nothing was charged. Everything you entered is still here.";

const CHANGED_NOTICE =
  "Your answers changed after you signed, so this is the agreement for your answers now. Signing it records it in place of the earlier one.";

/** Which step a refusal from /api/checkout belongs to, by the field it names. */
const FIELD_STEP: Record<string, StepNumber> = {
  plan: 1,
  interval: 1,
  clinicName: 2,
  specialty: 2,
  website: 2,
  bookingSystem: 2,
  calendarAccount: 2,
  agreementId: 3,
  covered: 3,
  contactName: 3,
  contactEmail: 3,
  contactTitle: 3,
  signatoryEmail: 3,
};

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function CheckoutFlow({
  initialPlan,
  initialInterval = "month",
  initialState,
  lockedEmail,
  returnedFromPayment = false,
  salesTax = false,
  demo,
  onClose,
  onProgress,
  downloadHost,
}: {
  /**
   * A pricing card or package id, from a pricing card or `?plan`. Anything
   * else, or nothing, preselects nothing: the buyer chooses.
   */
  initialPlan?: string;
  /** A billing interval chosen before the flow opened (the retired /pricing had a toggle). */
  initialInterval?: BillingInterval;
  /** Prefill from the setup link or the demo. */
  initialState?: CheckoutSeed;
  /**
   * The address a setup link was sent to. The purchase is bound to it
   * (lib/setup-gate.ts refuses any other at signing and at payment), so the
   * field shows it and cannot be edited.
   */
  lockedEmail?: string;
  /** Stripe's cancel page sent the buyer back (`/get-started?cancelled=1`). */
  returnedFromPayment?: boolean;
  /** STRIPE_AUTOMATIC_TAX, read on the server: "Plus sales tax where it applies". */
  salesTax?: boolean;
  /**
   * The buyer came from their personalised demo (components/checkout/
   * DemoPackageExtras.tsx): grouped packages with estimates, the offer and its
   * clock, and the clinic step shows what the demo already knows instead of
   * asking again. The offer's price is `offerEndsAt` being set: it is the
   * server's decision (api/checkout), shown here, never made here.
   */
  demo?: DemoCheckout;
  /** Present only when hosted in something dismissable. */
  onClose?: () => void;
  onProgress?: (progress: CheckoutProgress) => void;
  downloadHost?: DownloadHost;
}) {
  const explicitPlan = Boolean(initialPlan && checkoutStart(initialPlan));
  const seed = useCallback(
    () =>
      initialFunnel({
        ...initialState,
        plan: explicitPlan ? initialPlan : null,
        interval: initialInterval,
        contactEmail: lockedEmail ?? initialState?.contactEmail,
      }),
    [explicitPlan, initialPlan, initialInterval, initialState, lockedEmail],
  );

  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState<FunnelState>(seed);
  const [agreement, setAgreement] = useState<StoredAgreement | null>(null);
  const [siteRead, setSiteRead] = useState<SiteRead | null>(null);
  /** Never stored: a box that arrives ticked is not assent. */
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ step: StepNumber; field: string | null; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  /** One-way per agreement: once the buyer has been handed the text, the link stays the text. */
  const [pdfUnavailable, setPdfUnavailable] = useState(false);
  const [pdfPending, setPdfPending] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const lastStep = useRef<StepNumber | null>(null);

  const startRead = useCallback((website: string) => {
    const pending: SiteRead = { status: "pending", website };
    setSiteRead(pending);
    storeSiteRead(pending);
    void requestSiteRead(website).then((read) => {
      // A read of a website the buyer has since changed is kept for that
      // website only; the purchase sends it only if the two still match.
      setSiteRead((current) => (current === null || current.website === website ? read : current));
      const stored = readStoredSiteRead();
      if (stored === null || stored.website === website) storeSiteRead(read);
    });
  }, []);

  /**
   * Restore this tab's answers, after the first paint and never during it:
   * the server renders without sessionStorage, and a first client render
   * that differed from it would be a hydration error.
   */
  useEffect(() => {
    const stored = readStoredFunnel();
    const restored = restoreFunnel(seed(), stored, { explicitPlan, lockedEmail });
    const storedAgreement = readStoredAgreement();
    const signedFor = sameAgreementInputs(storedAgreement?.inputs, agreementInputs(restored));
    const read = readStoredSiteRead();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage, read after hydration (see above)
    setState({ ...restored, step: resumeStep(restored, signedFor, returnedFromPayment) });
    setAgreement(storedAgreement);
    setSiteRead(read);
    // A read this tab started and never heard back from (a reload mid-read)
    // is asked for again; the server's own limits decide whether it runs.
    if (read?.status === "pending") startRead(read.website);
    if (returnedFromPayment) setNotice(RETURNED_NOTICE);
    // Applied once: a reload must come back to the buyer's own later choices,
    // not to the package the link named or the cancel notice. The campaign
    // and lead ids stay, for attribution at Pay.
    if (explicitPlan || returnedFromPayment) {
      try {
        const url = new URL(window.location.href);
        for (const key of ["plan", "interval", "cancelled"]) url.searchParams.delete(key);
        window.history.replaceState(window.history.state, "", url.toString());
      } catch {
        // The answers are restored either way.
      }
    }
    setHydrated(true);
    // Once, on mount: later prop changes must not overwrite what the buyer typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (hydrated && !done) storeFunnel(state);
  }, [state, hydrated, done]);

  const plan = chosenPlan(state);
  const inputs = agreementInputs(state);
  const signedFor = agreement !== null && sameAgreementInputs(agreement.inputs, inputs);
  const validAgreement: AgreementResult | null = signedFor ? agreement : null;
  // Never past a step that is not complete, whatever the stored step says.
  const step = resumeStep(state, signedFor, false);

  useEffect(() => {
    onProgress?.({ step, signed: signedFor, done });
  }, [step, signedFor, done, onProgress]);

  // The funnel step, the package and the interval, never a form field. A
  // no-op until analytics is live.
  useEffect(() => {
    if (hydrated) track("checkout_step", { step, plan: plan?.id, interval: state.interval });
  }, [hydrated, step, plan?.id, state.interval]);

  // A new step starts at its title: scrolled to the top on the page (the
  // modal resets its own scroll), and focused for a keyboard or screen
  // reader, but never on the first paint.
  useEffect(() => {
    if (!hydrated) return;
    if (lastStep.current !== null && lastStep.current !== step) {
      if (!onClose) window.scrollTo({ top: 0 });
      headingRef.current?.focus({ preventScroll: true });
    }
    lastStep.current = step;
  }, [hydrated, step, onClose]);

  const update = (patch: Partial<FunnelState>) => setState((s) => ({ ...s, ...patch }));
  const go = (to: StepNumber) => {
    setError(null);
    setNotice(null);
    setState((s) => ({ ...s, step: to }));
  };

  function continueFromClinic() {
    if (!clinicComplete(state)) return;
    const website = purchaseWebsite(state);
    // Read once per website, in the background, while the buyer reads the
    // agreement. A failed read is not retried: setup asks instead.
    if (website && siteRead?.website !== website) startRead(website);
    go(3);
  }

  function signed(result: AgreementResult) {
    const signedInputs = agreementInputs(state);
    if (!signedInputs) return;
    const stored: StoredAgreement = { ...result, inputs: signedInputs };
    setAgreement(stored);
    storeAgreement(result, signedInputs);
    // Scoped to one agreement: the last one's failed download says nothing about this one's.
    setPdfUnavailable(false);
    go(4);
  }

  function resign() {
    setAgreement(null);
    clearStoredAgreement();
    setPdfUnavailable(false);
  }

  async function pay() {
    if (!plan || !validAgreement) return;
    const website = purchaseWebsite(state) ?? null;
    const { profile, profileStatus } = profileForPurchase(siteRead, website);

    setSubmitting(true);
    setError(null);
    let leaving = false;
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: plan.id,
          interval: state.interval,
          clinicName: state.clinicName.trim(),
          specialty: state.specialty,
          website,
          bookingSystem: state.bookingSystem,
          calendarAccount: state.calendarAccount,
          contactName: state.contactName.trim(),
          contactEmail: (lockedEmail ?? state.contactEmail).trim(),
          contactTitle: state.contactTitle.trim() || undefined,
          // The signature itself, not a claim about it, and the answer that
          // chose its covered-entity paragraph, which apps/app matches
          // against what was signed.
          agreementId: validAgreement.agreementId,
          covered: asksCovered(state) ? state.covered : null,
          profile,
          profileStatus,
          // A fallback for the clinic's own time zone, which setup confirms.
          timezone: browserTimeZone(),
          termsAccepted,
          termsVersion: LEGAL_VERSION,
          // Attribution: validated on the server, which drops what it cannot verify.
          campaign: campaignCode(),
          leadId: leadIdFromUrl(),
        }),
      });

      const data = (await response.json().catch(() => null)) as {
        error?: string;
        field?: string;
        clinicSlug?: string;
        checkoutUrl?: string;
      } | null;

      if (!response.ok) {
        refused(data?.field ?? null, data?.error ?? "Something went wrong. Please try again.");
        return;
      }

      // Pay at Stripe; the account is made once the first invoice is paid.
      // The button stays disabled through the redirect, so a second press
      // cannot open a second session.
      if (data?.checkoutUrl) {
        leaving = true;
        window.location.assign(data.checkoutUrl);
        return;
      }

      // No Stripe configured (development): the account already exists.
      clearStoredFunnel();
      clearStoredAgreement();
      storeSiteRead(null);
      setDone(true);
    } catch {
      setError({ step: 4, field: null, message: "Network error. Nothing has been charged. Please try again." });
    } finally {
      if (!leaving) setSubmitting(false);
    }
  }

  /** Send the buyer to the step the refusal is about, with the reason. */
  function refused(field: string | null, message: string) {
    if (field === "profile") {
      // The read didn't hold up; the purchase goes on without it, and setup asks instead.
      const website = purchaseWebsite(state);
      if (website) {
        const failed: SiteRead = { status: "failed", website };
        setSiteRead(failed);
        storeSiteRead(failed);
      }
      setError({ step: 4, field, message: "We couldn't use what we read from your website, so setup will ask instead. Press Pay again." });
      return;
    }
    if (field === "agreementId") resign();
    const step = (field && FIELD_STEP[field]) || 4;
    setError({ step, field, message });
    setState((s) => ({ ...s, step }));
  }

  /**
   * Take over the plain click on the PDF link so a failure can degrade to the
   * text the server recorded, which the PDF only presents. Anything but an
   * unmodified primary click is left to the browser.
   */
  async function downloadPdf(event: MouseEvent<HTMLAnchorElement>, href: string, filename: string) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    if (pdfPending) return;
    setPdfPending(true);

    // Our own deadline: the route's eight seconds end at our server, and the
    // hop from this browser to it has none.
    const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), PDF_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(href, {
        // The cookie set at signing is the whole authorisation.
        credentials: "same-origin",
        headers: { Accept: "application/pdf" },
        signal: controller.signal,
      });
      // A 200 with JSON or an HTML error page would otherwise be saved under
      // a .pdf name, which is worse than a link that admits it could not.
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !type.toLowerCase().includes("application/pdf")) {
        setPdfUnavailable(true);
        return;
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filenameFrom(response.headers.get("content-disposition"), filename);
      const host = downloadHost?.() ?? document.body;
      host.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch {
      setPdfUnavailable(true);
    } finally {
      window.clearTimeout(deadline);
      setPdfPending(false);
    }
  }

  if (!hydrated) {
    return (
      <p className="text-muted py-16 text-center text-sm font-semibold" role="status">
        One moment…
      </p>
    );
  }

  if (done) return <Complete email={(lockedEmail ?? state.contactEmail).trim()} onClose={onClose} />;

  const fileStem = inputs ? (agreementCopyFor(inputs.kind)?.fileStem ?? "healdesk-agreement") : "healdesk-agreement";
  const copyLink = (label?: string) =>
    validAgreement ? (
      <AgreementCopyLink
        agreement={validAgreement}
        unavailable={pdfUnavailable}
        pending={pdfPending}
        label={label}
        fileStem={fileStem}
        onPdfClick={(event, href, filename) => void downloadPdf(event, href, filename)}
      />
    ) : null;

  if (step === 1) {
    return (
      <PackageStep
        state={state}
        onCard={(cardId) => setState((s) => chooseCard(s, cardId))}
        onChat={(chat: ChatChannel) => setState((s) => chooseChat(s, chat))}
        onInterval={(interval) => update({ interval })}
        onContinue={() => go(2)}
        onClose={onClose}
        headingRef={headingRef}
        error={error?.step === 1 ? error.message : null}
        demo={demo}
        onPlan={(planId) => setState((s) => choosePlan(s, planId))}
      />
    );
  }

  if (step === 2) {
    return (
      <ClinicStep
        state={state}
        update={update}
        onPlan={(planId) => setState((s) => choosePlan(s, planId))}
        onBack={() => go(1)}
        onContinue={continueFromClinic}
        fromDemo={Boolean(demo)}
        onClose={onClose}
        headingRef={headingRef}
        error={error?.step === 2 && error.field ? { field: error.field, message: error.message } : null}
      />
    );
  }

  if (step === 3 && state.specialty && state.bookingSystem && state.calendarAccount) {
    const stale = agreement !== null && !signedFor;
    return (
      <AgreementStep
        // "Sign again with different answers" is a new screen, not the old
        // one redrawn: the document unread, the assent box unticked.
        key={validAgreement ? "signed" : "unsigned"}
        step={3}
        totalSteps={TOTAL_STEPS}
        onBack={() => go(2)}
        onClose={onClose}
        headingRef={headingRef}
        clinicName={state.clinicName.trim()}
        specialty={state.specialty}
        bookingSystem={state.bookingSystem}
        calendarAccount={state.calendarAccount}
        covered={state.covered}
        onCovered={(covered: CoveredAnswer) => update({ covered })}
        contactName={state.contactName}
        contactTitle={state.contactTitle}
        contactEmail={lockedEmail ?? state.contactEmail}
        onContact={(field, value) =>
          update(
            field === "contactName"
              ? { contactName: value }
              : field === "contactTitle"
                ? { contactTitle: value }
                : { contactEmail: value },
          )
        }
        lockedEmail={lockedEmail}
        signed={validAgreement}
        copyLink={copyLink()}
        notice={error?.step === 3 ? error.message : stale ? CHANGED_NOTICE : null}
        onSigned={signed}
        onContinue={() => go(4)}
        onResign={resign}
      />
    );
  }

  if (step === 4 && plan && validAgreement) {
    const website = purchaseWebsite(state) ?? null;
    return (
      <ReviewStep
        plan={plan}
        interval={state.interval}
        specialty={state.specialty}
        clinicName={state.clinicName.trim()}
        siteRead={siteReadLine(siteRead, website)}
        salesTax={salesTax}
        agreement={validAgreement}
        copyLink={copyLink("Download")}
        termsAccepted={termsAccepted}
        onTerms={setTermsAccepted}
        submitting={submitting}
        error={error?.step === 4 ? error.message : null}
        notice={notice}
        onPay={() => void pay()}
        onBack={() => go(3)}
        onClose={onClose}
        headingRef={headingRef}
        setupCreditUsd={demo?.offerEndsAt ? demoSetupCreditUsd(plan) : 0}
      />
    );
  }

  // Unreachable: resumeStep never lands past an incomplete step.
  return null;
}

function Complete({ email, onClose }: { email: string; onClose?: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[560px] text-center">
      {/* Success is its own colour, not the brand gradient, which every call
          to action in the flow uses. Ink on Light Green is 8.4:1. */}
      <div className="bg-mint text-ink mx-auto grid size-14 place-items-center rounded-full text-2xl">
        ✓
      </div>
      <h1 className="font-display mt-6 text-[clamp(31.2px,4.32vw,45.6px)] leading-tight font-medium tracking-[-0.024em]">
        You&apos;re set up.
      </h1>
      {/* Reached only on the unpaid development path (no Stripe keys), where
          apps/app has already created the account. On the paid path the buyer
          leaves for Stripe and comes back to apps/app's /welcome. */}
      <p className="text-muted mt-4 text-[19.2px] font-medium">
        Your agreement is signed and on file, and we&apos;ve emailed a copy to{" "}
        <strong className="text-ink">{email}</strong>.
      </p>
      <p className="text-muted mt-6 text-sm">
        Setup opens from the sign-in link in your welcome email: confirm your services, prices
        and hours, set how she behaves, connect your Google Calendar, then connect each channel.
      </p>

      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className="border-line-strong text-ink hover:border-ink mt-8 min-h-11 rounded-full border-[1.5px] px-6 py-3 text-sm font-bold transition-colors"
        >
          Back to the demo
        </button>
      ) : null}
    </div>
  );
}
