"use client";

import {
  type BillingInterval,
  BOOKING_SYSTEMS,
  type BookingSystemId,
  bookingSyncFor,
  CALENDAR_ACCOUNT_OPTIONS,
  type CalendarAccount,
  type Plan,
  type SpecialtyId,
  specialties,
  specialtyOffered,
} from "@healdesk/catalog";
import { type Ref, useState } from "react";

import {
  bookingConsequence,
  CLINIC_NAME_MAX,
  chosenPlan,
  clinicIssues,
  type FunnelState,
  noWebsiteOptions,
  websiteConflict,
} from "@/lib/checkout/funnel";
import { monthlyFigureUsd, usd } from "@/lib/pricing";
import { site } from "@/lib/site";

import { PrimaryButton, RadioGroup, Reassurance, StepShell, TextField } from "./StepShell";

/**
 * Step 2, the clinic: the practice's legal name, its website or none, its
 * specialty, where its bookings live and which Google account they would go
 * into. The website is read in the background once the buyer moves on, so
 * setup starts with the clinic's own services, hours and providers.
 *
 * Two answers change what can be sold or promised, and both say so at once:
 * no website means no website chat, so the phone and the Meta bot are
 * offered instead; and the booking system decides whether AYA can ever book
 * live, said in one sentence the moment it is chosen.
 */

/** Said under the Meta bot when it is offered to a practice with no website: it needs somewhere to answer. */
const META_CONDITION =
  "For a practice whose patients already message it on Instagram, Facebook or WhatsApp: AYA answers them there. You connect your Facebook Page and Instagram account in setup.";

const NO_WEBSITE_DESCRIPTIONS: Record<string, string> = {
  voice:
    "AYA answers your phone. A practice without a website takes most of its bookings by phone.",
  // Carries the Meta bot's condition too: while Meta is not sold on its own,
  // this is the only way the Meta bot is offered to a practice with no website.
  "meta-voice":
    "AYA answers your phone, and, if your patients already message you on Instagram, Facebook or WhatsApp, answers them there too.",
  "chat-meta": META_CONDITION,
};

/**
 * A replacement package, priced for the billing period already chosen on
 * step 1, which choosing it keeps: the figure the package card and Review and
 * pay show, per month, and "billed annually" on the annual terms.
 */
function noWebsiteOptionLabel(plan: Plan, interval: BillingInterval): string {
  const billed = interval === "year" ? " billed annually" : "";
  return `${plan.name}: ${usd.format(monthlyFigureUsd(plan, interval))}/mo${billed} + ${usd.format(plan.setupFeeUsd)} setup fee`;
}

export function ClinicStep({
  state,
  update,
  onPlan,
  onBack,
  onContinue,
  onClose,
  headingRef,
  error,
  fromDemo = false,
}: {
  /**
   * The buyer came from their personalised demo, which already has the
   * clinic's name and website: they are shown as one confirmed line, not
   * asked again. "Edit" opens the fields, because the agreement names the
   * practice's legal name, which may not be the name on its door.
   */
  fromDemo?: boolean;
  state: FunnelState;
  update: (patch: Partial<FunnelState>) => void;
  onPlan: (planId: string) => void;
  onBack: () => void;
  onContinue: () => void;
  onClose?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
  /** A refusal from a later step that belongs to one of these answers. */
  error?: { field: string; message: string } | null;
}) {
  const plan = chosenPlan(state);
  const issues = clinicIssues(state);
  const conflict = websiteConflict(state);
  const consequence = state.bookingSystem ? bookingConsequence(state.bookingSystem) : null;
  const invalid = (field: string) => error?.field === field;
  const [editing, setEditing] = useState(false);
  const confirmed =
    fromDemo && !editing && state.clinicName.trim().length > 0 && state.website.trim().length > 0 && !error?.field?.match(/^(clinicName|website)$/);

  return (
    <StepShell
      step={2}
      totalSteps={4}
      onBack={onBack}
      onClose={onClose}
      headingRef={headingRef}
      eyebrow={site.cta.primary.label}
      title="Your clinic"
      subtitle="Five quick answers. They set up AYA and name your practice in its agreement."
    >
      {error ? (
        <p
          className="border-red/30 bg-red/[0.06] mb-6 rounded-xl border px-4 py-3 text-[15.6px] font-semibold"
          role="alert"
        >
          {error.message}
        </p>
      ) : null}

      <div className="grid gap-8">
        {confirmed ? (
          <div className="border-line flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-white px-5 py-4">
            <span>
              <span className="block text-[15.6px] font-bold">{state.clinicName}</span>
              <span className="text-muted block text-sm">{state.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
              <span className="text-muted block text-xs">From your demo. This is the name on your agreement.</span>
            </span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="border-line hover:border-line-strong rounded-full border px-4 py-2 text-sm font-bold transition-colors"
            >
              Edit
            </button>
          </div>
        ) : (
        <>
        <TextField
          label="Practice legal name"
          value={state.clinicName}
          onChange={(clinicName) => update({ clinicName })}
          placeholder="Glow Med Spa LLC"
          autoComplete="organization"
          maxLength={CLINIC_NAME_MAX}
          invalid={invalid("clinicName")}
          hint="As it should appear on your agreement."
        />

        <div>
          <TextField
            label="Website"
            value={state.noWebsite ? "" : state.website}
            onChange={(website) => update({ website })}
            placeholder="glowmedspa.com"
            inputMode="url"
            autoComplete="url"
            disabled={state.noWebsite}
            invalid={invalid("website")}
            hint={
              state.noWebsite
                ? undefined
                : "We read it so that setup starts with your services, hours and providers."
            }
          />
          <label className="mt-2 flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold">
            <input
              type="checkbox"
              checked={state.noWebsite}
              onChange={(e) => update({ noWebsite: e.target.checked })}
              className="accent-red size-5"
            />
            We don&apos;t have a website
          </label>

          {/* No website, no website chat (v1 spec, "Stage 0"). The phone
              first: a practice without a website takes its bookings by
              phone. Then the Meta bot, for one whose patients message it. */}
          {conflict && plan ? (
            <div className="border-red/30 bg-red/[0.04] mt-4 rounded-2xl border p-5">
              <RadioGroup<string>
                name="no-website-package"
                layout="cards"
                label="Website chat needs a website"
                hint={`${plan.name} includes website chat, which answers on your site. Choose a package without it:`}
                options={noWebsiteOptions().map((option) => ({
                  id: option.id,
                  label: noWebsiteOptionLabel(option, state.interval),
                  description: NO_WEBSITE_DESCRIPTIONS[option.id],
                }))}
                value={null}
                onChange={onPlan}
                invalid={invalid("plan")}
              />
            </div>
          ) : null}
        </div>
        </>
        )}

        <RadioGroup<SpecialtyId>
          name="specialty"
          label="Specialty"
          options={specialties
            .filter((specialty) => specialtyOffered(specialty.id))
            .map((specialty) => ({ id: specialty.id, label: specialty.name }))}
          value={state.specialty}
          onChange={(specialty) => update({ specialty })}
          invalid={invalid("specialty")}
        />

        <div>
          <RadioGroup<BookingSystemId>
            name="booking-system"
            label="Where do bookings live today?"
            options={BOOKING_SYSTEMS.map((system) => ({ id: system.id, label: system.label }))}
            value={state.bookingSystem}
            onChange={(bookingSystem) => update({ bookingSystem })}
            invalid={invalid("bookingSystem")}
          />
          {/* Said the moment the answer is given, and to a screen reader as
              well: the region is in the page before it has anything to say. */}
          <div role="status" aria-live="polite" className="mt-3">
            {consequence ? (
              <div className="border-line rounded-xl border bg-white px-4 py-3 text-sm">
                <p className="font-medium">{consequence.text}</p>
                {consequence.setup ? (
                  <p className="text-muted mt-2">
                    {consequence.setup.note}
                    {consequence.setup.helpUrl ? (
                      <>
                        {" "}
                        <a
                          href={consequence.setup.helpUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-ink font-semibold underline underline-offset-4"
                        >
                          How to do it
                        </a>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <RadioGroup<CalendarAccount>
          name="calendar-account"
          layout="cards"
          label="Which Google account will bookings go into?"
          hint={
            state.bookingSystem && bookingSyncFor(state.bookingSystem) === "manual"
              ? "Your booking system doesn't read Google Calendar, so AYA books nothing into one; we keep your answer in case that changes."
              : "The Google Calendar you connect in setup. Not sure? Ask whoever set up your clinic's email."
          }
          options={CALENDAR_ACCOUNT_OPTIONS.map((option) => ({
            id: option.id,
            label: option.title,
            description: option.description,
          }))}
          value={state.calendarAccount}
          onChange={(calendarAccount) => update({ calendarAccount })}
          invalid={invalid("calendarAccount")}
        />
      </div>

      <div className="mt-10">
        <PrimaryButton onClick={onContinue} disabled={issues.length > 0}>
          Continue
        </PrimaryButton>
        <p
          className={`text-muted mt-3 text-sm ${issues.length > 0 ? "" : "sr-only"}`}
          role="status"
          aria-live="polite"
        >
          {issues.length > 0
            ? `Still to answer: ${issues.map((issue) => STILL_NEEDED[issue.field] ?? issue.field).join(", ")}.`
            : ""}
        </p>
      </div>
      <Reassurance />
    </StepShell>
  );
}

const STILL_NEEDED: Record<string, string> = {
  clinicName: "your practice's legal name",
  website: "your website",
  plan: "a package without website chat",
  specialty: "your specialty",
  bookingSystem: "where bookings live",
  calendarAccount: "which Google account",
};
