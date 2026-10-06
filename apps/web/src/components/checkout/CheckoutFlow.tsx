"use client";

import {
  type BillingInterval,
  cardForPlan,
  type ChatChannel,
  chatChannelOf,
  getPricingCard,
  META_SOLD_ALONE,
  NO_PLATFORM_ID,
  offersChatChoice,
  type Plan,
  planForCard,
  platforms,
  type PricingCard,
  pricingCards,
  sellsMetaAlone,
  specialties,
  supportsVerifiedAttribution,
} from "@healdesk/catalog";
import { type MouseEvent, useEffect, useMemo, useState } from "react";

import { track } from "@/lib/analytics";
import { campaignCode, leadIdFromUrl } from "@/lib/attribution";
import {
  clearStoredAgreement,
  readStoredAgreement,
  storeAgreement,
} from "@/lib/agreement-recovery";
import {
  allowanceRows,
  annualSavingsPercent,
  channelChips,
  CHAT_CHANNEL_CHOICES,
  checkoutStart,
  cheapestPlan,
  dueToday,
  monthlyFigureUsd,
  usd,
} from "@/lib/pricing";

import { AgreementStep, type AgreementResult } from "./AgreementStep";
import {
  ChoiceCard,
  PrimaryButton,
  Reassurance,
  StepShell,
} from "./StepShell";

/**
 * The purchase flow.
 *
 * Six steps, and nothing is connected during checkout. In v1 the clinic
 * connects its Google Calendar and its channels in the onboarding wizard after
 * the first invoice is paid (docs/v1-product-spec.md, "Stage 2, the wizard").
 * The booking system asked at step 2 tells us whether she can book live: a
 * system that reads Google Calendar for conflicts can, and Mindbody (one-way)
 * and Boulevard (unverified) run with staff confirming each booking.
 *
 * "No booking software" is a first-class option, not a fallback. Those clinics
 * have the most primitive front desk and therefore the most leakage. They are
 * the best prospects, and the copy must not read as a downgrade.
 *
 * ## Revenue attribution is phase two, and fenced out of this flow
 *
 * Step 3 used to offer "Verified" reporting: read-only access to the clinic's
 * point of sale, so a recovered call could be followed through to collected
 * revenue. That is phase two, not v1, and v1 may not claim it. The code is
 * kept behind VERIFIED_ATTRIBUTION_OFFERED below, which is false, so every
 * buyer goes through on "estimated". Step 3 still asks for the value of one
 * booked appointment only because apps/app provisioning, as written today,
 * refuses an "estimated" signup without it; once provisioning stops requiring
 * it, the step can go. The choice also selects the BAA variant AgreementStep
 * renders, so with the fence in place every clinic signs the variant that
 * describes no point-of-sale connection, which is the truth in v1.
 *
 * ## Signing is step 5, payment is step 6, and that order is load-bearing
 *
 * A healthcare provider may not hand patient information to a supplier without
 * a written contract first. So the business associate agreement is not a
 * checkbox beside the price. It is its own step, and it is RECORDED IN THE
 * DATABASE before the buyer ever sees a payment form. Step 6 carries only the
 * resulting agreement id.
 *
 * The visible consequence is that abandoning at step 6 leaves a signed
 * agreement with no account behind it. That is correct: far better to hold a
 * signed agreement for a deal that never closed than to take money for an
 * account with no agreement.
 */

const TOTAL_STEPS = 6;

/** Phase two. See "Revenue attribution is phase two" above. Keep false in v1. */
const VERIFIED_ATTRIBUTION_OFFERED = false;

/**
 * How long this browser waits for its own server before it stops calling the
 * PDF a download and starts calling it a fallback. See `downloadPdf`.
 *
 * Comfortably above the route's own eight-second budget for apps/app plus a
 * cold start of our own function, because a client deadline that fires first
 * would report a working PDF as broken.
 */
const PDF_REQUEST_TIMEOUT_MS = 15_000;

export type State = {
  specialty: string;
  platform: string;
  attributionMode: "estimated" | "verified";
  averageTreatmentValueUsd: string;
  clinicName: string;
  contactName: string;
  contactEmail: string;
  contactTitle: string;
  /**
   * Discovery question B, from when the product texted. v1 sends no SMS, so
   * the question is no longer asked; the field stays "unknown" so the
   * provisioning request keeps its shape.
   */
  phoneSystemType: "landline" | "voip" | "unknown";
  /**
   * Which calls forward to AYA. "conditional" is overflow and after hours,
   * the spec's default coverage mode; "always" is all calls. The third mode,
   * after hours only, is chosen in the onboarding wizard.
   */
  callRouting: "conditional" | "always";
};

const INITIAL: State = {
  specialty: "",
  platform: "",
  attributionMode: "estimated",
  averageTreatmentValueUsd: "",
  clinicName: "",
  contactName: "",
  contactEmail: "",
  contactTitle: "",
  // Not a guess. An assumed "landline" fails during setup, in front of the
  // customer; "unknown" routes it to a check instead.
  phoneSystemType: "unknown",
  callRouting: "conditional",
};

/**
 * Where the PDF download anchor is attached.
 *
 * Defaults to the body, which is correct on the standalone page. Inside a
 * <dialog> opened with showModal() the entire document outside the dialog is
 * INERT, so an anchor parked on the body is in an inert subtree, and whether a
 * programmatic click on an inert anchor still downloads is not something worth
 * discovering from a support ticket. The modal passes its own dialog element.
 */
export type DownloadHost = () => HTMLElement | null;

/** Reported upward so a host can decide whether it is safe to close. */
export type CheckoutProgress = {
  step: number;
  /** A BAA has been signed and recorded. Closing now strands it. */
  signed: boolean;
  done: boolean;
};

export function CheckoutFlow({
  initialPlan,
  initialInterval = "month",
  initialState,
  onClose,
  onProgress,
  downloadHost,
}: {
  initialPlan: string;
  /** From the toggle on /pricing, so the buyer lands on the terms they chose. */
  initialInterval?: BillingInterval;
  /** Prefill from wherever the buyer came from. Step 1 is still shown. */
  initialState?: Partial<State>;
  /** Present only when hosted in something dismissable. */
  onClose?: () => void;
  onProgress?: (progress: CheckoutProgress) => void;
  downloadHost?: DownloadHost;
}) {
  const [step, setStep] = useState(1);
  const [state, setState] = useState<State>(() => ({ ...INITIAL, ...initialState }));
  // `initialPlan` may name a card or a package; see checkoutStart.
  const [start] = useState(
    () => checkoutStart(initialPlan) ?? { card: cardForPlan(cheapestPlan()), chat: "web" as const },
  );
  const [cardId, setCardId] = useState(start.card.id);
  const [interval, setBillingInterval] = useState<BillingInterval>(initialInterval);
  /**
   * Which twin a "Web OR Meta" card sells. Defaults to the website, because a
   * web widget is live the day provisioning finishes while a Meta connection
   * waits on the clinic's Business account, and a default that cannot stall
   * setup is the right one. Ignored on a card without the choice.
   */
  const [chatChannel, setChatChannel] = useState<ChatChannel>(start.chat);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [done, setDone] = useState<{ clinicSlug: string } | null>(null);
  /**
   * Set at step 5. Step 6 cannot submit without it.
   *
   * Mirrored into sessionStorage, and that mirror is load-bearing rather than a
   * nicety. The signature writes a row to an append-only acceptance table and
   * returns an id that, until now, lived in this one React cell, so losing the
   * component lost the only handle on a contract the buyer had legally signed.
   * Signing again produces a second row for one act of assent, which is exactly
   * the record AgreementStep's own notice copy exists to avoid.
   *
   * A modal makes that loss one keystroke away, and Stripe's cancel path makes
   * it a normal outcome: it lands on /get-started as a fresh mount. Same tab
   * either way, so sessionStorage survives both and the buyer resumes at step 6
   * instead of re-signing.
   */
  const [agreement, setAgreement] = useState<AgreementResult | null>(null);
  /**
   * The PDF could not be produced or fetched, so step 6 offers the text
   * instead. One-way on purpose: once the buyer has been handed the fallback,
   * flipping the block back to a PDF link under their cursor because a retry
   * would now succeed is worse than leaving them with the copy that works.
   */
  const [pdfUnavailable, setPdfUnavailable] = useState(false);
  const [pdfPending, setPdfPending] = useState(false);

  /**
   * Rehydrate a signature this browser already made, before first paint.
   *
   * Only the agreement is restored, never the form fields: the form is cheap to
   * retype and restoring a half-filled clinic name into a fresh session is
   * surprising, whereas an orphaned signature is unrecoverable.
   */
  useEffect(() => {
    if (agreement) return;
    const stored = readStoredAgreement();
    if (!stored) return;
    setAgreement(stored);
    // Land them where the signature left them, not at the start.
    setStep((current) => (current < 6 ? 6 : current));
  }, [agreement]);

  useEffect(() => {
    onProgress?.({ step, signed: Boolean(agreement), done: Boolean(done) });
  }, [step, agreement, done, onProgress]);

  const card = getPricingCard(cardId) ?? cardForPlan(cheapestPlan());
  /**
   * The package actually bought. Meta on its own is not sold until Meta's App
   * Review passes, so on the "Web OR Meta Chatbot" card the website is the
   * only answer; a "meta" picked on the card with the phone and carried over
   * by switching cards must not reach the route, which would refuse it.
   */
  const picked = planForCard(card, chatChannel);
  const plan =
    !META_SOLD_ALONE && sellsMetaAlone(picked) ? planForCard(card, "web") : picked;
  const chatChoice = chatChannelOf(plan);

  // Funnel step, with the package and interval — never a form field. Fires
  // only once analytics is live (consent given), no-op otherwise.
  useEffect(() => {
    track("checkout_step", { step, plan: plan.id, interval });
  }, [step, plan.id, interval]);
  const platform = useMemo(
    () => platforms.find((p) => p.id === state.platform),
    [state.platform],
  );

  const set = <K extends keyof State>(key: K, value: State[K]) =>
    setState((s) => ({ ...s, [key]: value }));

  const next = () => setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  const back = () => setStep((s) => Math.max(s - 1, 1));

  async function submit() {
    setSubmitting(true);
    setError(null);
    setErrorField(null);

    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clinicName: state.clinicName.trim(),
          specialty: state.specialty,
          platform: state.platform,
          attributionMode: state.attributionMode,
          averageTreatmentValueUsd:
            state.attributionMode === "estimated"
              ? Number(state.averageTreatmentValueUsd)
              : undefined,
          plan: plan.id,
          interval,
          contactName: state.contactName.trim(),
          contactEmail: state.contactEmail.trim(),
          contactTitle: state.contactTitle.trim() || undefined,
          phoneSystemType: state.phoneSystemType,
          callRouting: state.callRouting,
          // The signature itself, not a claim about it. See AgreementStep.
          agreementId: agreement?.agreementId,
          // Attribution: the cold-email campaign remembered for this session,
          // and the lead id when the buyer arrived from a claim link. The
          // server validates both and drops what it cannot verify.
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
        setError(data?.error ?? "Something went wrong. Please try again.");
        setErrorField(data?.field ?? null);
        return;
      }

      // Stripe is configured: pay first, and the webhook provisions afterwards.
      // Deliberately not `setSubmitting(false)` before leaving, the button
      // stays disabled through the redirect so a double-click cannot open two
      // checkout sessions.
      if (data?.checkoutUrl) {
        window.location.assign(data.checkoutUrl);
        return;
      }

      // No Stripe configured (development): the account already exists.
      clearStoredAgreement();
      setDone({ clinicSlug: data?.clinicSlug ?? "" });
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Take over the plain click on the PDF link so a failure can degrade.
   *
   * The anchor is a real anchor: it has an href, so the context menu, a
   * middle-click, a cmd-click and the keyboard all behave the way the browser
   * decides, and this handler stands aside for every one of them. What it
   * takes is the unmodified primary click, including the one Enter fires on a
   * focused link, because that is the case where a failed download would
   * replace the last screen before payment with an error page.
   *
   * Why it can fail at all: the PDF is served only to the session that signed,
   * against a cookie set at signature time that is dead after thirty minutes.
   * A buyer who reads the plan page for half an hour is the ordinary case
   * here, not the exotic one, and so is a renderer that is simply down.
   *
   * None of that is fatal, because the PDF was never the record. The stored
   * text is, this component already holds the copy the server hashed, and the
   * block below swaps to it. A buyer must not reach the payment step with no
   * way to keep what they signed.
   */
  async function downloadPdf(
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
    filename: string,
  ) {
    // Let the browser have anything that is not a plain left click. Rewriting
    // what cmd-click means costs more than the rare error tab it would save.
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

    /**
     * Our own deadline, because the route's is not ours to inherit.
     *
     * /api/agreement/pdf gives up on apps/app after eight seconds precisely so
     * that a slow renderer degrades instead of hanging, and that promise ends
     * at our own server. The hop from this browser to it has no such budget: a
     * front desk whose wi-fi drops mid-request, a captive portal, a proxy
     * holding the socket open. A fetch with nothing to time it out leaves this
     * link reading "Preparing your copy…" for as long as the buyer is willing
     * to look at it, on the last screen before payment, which is the one
     * outcome the whole fallback exists to prevent.
     */
    const controller = new AbortController();
    const deadline = window.setTimeout(
      () => controller.abort(),
      PDF_REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(href, {
        // The cookie is the whole authorisation. Without it this is a 401, and
        // that is the point: the reference above is not a credential.
        credentials: "same-origin",
        headers: { Accept: "application/pdf" },
        // Covers the body as well as the headers: an abort while `blob()` is
        // still reading rejects into the catch below, and nothing has been
        // saved by then, so a truncated file is never what the buyer keeps.
        signal: controller.signal,
      });

      // The content type is checked as well as the status, because the failure
      // this guards against is not an error but a success: anything that
      // answers 200 with JSON or an HTML error page would otherwise be saved
      // under a .pdf name, and a file that will not open is a worse thing to
      // hand someone than a link that admitted it could not.
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !type.toLowerCase().includes("application/pdf")) {
        setPdfUnavailable(true);
        return;
      }

      // Saved from the bytes already in hand rather than by navigating again,
      // so the file the buyer keeps is the one this request checked.
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      // The server's name, not ours. See filenameFrom below: intercepting the
      // click is what makes `download` win over Content-Disposition, so this is
      // the one path where the two could disagree, and the fix is to ask.
      link.download = filenameFrom(
        response.headers.get("content-disposition"),
        filename,
      );
      // Not document.body when hosted in a modal: showModal() makes the whole
      // document outside the dialog inert, and an anchor parked there is in an
      // inert subtree. The host supplies its own element.
      const host = downloadHost?.() ?? document.body;
      host.appendChild(link);
      link.click();
      link.remove();
      // Not revoked synchronously: some browsers have not started reading the
      // blob by the time click() returns, and revoking here saves nothing.
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch {
      // The abort lands here too. A download that timed out is a failed one,
      // and it takes the same route out as every other failure.
      setPdfUnavailable(true);
    } finally {
      window.clearTimeout(deadline);
      setPdfPending(false);
    }
  }

  if (done) return <Complete email={state.contactEmail} onClose={onClose} />;

  // --- Step 1: specialty ----------------------------------------------------
  if (step === 1) {
    return (
      <StepShell
        step={1}
        totalSteps={TOTAL_STEPS}
        onClose={onClose}
        eyebrow="Get started"
        title="What kind of clinic is this?"
        subtitle="It sets how the agent talks about treatments, pricing and scheduling."
      >
        <div className="grid gap-3">
          {specialties.map((s) => (
            <ChoiceCard
              key={s.id}
              selected={state.specialty === s.id}
              onSelect={() => {
                set("specialty", s.id);
                next();
              }}
              title={s.name}
            />
          ))}
        </div>
        <Reassurance />
      </StepShell>
    );
  }

  // --- Step 2: platform -----------------------------------------------------
  if (step === 2) {
    const bookable = platforms.filter((p) => p.id !== NO_PLATFORM_ID);
    const none = platforms.find((p) => p.id === NO_PLATFORM_ID)!;

    return (
      <StepShell
        step={2}
        totalSteps={TOTAL_STEPS}
        onClose={onClose}
        eyebrow="Get started"
        title="What do you use for booking?"
        subtitle="She books into your Google Calendar. This tells us whether your booking system will see those bookings, or whether your staff confirm each one in it. She answers either way."
        onBack={back}
      >
        <div className="grid gap-3">
          {bookable.map((p) => (
            <ChoiceCard
              key={p.id}
              selected={state.platform === p.id}
              onSelect={() => {
                set("platform", p.id);
                // A calendar we write into (Cal.com) holds no revenue and no
                // arrival, so verified reporting is impossible through it.
                // Step 3 hides the Verified card for it, but hiding a card
                // does not change state: a buyer who chose Verified for
                // Boulevard and then came back here would carry "verified"
                // into a request provisioning rejects. Force it, the same way
                // "No booking software" below does.
                if (!VERIFIED_ATTRIBUTION_OFFERED || !supportsVerifiedAttribution(p)) {
                  set("attributionMode", "estimated");
                }
                next();
              }}
              // No description and no "One click" badge: the catalog's
              // platform notes describe how phase two would read revenue back
              // out of each system, which v1 does not do and may not claim.
              title={p.name}
            />
          ))}

          <div className="border-line mt-3 border-t pt-4">
            <ChoiceCard
              selected={state.platform === none.id}
              onSelect={() => {
                set("platform", none.id);
                // Verified attribution needs something to read from.
                set("attributionMode", "estimated");
                next();
              }}
              title={none.name}
              description="Nothing missing: she answers, and books straight into the Google Calendar you connect during setup."
            />
          </div>
        </div>
        <Reassurance />
      </StepShell>
    );
  }

  // --- Step 3: value of a booking ------------------------------------------
  // Phase-two attribution is fenced off (see the header), so this step shows
  // only the value field. The Verified card stays in the code, unreachable.
  if (step === 3) {
    const canVerify =
      VERIFIED_ATTRIBUTION_OFFERED && platform ? supportsVerifiedAttribution(platform) : false;

    return (
      <StepShell
        step={3}
        totalSteps={TOTAL_STEPS}
        onClose={onClose}
        eyebrow="Get started"
        title="What is one booked appointment worth to you?"
        subtitle="A typical figure is fine. Your full price list is confirmed during setup."
        onBack={back}
      >
        <div className="grid gap-3">
          {canVerify ? (
            <ChoiceCard
              selected={state.attributionMode === "estimated"}
              onSelect={() => set("attributionMode", "estimated")}
              title="Estimated"
              description="Nothing to connect."
              badge="Default"
            />
          ) : null}
          {canVerify ? (
            <ChoiceCard
              selected={state.attributionMode === "verified"}
              onSelect={() => set("attributionMode", "verified")}
              title="Verified"
              description={`Connect read-only access to ${platform?.name}. We read your actual settled sales, so the figures are measured rather than estimated. Adds about five minutes. We'll walk you through it after checkout.`}
            />
          ) : null}
        </div>

        {state.attributionMode === "estimated" ? (
          <div className="border-line mt-6 rounded-2xl border bg-white p-5">
            <label className="block">
              <span className="text-[15.6px] font-bold tracking-[0.04em] uppercase">
                Average value of one booked appointment
              </span>
              <span className="text-muted mt-1 block text-sm">
                Your best estimate is fine; we ask rather than guess from a
                specialty average.
              </span>
              <span className="border-line focus-within:border-orange mt-3 flex items-center gap-2 rounded-xl border px-4 py-3 transition-colors">
                <span className="text-muted font-semibold">$</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={state.averageTreatmentValueUsd}
                  onChange={(e) =>
                    set("averageTreatmentValueUsd", e.target.value)
                  }
                  placeholder="550"
                  className="text-ink placeholder:text-muted w-full bg-transparent text-[19.2px] outline-none"
                />
              </span>
            </label>
          </div>
        ) : null}

        <div className="mt-8">
          <PrimaryButton
            onClick={next}
            disabled={
              state.attributionMode === "estimated" &&
              !(Number(state.averageTreatmentValueUsd) > 0)
            }
          >
            Continue
          </PrimaryButton>
        </div>
        <Reassurance />
      </StepShell>
    );
  }

  // --- Step 4: details ------------------------------------------------------
  if (step === 4) {
    const ready =
      state.clinicName.trim().length > 1 &&
      state.contactName.trim().length > 1 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(state.contactEmail.trim());

    return (
      <StepShell
        step={4}
        totalSteps={TOTAL_STEPS}
        onClose={onClose}
        eyebrow="Get started"
        title="Who are we setting this up for?"
        onBack={back}
      >
        <div className="grid gap-4">
          <Field
            label="Clinic name"
            value={state.clinicName}
            onChange={(v) => set("clinicName", v)}
            placeholder="Radiance Med Spa"
            invalid={errorField === "clinicName"}
          />
          <Field
            label="Your name"
            value={state.contactName}
            onChange={(v) => set("contactName", v)}
            placeholder="Alex Chen"
            invalid={errorField === "contactName"}
          />
          <Field
            label="Work email"
            type="email"
            value={state.contactEmail}
            onChange={(v) => set("contactEmail", v)}
            placeholder="alex@radiancemedspa.com"
            hint="We'll send your setup link here."
            invalid={errorField === "contactEmail"}
          />
          <Field
            label="Your title (optional)"
            value={state.contactTitle}
            onChange={(v) => set("contactTitle", v)}
            placeholder="Owner"
          />
        </div>

        {/* The phone-system question that used to sit here decided whether
            the clinic's number could be text-enabled. v1 sends no SMS of any
            kind, so it is not asked; phoneSystemType stays "unknown". */}

        {/* ---------------- Call routing ----------------
            The voice coverage mode, asked early so the default is never
            silently inherited. The spec has three modes (docs/v1-product-spec.md,
            "Coverage mode, chosen by the clinic"); the request carries two of
            them today, so the third, after hours only, is chosen in the
            onboarding wizard, and every mode can be changed later. */}
        <fieldset className="border-line mt-6 rounded-2xl border bg-white p-5">
          <legend className="text-[15.6px] font-bold tracking-[0.04em] uppercase">
            Which calls should AYA answer?
          </legend>
          <p className="text-muted mt-1.5 text-sm">
            Your published number never changes; your line forwards the calls
            you choose. You can pick after hours only during setup, and change
            it at any time.
          </p>
          <div className="mt-4 grid gap-2">
            {(
              [
                {
                  id: "conditional",
                  label: "My team answers first; AYA takes what we miss",
                  hint: "Overflow and after hours: calls forward to AYA when the line is busy, rings out, or it is outside your opening hours.",
                },
                {
                  id: "always",
                  label: "AYA answers every call",
                  hint: "All calls forward straight to AYA, day and night.",
                },
              ] as const
            ).map((option) => (
              <label
                key={option.id}
                className={[
                  "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors",
                  state.callRouting === option.id
                    ? "border-red bg-red/[0.04]"
                    : "border-line hover:border-line-strong",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="callRouting"
                  checked={state.callRouting === option.id}
                  onChange={() => set("callRouting", option.id)}
                  className="accent-red mt-1 size-4 shrink-0"
                />
                <span>
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="text-muted block text-xs">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-8">
          <PrimaryButton onClick={next} disabled={!ready}>
            Continue
          </PrimaryButton>
        </div>
        <Reassurance />
      </StepShell>
    );
  }

  // --- Step 5: sign the agreement -------------------------------------------
  // Before payment, deliberately. Its own component because it is the only step
  // that writes to the database, and the only one with legal consequences.
  if (step === 5) {
    return (
      <AgreementStep
        step={5}
        totalSteps={TOTAL_STEPS}
        onClose={onClose}
        clinicName={state.clinicName.trim()}
        specialty={
          specialties.find((s) => s.id === state.specialty)?.name ??
          state.specialty
        }
        specialtyId={state.specialty}
        // What they chose at steps 2 and 3 changes the agreement, not just the
        // product. A clinic on estimated reporting gave us no credentials, and
        // their contract must not describe a connection they declined.
        attributionMode={state.attributionMode}
        platformId={state.platform}
        platformName={
          state.platform === NO_PLATFORM_ID ? null : (platform?.name ?? null)
        }
        contactName={state.contactName.trim()}
        contactEmail={state.contactEmail.trim()}
        contactTitle={state.contactTitle.trim() || undefined}
        onBack={back}
        onSigned={(result) => {
          setAgreement(result);
          // Before advancing, so a close between here and step 6 is survivable.
          storeAgreement(result);
          // Scoped to one agreement, not to the session. Coming back to this
          // step and signing again produces a new id and a fresh cookie, and
          // the last agreement's failed download says nothing about this one's
          //, leaving the flag set would hide a PDF that now works.
          setPdfUnavailable(false);
          next();
        }}
      />
    );
  }

  // --- Step 6: plan and payment ---------------------------------------------
  return (
    <StepShell
      step={6}
      totalSteps={TOTAL_STEPS}
      eyebrow="Get started"
      title="Choose your package."
      subtitle="Your agreement is signed and on file. Nothing has been charged yet."
      onBack={back}
    >
      {/* A receipt for what already happened, not another chance to agree.
          The document itself is not repeated. They have just read it, and a
          second copy beside a price invites the reading that paying is what
          concludes it. It doesn't; signing did. */}
      <div className="border-line rounded-2xl border bg-white px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span aria-hidden className="text-red-deep font-bold">✓</span>
          <span className="text-sm font-bold">
            Business Associate Agreement signed
          </span>
          <span className="text-muted text-xs font-semibold">
            v{agreement?.version} · {signedOn(agreement?.acceptedAt)}
          </span>
        </div>
        <p className="text-muted mt-2 text-xs break-all">
          Reference {agreement?.agreementId} · SHA-256{" "}
          {agreement?.hash.slice(0, 16)}…
        </p>
        <AgreementCopyLink
          agreement={agreement}
          unavailable={pdfUnavailable}
          pending={pdfPending}
          onPdfClick={(event, href, filename) =>
            void downloadPdf(event, href, filename)
          }
        />
      </div>

      {agreement && !agreement.approvedByCounsel ? (
        <p className="border-red/30 bg-red/[0.06] mt-4 rounded-xl border px-4 py-3 text-[15.6px] font-semibold">
          This agreement is a draft pending legal review. Until it is finalised,
          accounts are created for synthetic data only and cannot receive real
          patient information.
        </p>
      ) : null}

      {/* Monthly or annual, before the cards, because it changes every price
          on them. A segmented control rather than a checkbox: "billed
          annually" as a tick box reads as an upsell, two named options read
          as a choice. */}
      <IntervalToggle value={interval} onChange={setBillingInterval} />

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {pricingCards.map((c) => (
          <PackageCard
            key={c.id}
            card={c}
            interval={interval}
            selected={c.id === card.id}
            onSelect={() => setCardId(c.id)}
          />
        ))}
      </div>

      {/* Only a "Web OR Meta" card asks. The others either include both
          chat channels or neither, and a question with one answer is noise on
          the screen where the buyer is about to pay. */}
      {offersChatChoice(card) ? (
        <ChatChannelField card={card} value={chatChoice} onChange={setChatChannel} />
      ) : null}

      <DueTodayBreakdown plan={plan} interval={interval} />

      {error ? (
        <p className="text-red-deep mt-4 text-sm font-semibold">{error}</p>
      ) : null}

      <div className="mt-8">
        <PrimaryButton
          onClick={() => void submit()}
          disabled={!agreement || submitting}
        >
          {submitting
            ? "Taking you to payment…"
            : `Pay ${usd.format(dueToday(plan, interval).totalUsd)} and start setup`}
        </PrimaryButton>
        {/* Acceptance of the commercial terms is captured at the moment of
            purchase, beside the action that spends the money. The BAA was
            signed a step earlier and governs patient information; these two
            govern everything else. */}
        <p className="text-muted mt-3 text-xs">
          By subscribing you agree to the{" "}
          <a href="/terms" className="underline underline-offset-2" target="_blank" rel="noreferrer">
            Terms of service
          </a>{" "}
          and{" "}
          <a href="/privacy" className="underline underline-offset-2" target="_blank" rel="noreferrer">
            Privacy policy
          </a>
          . Your subscription renews automatically until you cancel.
        </p>
      </div>
      <Reassurance />
    </StepShell>
  );
}

/**
 * Monthly / annual. The saving is computed from the catalog, never typed
 * here, so the badge cannot outlive the discount it describes.
 *
 * Pressed buttons rather than a radio group: `role="radio"` promises
 * arrow-key movement that two native buttons do not provide, and
 * `aria-pressed` describes exactly what these are. Same as PricingCards.
 */
function IntervalToggle({
  value,
  onChange,
}: {
  value: BillingInterval;
  onChange: (interval: BillingInterval) => void;
}) {
  const options: { id: BillingInterval; label: string; badge?: string }[] = [
    { id: "month", label: "Monthly" },
    { id: "year", label: "Annual", badge: `Save ${annualSavingsPercent()}%` },
  ];
  return (
    <div
      role="group"
      aria-label="Billing period"
      className="border-line inline-flex rounded-full border bg-white p-1"
    >
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(option.id)}
            className={[
              "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition-colors",
              on ? "bg-ink text-white" : "text-muted hover:text-ink",
            ].join(" ")}
          >
            {option.label}
            {option.badge ? (
              <span
                className={[
                  "rounded-full px-2 py-0.5 text-[11px] font-bold tracking-[0.06em] uppercase",
                  on ? "bg-white/15 text-white" : "bg-sun text-ink",
                ].join(" ")}
              >
                {option.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One pricing card, as a selectable card. A twin card shows the web package's
 * figures, which its Meta twin shares (the catalog test holds them to it).
 *
 * The price shown is always per month, even on annual, because that is how
 * the pricing page quotes it and a buyer who arrives from there must see the
 * same figure. The annual total appears in the breakdown below the cards,
 * where it is the amount actually charged.
 */
function PackageCard({
  card,
  interval,
  selected,
  onSelect,
}: {
  card: PricingCard;
  interval: BillingInterval;
  selected: boolean;
  onSelect: () => void;
}) {
  const plan = planForCard(card);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={[
        "flex w-full flex-col rounded-2xl border p-5 text-left transition-all duration-200",
        selected
          ? "border-red bg-orange/[0.06] shadow-brand"
          : "border-line hover:border-line-strong bg-white",
      ].join(" ")}
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-display text-[20.4px] leading-tight font-medium">
          {card.name}
        </span>
        {card.highlight ? (
          <span className="bg-sun text-ink rounded-full px-2 py-0.5 text-[11px] font-bold tracking-[0.06em] uppercase">
            {card.highlight}
          </span>
        ) : null}
      </span>

      <span className="mt-2 flex flex-wrap gap-1.5">
        {channelChips(card).map((chip) => (
          <span
            key={chip}
            className="bg-paper-2 text-muted rounded-full px-2 py-0.5 text-[12px] font-bold"
          >
            {chip}
          </span>
        ))}
      </span>

      <span className="font-figure mt-3 text-[26.4px] leading-none font-semibold tabular-nums">
        {usd.format(monthlyFigureUsd(plan, interval))}
        <span className="text-muted font-sans text-sm font-medium">/mo</span>
        {interval === "year" ? (
          <span className="text-muted ml-2 font-sans text-xs font-medium">
            billed annually
          </span>
        ) : null}
      </span>

      {/* Both allowance rows, an em dash for a zero — the same rows and the
          same policy as /pricing, from the same helper. */}
      <span className="text-muted mt-3 flex flex-col gap-0.5 text-sm">
        {allowanceRows(plan).map((row) => (
          <span key={row.label}>
            {row.label}: {row.value}
          </span>
        ))}
        <span>Setup {usd.format(plan.setupFeeUsd)} once</span>
      </span>
    </button>
  );
}

/**
 * Which twin a "Web OR Meta" card sells: website chat or the Meta bot.
 *
 * Exported so a test can render it on its own, as AgreementCopyLink is. While
 * Meta is not sold on its own (catalog, META_SOLD_ALONE), the choice that
 * would leave Meta as the clinic's only channel stays on screen, disabled,
 * with one line saying why: the card's name still says "or Meta", and an
 * option that silently vanished would read as a mistake.
 */
export function ChatChannelField({
  card,
  value,
  onChange,
}: {
  card: PricingCard;
  value: ChatChannel;
  onChange: (choice: ChatChannel) => void;
}) {
  const closed = (choice: ChatChannel) =>
    !META_SOLD_ALONE && sellsMetaAlone(planForCard(card, choice));
  return (
    <fieldset className="border-line mt-6 rounded-2xl border bg-white p-5">
      <legend className="text-[15.6px] font-bold tracking-[0.04em] uppercase">
        Which chat channel?
      </legend>
      <p className="text-muted mt-1.5 text-sm">
        {card.name} includes one. Website chat goes live once its one-line
        snippet is on your site. Instagram and Messenger go live as soon as
        you connect them during setup; WhatsApp once your WhatsApp account
        has a payment method on it, because Meta bills you directly for
        WhatsApp messages.
      </p>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {CHAT_CHANNEL_CHOICES.map((option) => (
          <label
            key={option.id}
            className={[
              "flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors",
              closed(option.id)
                ? "border-line cursor-not-allowed opacity-50"
                : value === option.id
                  ? "border-red bg-red/[0.04] cursor-pointer"
                  : "border-line hover:border-line-strong cursor-pointer",
            ].join(" ")}
          >
            <input
              type="radio"
              name="chatChannelChoice"
              checked={value === option.id}
              disabled={closed(option.id)}
              onChange={() => onChange(option.id)}
              className="accent-red size-4 shrink-0"
            />
            <span className="text-sm font-semibold">{option.label}</span>
          </label>
        ))}
      </div>
      {CHAT_CHANNEL_CHOICES.some((option) => closed(option.id)) ? (
        <p className="text-muted mt-3 text-xs">
          On its own, Instagram, Messenger + WhatsApp waits for Meta to approve
          our app, so this package is website chat for now.
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * What the card is charged, added up in front of the buyer.
 *
 * The lines and the total come from the same catalog helpers Stripe's line
 * items are built from, so this cannot show a total the invoice will not
 * match. Renewal is stated separately because the first invoice is the only
 * one that carries the setup fee, and a buyer who reads "$894" and assumes it
 * is the monthly price will leave.
 */
function DueTodayBreakdown({
  plan,
  interval,
}: {
  plan: Plan;
  interval: BillingInterval;
}) {
  const due = dueToday(plan, interval);
  return (
    <div className="border-line mt-6 rounded-2xl border bg-white p-5">
      <p className="text-[15.6px] font-bold tracking-[0.04em] uppercase">
        Due today
      </p>
      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted">
            {due.periodLabel} · {plan.name}
          </dt>
          <dd className="font-semibold tabular-nums">
            {usd.format(due.recurringUsd)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Setup fee, charged once</dt>
          <dd className="font-semibold tabular-nums">
            {usd.format(due.setupFeeUsd)}
          </dd>
        </div>
        <div className="border-line flex justify-between gap-4 border-t pt-2">
          <dt className="font-bold">Total</dt>
          <dd className="font-figure text-[20.4px] leading-none font-semibold tabular-nums">
            {usd.format(due.totalUsd)}
          </dd>
        </div>
      </dl>
      <p className="text-muted mt-3 text-xs">
        Renews at {due.renewsAt}. Cancel at the end of any period.
      </p>
    </div>
  );
}

/**
 * The copy the buyer takes away, in whichever format we can actually produce.
 *
 * A PDF where one can be had, because a text file is a poor thing to hand a
 * clinic that may have to produce this for its own regulator, and the PDF
 * carries the version and the hash on every page.
 *
 * The text link it falls back to is not a lesser copy, it is the authority:
 * the same string the server hashed and recorded, which the PDF is only a
 * presentation of. That is why the click is intercepted at all. The last
 * screen before payment is the wrong place to discover that keeping your own
 * contract was a thing that could fail.
 *
 * Its own component, and exported, so that the fallback can be RENDERED in a
 * test rather than reasoned about. Every branch here is a branch nobody sees
 * until something upstream is already broken, which is the worst kind to leave
 * unproved.
 */
export function AgreementCopyLink({
  agreement,
  unavailable,
  pending,
  onPdfClick,
}: {
  agreement: AgreementResult | null;
  /** The PDF could not be produced or fetched. One-way; see CheckoutFlow. */
  unavailable: boolean;
  pending: boolean;
  onPdfClick: (
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
    filename: string,
  ) => void;
}) {
  // The id is a reference, not a key: /api/agreement/pdf answers it only for
  // the browser holding the cookie that step 5 set. Pasting this URL anywhere
  // else gets a 401.
  const pdfHref = `/api/agreement/pdf?id=${encodeURIComponent(agreement?.agreementId ?? "")}`;
  const pdfName = `healdesk-baa-${agreement?.version ?? "agreement"}.pdf`;
  const textHref = `data:text/plain;charset=utf-8,${encodeURIComponent(agreement?.text ?? "")}`;
  const textName = `healdesk-baa-${agreement?.version ?? "agreement"}.txt`;
  // No id means nothing to ask the server for, so the link is the text from
  // the start rather than a PDF link that is certain to fail.
  const pdfOffered = Boolean(agreement?.agreementId) && !unavailable;

  return (
    <>
      {/* One anchor, not one per format. The href swaps; the element does not.
          A ternary around two <a> tags reads better and would have React tear
          the link down and build another, which drops focus to the top of the
          document at the exact moment a keyboard user has just activated it,
          the failure AgreementStep needed a ref and an effect to undo. Keeping
          the same node keeps the focus on it.

          It stays a real anchor with a real href in both formats, so Tab
          reaches it, Enter activates it, and the context menu, a middle-click
          and a cmd-click all still do what the browser says they do. A div
          with an onClick would have been none of that. */}
      <a
        href={pdfOffered ? pdfHref : textHref}
        download={pdfOffered ? pdfName : textName}
        onClick={
          pdfOffered
            ? (event) => onPdfClick(event, pdfHref, pdfName)
            : undefined
        }
        aria-busy={pending || undefined}
        className="text-red-deep mt-3 inline-block text-xs font-bold underline underline-offset-4"
      >
        {pending ? "Preparing your copy…" : "Download the copy you signed"}
      </a>

      {/* Said out loud, not just shown, and to a screen reader as well as to
          the screen. The link the buyer clicked has quietly become a different
          link, and a swap nobody is told about is how someone ends up clicking
          twice and trusting neither result.

          The sentence has three jobs and needs all three. It admits that the
          click produced NO FILE, because the interception means a failed
          download looks exactly like nothing happening, and a buyer who thinks
          the file already saved leaves the checkout with no copy at all. It
          says the link now gives text, since the label is unchanged and the
          swap is otherwise invisible. And it asks for the second press
          out loud: `unavailable` is only ever set from a failed click (see
          CheckoutFlow), so at the moment this renders the buyer has asked for
          their agreement once and been given nothing, and the one thing that
          must not happen on the last screen before payment is that they carry
          on to pay believing they hold a contract they do not.

          The region is always in the document, empty until it has something to
          say, because a live region is only announced when it was already
          there before its text arrived: a `role="status"` element created in
          the same commit as its first sentence is, on most screen readers, a
          sentence nobody hears. Empty it renders no text and no margin, so it
          costs the layout nothing. AgreementStep solves the same problem the
          other way, by moving focus to its notice, here focus belongs on the
          link the buyer is about to press again, so the region announces and
          the link keeps the cursor. */}
      <p
        role="status"
        aria-live="polite"
        className={unavailable ? "text-muted mt-2 text-xs" : undefined}
      >
        {unavailable
          ? "We couldn't produce the PDF, so nothing was downloaded. Use the link again for the plain text version. It is word for word what you signed, and it is the copy we recorded."
          : null}
      </p>
    </>
  );
}

/**
 * The name the server gave this file, or the one the caller guessed.
 *
 * The download route sets `Content-Disposition` from the renderer's own
 * filename, `healdesk-baa-<version>-<date>.pdf`, built there from a filtered
 * alphabet. A browser following the link plainly would use exactly that name.
 * Intercepting the click is what makes our `download` attribute win instead,
 * so this is the one path on which the file the buyer keeps could be named
 * something the server did not choose, and the two names could drift apart
 * with nothing to notice it. Reading the header back removes the second
 * opinion rather than trying to keep it in step.
 *
 * Same-origin, so the header is readable. Our own route already sanitised it,
 * and this narrows it again anyway: the value becomes a filesystem name, and a
 * download attribute is the wrong place to discover that the layer upstream
 * stopped filtering. Anything that does not survive as a `.pdf` falls back to
 * the caller's name rather than to something arbitrary.
 */
export function filenameFrom(
  disposition: string | null,
  fallback: string,
): string {
  const match = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition ?? "");
  const raw = (match?.[1] ?? match?.[2] ?? "").trim();
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.\-]+/, "")
    .slice(0, 120);
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : fallback;
}

/** "18 August 2026", from the server's timestamp rather than the browser's. */
function signedOn(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = "text",
  invalid,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  type?: string;
  invalid?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[15.6px] font-bold tracking-[0.04em] uppercase">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        className={[
          "text-ink placeholder:text-muted mt-2 w-full rounded-xl border bg-white px-4 py-3 text-[19.2px] outline-none transition-colors",
          invalid ? "border-red" : "border-line focus:border-orange",
        ].join(" ")}
      />
      {hint ? (
        <span className="text-muted mt-1.5 block text-xs">{hint}</span>
      ) : null}
    </label>
  );
}

function Complete({ email, onClose }: { email: string; onClose?: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[560px] text-center">
      {/* Success is its own colour, not the brand gradient, the gradient is
          used on every call to action in the flow, so reusing it here makes
          the finish line look like one more button. Ink on Light Green is
          8.4:1. */}
      <div className="bg-mint text-ink mx-auto grid size-14 place-items-center rounded-full text-2xl">
        ✓
      </div>
      <h1 className="font-display mt-6 text-[clamp(31.2px,4.32vw,45.6px)] leading-tight font-medium tracking-[-0.024em]">
        You&apos;re set up.
      </h1>
      {/* Reached only on the unpaid development path (no Stripe keys), where
          apps/app has already created the account. On the paid path the buyer
          leaves for Stripe and comes back to /get-started/done. In v1 the
          clinic signs in to its portal from an emailed link, so this says so
          rather than promising a password. */}
      <p className="text-muted mt-4 text-[19.2px] font-medium">
        Your agreement is signed and on file, and we&apos;ve emailed a copy to{" "}
        <strong className="text-ink">{email}</strong>.
      </p>
      <p className="text-muted mt-6 text-sm">
        Setup opens from the sign-in link in your welcome email and takes
        about fifteen minutes: confirm your services, prices and hours, set how
        she behaves, connect your Google Calendar, then connect each channel.
      </p>

      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className="border-line-strong text-ink hover:border-ink mt-8 rounded-full border-[1.5px] px-6 py-3 text-sm font-bold transition-colors"
        >
          Back to the demo
        </button>
      ) : null}
    </div>
  );
}
