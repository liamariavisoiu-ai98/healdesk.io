"use client";

import {
  CURRENT_BAA_VERSION,
  currentBaaDocument,
  getPlan,
  NO_PLATFORM_ID,
  plans,
  platforms,
  specialties,
  supportsVerifiedAttribution,
  TRIAL_DAYS,
} from "@healdesk/catalog";
import { useMemo, useState } from "react";

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
 */

const TOTAL_STEPS = 5;

type State = {
  specialty: string;
  platform: string;
  attributionMode: "estimated" | "verified";
  averageTreatmentValueUsd: string;
  clinicName: string;
  contactName: string;
  contactEmail: string;
  contactTitle: string;
  baaAccepted: boolean;
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
  baaAccepted: false,
};

export function CheckoutFlow({ initialPlan }: { initialPlan: string }) {
  const [step, setStep] = useState(1);
  const [state, setState] = useState<State>(INITIAL);
  const [planId, setPlanId] = useState(initialPlan);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [done, setDone] = useState<{ clinicSlug: string } | null>(null);

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
          baaVersion: CURRENT_BAA_VERSION,
          baaAccepted: state.baaAccepted,
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

        <div className="mt-8">
          <PrimaryButton onClick={next} disabled={!ready}>
            Continue
          </PrimaryButton>
        </div>
        <Reassurance />
      </StepShell>
    );
  }

  // --- Step 5: agreement + confirm ------------------------------------------
  const document = currentBaaDocument();

  return (
    <StepShell
      step={5}
      totalSteps={TOTAL_STEPS}
      eyebrow="Get started"
      title="One agreement, then you're set."
      subtitle="Because we handle patient information on your behalf, we need a business associate agreement in place."
      onBack={back}
    >
      <div className="border-line rounded-2xl border bg-white">
        <div className="border-line flex items-center justify-between border-b px-5 py-3">
          <span className="text-sm font-bold">Business Associate Agreement</span>
          <span className="text-muted text-xs font-semibold">
            Version {document.version}
          </span>
        </div>
        <div className="scroll-subtle max-h-64 overflow-y-auto px-5 py-4">
          <pre className="text-muted font-sans text-[13px] leading-relaxed whitespace-pre-wrap">
            {document.text}
          </pre>
        </div>
      </div>

      {!document.approvedByCounsel ? (
        <p className="border-red/30 bg-red/[0.06] mt-4 rounded-xl border px-4 py-3 text-[13px] font-semibold">
          This agreement is a draft pending legal review. Until it is finalised,
          accounts are created for synthetic data only and cannot receive real
          patient information.
        </p>
      ) : null}

      <label className="mt-6 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={state.baaAccepted}
          onChange={(e) => set("baaAccepted", e.target.checked)}
          className="accent-red mt-1 size-4 shrink-0"
        />
        <span className="text-sm font-medium">
          I have authority to enter into this agreement for{" "}
          <strong>{state.clinicName || "my clinic"}</strong>, and I accept it.
        </span>
      </label>

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
          disabled={!state.baaAccepted || submitting}
        >
          {submitting ? "Setting up…" : `Start ${TRIAL_DAYS}-day trial`}
        </PrimaryButton>
      </div>
      <Reassurance />
    </StepShell>
  );
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
