"use client";

import {
  getPlan,
  NO_PLATFORM_ID,
  plans,
  platforms,
  specialties,
  supportsVerifiedAttribution,
  TRIAL_DAYS,
} from "@healdesk/catalog";
import { useMemo, useState } from "react";

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
 * Five steps, and integration is deliberately not on the critical path: the
 * default customer connects nothing, gets estimated revenue figures, and is
 * live in minutes. Choosing a booking platform is about how we'll *report*, not
 * about whether the product works.
 *
 * "No booking software" is a first-class option, not a fallback. Those clinics
 * have the most primitive front desk and therefore the most leakage — they are
 * the best prospects, and the copy must not read as a downgrade.
 *
 * ## Signing is step 5, payment is step 6, and that order is load-bearing
 *
 * A healthcare provider may not hand patient information to a supplier without
 * a written contract first. So the business associate agreement is not a
 * checkbox beside the price — it is its own step, and it is RECORDED IN THE
 * DATABASE before the buyer ever sees a payment form. Step 6 carries only the
 * resulting agreement id.
 *
 * The visible consequence is that abandoning at step 6 leaves a signed
 * agreement with no account behind it. That is correct: far better to hold a
 * signed agreement for a deal that never closed than to take money for an
 * account with no agreement.
 */

const TOTAL_STEPS = 6;

type State = {
  specialty: string;
  platform: string;
  attributionMode: "estimated" | "verified";
  averageTreatmentValueUsd: string;
  clinicName: string;
  contactName: string;
  contactEmail: string;
  contactTitle: string;
  /** Discovery question B. Decides whether their number can be text-enabled. */
  phoneSystemType: "landline" | "voip" | "unknown";
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
};

export function CheckoutFlow({ initialPlan }: { initialPlan: string }) {
  const [step, setStep] = useState(1);
  const [state, setState] = useState<State>(INITIAL);
  const [planId, setPlanId] = useState(initialPlan);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [done, setDone] = useState<{ clinicSlug: string } | null>(null);
  /** Set at step 5. Step 6 cannot submit without it. */
  const [agreement, setAgreement] = useState<AgreementResult | null>(null);

  const plan = getPlan(planId) ?? plans[0]!;
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
          contactName: state.contactName.trim(),
          contactEmail: state.contactEmail.trim(),
          contactTitle: state.contactTitle.trim() || undefined,
          phoneSystemType: state.phoneSystemType,
          // The signature itself, not a claim about it. See AgreementStep.
          agreementId: agreement?.agreementId,
        }),
      });

      const data = (await response.json().catch(() => null)) as {
        error?: string;
        field?: string;
        clinicSlug?: string;
      } | null;

      if (!response.ok) {
        setError(data?.error ?? "Something went wrong. Please try again.");
        setErrorField(data?.field ?? null);
        return;
      }

      setDone({ clinicSlug: data?.clinicSlug ?? "" });
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) return <Complete email={state.contactEmail} />;

  // --- Step 1: specialty ----------------------------------------------------
  if (step === 1) {
    return (
      <StepShell
        step={1}
        totalSteps={TOTAL_STEPS}
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
        eyebrow="Get started"
        title="What do you use for booking?"
        subtitle="This only affects how we report your recovered revenue. The agent answers your phone either way."
        onBack={back}
      >
        <div className="grid gap-3">
          {bookable.map((p) => (
            <ChoiceCard
              key={p.id}
              selected={state.platform === p.id}
              onSelect={() => {
                set("platform", p.id);
                next();
              }}
              title={p.name}
              description={p.note}
              badge={p.connection === "oauth" ? "One click" : undefined}
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
              description="You'll get everything: the AI answers every call, books appointments, and sends a monthly report. Revenue figures will be estimates from your average treatment value rather than read from a point-of-sale. You can connect a system later."
              badge="Most common"
            />
          </div>
        </div>
        <Reassurance />
      </StepShell>
    );
  }

  // --- Step 3: attribution --------------------------------------------------
  if (step === 3) {
    const canVerify = platform ? supportsVerifiedAttribution(platform) : false;

    return (
      <StepShell
        step={3}
        totalSteps={TOTAL_STEPS}
        eyebrow="Get started"
        title="How should we measure what it earns you?"
        subtitle={
          canVerify
            ? "You can change this later, and connecting is optional."
            : `${platform?.name ?? "Your setup"} has nothing for us to read from, so we'll estimate.`
        }
        onBack={back}
      >
        <div className="grid gap-3">
          <ChoiceCard
            selected={state.attributionMode === "estimated"}
            onSelect={() => set("attributionMode", "estimated")}
            title="Estimated"
            description="Nothing to connect. We calculate recovered revenue from your average treatment value. Live in minutes."
            badge="Default"
          />
          {canVerify ? (
            <ChoiceCard
              selected={state.attributionMode === "verified"}
              onSelect={() => set("attributionMode", "verified")}
              title="Verified"
              description={`Connect read-only access to ${platform?.name}. We read your actual settled sales, so the figures are measured rather than estimated. Adds about five minutes — we'll walk you through it after checkout.`}
            />
          ) : null}
        </div>

        {state.attributionMode === "estimated" ? (
          <div className="border-line mt-6 rounded-2xl border bg-white p-5">
            <label className="block">
              <span className="text-[13px] font-bold tracking-[0.04em] uppercase">
                Average value of one booked appointment
              </span>
              <span className="text-muted mt-1 block text-sm">
                Your best estimate is fine. It is the only input to the figures
                we report, so we ask rather than guess from a specialty average.
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
                  className="text-ink placeholder:text-muted w-full bg-transparent text-[16px] outline-none"
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

        {/* ---------------- Phone system ----------------
            Asked here rather than discovered during onboarding because it
            decides something we cannot work around later: a carrier will
            text-enable a landline or toll-free number, but not a VoIP one — and
            plenty of clinics publish RingCentral, Nextiva or Dialpad.

            Call forwarding works either way, so this never blocks the sale and
            is never a disqualifier. What it changes is whether the text-back
            and reminder-fallback messages can come from the clinic's own
            published number. "Not sure" is the honest default and by far the
            most common answer — an assumed "landline" just fails weeks later,
            during setup, in front of the customer. */}
        <fieldset className="border-line mt-6 rounded-2xl border bg-white p-5">
          <legend className="text-[13px] font-bold tracking-[0.04em] uppercase">
            Your main phone line
          </legend>
          <p className="text-muted mt-1.5 text-sm">
            Is the number on your website a traditional landline or toll-free
            line, or a cloud phone system like RingCentral, Nextiva or Dialpad?
            It only affects text messaging — call forwarding works either way.
          </p>

          <div className="mt-4 grid gap-2">
            {(
              [
                {
                  id: "landline",
                  label: "Landline or toll-free",
                  hint: "A traditional line from a phone company.",
                },
                {
                  id: "voip",
                  label: "Cloud phone system (VoIP)",
                  hint: "RingCentral, Nextiva, Dialpad, Grasshopper, or similar.",
                },
                {
                  id: "unknown",
                  label: "I'm not sure",
                  hint: "Completely fine — we'll check it during setup.",
                },
              ] as const
            ).map((option) => (
              <label
                key={option.id}
                className={[
                  "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors",
                  state.phoneSystemType === option.id
                    ? "border-red bg-red/[0.04]"
                    : "border-line hover:border-line-strong",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="phoneSystemType"
                  checked={state.phoneSystemType === option.id}
                  onChange={() => set("phoneSystemType", option.id)}
                  className="accent-red mt-1 size-4 shrink-0"
                />
                <span>
                  <span className="block text-sm font-semibold">
                    {option.label}
                  </span>
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
      title="Choose your plan."
      subtitle="Your agreement is signed and on file. Nothing has been charged yet."
      onBack={back}
    >
      {/* A receipt for what already happened, not another chance to agree.
          The document itself is not repeated — they have just read it, and a
          second copy beside a price invites the reading that paying is what
          concludes it. It doesn't; signing did. */}
      <div className="border-line rounded-2xl border bg-white px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span aria-hidden className="text-red font-bold">✓</span>
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
        <a
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(agreement?.text ?? "")}`}
          download={`healdesk-baa-${agreement?.version ?? "agreement"}.txt`}
          className="text-red mt-3 inline-block text-xs font-bold underline underline-offset-4"
        >
          Download the copy you signed
        </a>
      </div>

      {agreement && !agreement.approvedByCounsel ? (
        <p className="border-red/30 bg-red/[0.06] mt-4 rounded-xl border px-4 py-3 text-[13px] font-semibold">
          This agreement is a draft pending legal review. Until it is finalised,
          accounts are created for synthetic data only and cannot receive real
          patient information.
        </p>
      ) : null}

      <div className="border-line mt-8 rounded-2xl border bg-white p-5">
        <div className="flex items-baseline justify-between gap-4">
          <span className="font-display text-[19px] font-medium">
            {plan.name}
          </span>
          <span className="font-display text-[22px] font-semibold tabular-nums">
            ${plan.monthlyUsd}
            <span className="text-muted text-sm font-medium">/mo</span>
          </span>
        </div>
        <ul className="text-muted mt-3 space-y-1 text-sm">
          <li>{plan.includedMinutes.toLocaleString()} minutes included</li>
          <li>${plan.setupFeeUsd} setup</li>
          <li>{TRIAL_DAYS}-day free trial, cancel any time</li>
        </ul>
        <div className="border-line mt-4 flex flex-wrap gap-2 border-t pt-4">
          {plans.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPlanId(p.id)}
              className={[
                "rounded-full border px-3.5 py-2 text-[13px] font-semibold transition-colors",
                p.id === plan.id
                  ? "border-red text-red"
                  : "border-line text-muted hover:border-line-strong",
              ].join(" ")}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="text-red mt-4 text-sm font-semibold">{error}</p>
      ) : null}

      <div className="mt-8">
        <PrimaryButton
          onClick={() => void submit()}
          disabled={!agreement || submitting}
        >
          {submitting ? "Setting up…" : `Start ${TRIAL_DAYS}-day trial`}
        </PrimaryButton>
      </div>
      <Reassurance />
    </StepShell>
  );
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
      <span className="text-[13px] font-bold tracking-[0.04em] uppercase">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        className={[
          "text-ink placeholder:text-muted mt-2 w-full rounded-xl border bg-white px-4 py-3 text-[16px] outline-none transition-colors",
          invalid ? "border-red" : "border-line focus:border-orange",
        ].join(" ")}
      />
      {hint ? (
        <span className="text-muted mt-1.5 block text-xs">{hint}</span>
      ) : null}
    </label>
  );
}

function Complete({ email }: { email: string }) {
  return (
    <div className="mx-auto w-full max-w-[560px] text-center">
      <div className="bg-brand-gradient mx-auto grid size-14 place-items-center rounded-full text-2xl text-white">
        ✓
      </div>
      <h1 className="font-display mt-6 text-[clamp(26px,3.6vw,38px)] leading-tight font-medium tracking-[-0.024em]">
        You&apos;re set up.
      </h1>
      <p className="text-muted mt-4 text-[16px] font-medium">
        We&apos;ve sent a link to <strong className="text-ink">{email}</strong> to
        choose a password and finish setup. It&apos;s valid for 14 days.
      </p>
      <p className="text-muted mt-6 text-sm">
        Next we&apos;ll provision your number and configure the agent for your
        clinic. If you chose verified reporting, we&apos;ll walk you through
        connecting your booking system — it takes about five minutes.
      </p>
    </div>
  );
}
