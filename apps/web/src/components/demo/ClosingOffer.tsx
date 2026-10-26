"use client";

import { agreementClaim, type Audience } from "@healdesk/catalog";

import { ActivateButton, ClinicMark, OfferPrice, useDemoClose } from "@/components/demo/DemoClose";
import { site } from "@/lib/site";

/**
 * The end of the demo page: one headline, the offer, the questions an owner
 * asks before buying, the one button, what happens after paying, and the
 * three facts that make it safe to try.
 *
 * Every answer is something the product does in v1 (docs/v1-product-spec.md):
 * the opening line says it is an AI assistant, on every channel; Google
 * Calendar is the only booking target, a slot is held before anything
 * confirming is said, and "Auto-confirm bookings" can be switched off;
 * coverage is conditional call forwarding on the clinic's own number; every
 * failure ends with calls forwarding to the clinic's direct line. The data
 * line is the spec's own sentence, never "HIPAA compliant". "About 15
 * minutes of your time" is the set-up promise, word for word, and no step
 * says when a channel goes live.
 */

/** The data line in the practice's own terms: the BAA's, or a vet's data protection agreement. */
export function agreementPoint(audience: Audience): string {
  return audience === "clients" ? agreementClaim("dpa", "clients") : agreementClaim("baa", "patients");
}

export function objections(clinicName: string, agent: string, audience: Audience = "patients"): { q: string; a: string }[] {
  const many = audience;
  const one = audience === "clients" ? "client" : "patient";
  return [
    {
      q: `Will ${many} mind it's AI?`,
      a: `You just heard her. ${agent} says she's an AI assistant in her first line, on every channel, and then she sounds like ${clinicName}.`,
    },
    {
      q: "Will it mess up my calendar?",
      a: `She books only into your Google Calendar, and holds the slot before she confirms it. Switch off auto-confirm and every booking waits for your team to approve.`,
    },
    {
      q: "Do I lose my number?",
      a: `No. You keep your number and forward calls to ${agent} from it: after hours only, overflow and after hours, or all calls.`,
    },
    {
      q: audience === "clients" ? "Is my clients' information safe?" : "Is patient data safe?",
      a: `${agreementPoint(audience)}.`,
    },
    {
      q: "What if it breaks?",
      a: `Calls fall back to your own direct line. A ${one} calling ${clinicName} always reaches someone.`,
    },
  ];
}

const NEXT_STEPS = [
  { title: "About 15 minutes of your time", body: "Confirm the services, prices and hours she already knows, and how she should sound." },
  { title: "Connect your Google Calendar", body: "A sign-in, not a password. She books only into open slots." },
  { title: "Turn on call forwarding", body: "On your own line, so you keep your number. Each chat channel connects with a sign-in." },
] as const;

export function ClosingOffer() {
  const { clinicName, audience } = useDemoClose();
  return (
    <section aria-labelledby="closing-heading" className="mt-16">
      <div className="flex flex-col items-center text-center">
        <ClinicMark size={48} />
        <h2 id="closing-heading" className="heading-section mt-5 max-w-[26ch]">
          Every call to {clinicName} answered: evenings, weekends, and when the front desk is busy.
        </h2>
      </div>

      {/* The offer: the one loud thing on the page. */}
      <div className="mx-auto mt-8 max-w-[640px] rounded-lg border border-white/[0.08] bg-[#0B1520] p-6 text-white shadow-lg sm:p-8">
        <OfferPrice placement="closing" />
      </div>

      {/* The questions, answered where they come up: open on a wide screen,
          one tap each on a phone. */}
      <ul className="mx-auto mt-8 hidden max-w-[980px] gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-3">
        {objections(clinicName, site.agent, audience).map((o) => (
          <li key={o.q} className="border-line rounded-md border bg-white px-5 py-5">
            <p className="text-[15.6px] font-bold">{o.q}</p>
            <p className="text-muted mt-1.5 text-[14.4px] leading-[1.5]">{o.a}</p>
          </li>
        ))}
      </ul>
      <ul className="divide-line border-line mt-8 divide-y rounded-md border bg-white sm:hidden">
        {objections(clinicName, site.agent, audience).map((o) => (
          <li key={o.q}>
            <details className="group">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-[15.6px] font-bold">
                {o.q}
                <span aria-hidden className="text-muted text-[20px] transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="text-muted px-4 pb-4 text-[14.4px] leading-[1.5]">{o.a}</p>
            </details>
          </li>
        ))}
      </ul>

      <div className="mt-8 flex justify-center">
        <ActivateButton placement="closing" />
      </div>

      {/* What happens after paying. */}
      <ol className="mx-auto mt-12 grid max-w-[980px] gap-3 sm:grid-cols-3">
        {NEXT_STEPS.map((step, i) => (
          <li key={step.title} className="border-line flex gap-4 rounded-md border bg-white px-5 py-5">
            <span
              aria-hidden
              className="grid size-8 shrink-0 place-items-center rounded-full text-[14px] font-bold tabular-nums"
              style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
            >
              {i + 1}
            </span>
            <span>
              <span className="block text-[16px] leading-snug font-bold">{step.title}</span>
              <span className="text-muted mt-1 block text-[14.4px] leading-[1.45]">{step.body}</span>
            </span>
          </li>
        ))}
      </ol>

      <p className="text-muted mx-auto mt-8 max-w-[64ch] text-center text-[14.4px] font-semibold">
        Books into your Google Calendar · You keep your number ·{" "}
        {audience === "clients" ? agreementPoint(audience) : "We sign a BAA and handle patient data under it"}
      </p>
    </section>
  );
}
