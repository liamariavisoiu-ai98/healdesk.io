"use client";

import { useState } from "react";

import { BuyButton } from "@/components/BuyModal";
import { HealdeskSoul } from "@/components/HealdeskSoul";
import { WhyGoSmart } from "@/components/WhyGoSmart";
import { site } from "@/lib/site";
import { specialties } from "@/lib/specialties";

/**
 * The client half of /why-wait: the revenue calculator and the way in.
 *
 * The calculator lived on the homepage between the specialties and the
 * reviews until 23 September 2026. It moved here on the owner's call: the
 * homepage is for meeting AYA, and a page of sliders in the middle of it was
 * a second argument interrupting the first. "Why wait?" in the navbar is the
 * visitor who is already persuaded and wants to know what waiting costs.
 *
 * State is owned here, not in WhyGoSmart, for the same reason it was owned
 * by HomeExperience before: the visitor's own volume numbers must survive a
 * change of specialty.
 *
 * ## The section under it says "free", and here is exactly what is free
 *
 * There is no product trial. The catalog header explains why: a person builds
 * and QA-tests each agent before it takes a call, the setup fee pays for that
 * work, and a trial and a setup fee do not compose. What IS free is AYA
 * herself, on this site, for thirty days from the moment a visitor unlocks
 * the demo: that is the gate cookie's lifetime (lib/gate.ts) and what the
 * privacy policy states, so the copy says thirty and not the "7 days" the
 * section was first briefed with. A number on this page has to match the
 * cookie and the policy, or all three have to change together.
 *
 * So the section sells the demo AND says plainly what the demo is not. The
 * two lists are the whole device: the left one is what a visitor gets today,
 * the right one is what she does once she is theirs, and the gap between
 * them is the sale. Every line on the right is a thing the catalog and the
 * terms already promise; nothing here is written for effect.
 */

/** What the visitor gets today, for nothing. Short, and honest about its limits. */
const IN_THE_DEMO = [
  `${site.agent} on a generic knowledge tree covering all eight specialties`,
  "Live web chat, a scripted example call, or a real demo call to your phone",
  "Open to you for thirty days from the moment you unlock it with your work email",
] as const;

/** What she does once she is yours. Each line is a promise the terms already make. */
const WHEN_SHE_IS_YOURS = [
  {
    title: "Your real phone line",
    body: "Forwarded to her the moment your desk is busy, closed, or lets a call ring out. Your published number never changes.",
  },
  {
    title: "Your services, prices and rules",
    body: "Not a script. She is built and QA-tested on your practice before she takes a single call.",
  },
  {
    title: "Instagram, WhatsApp and your website, one voice",
    body: "The same agent behind every channel, so a DM at midnight gets an answer in the same voice, and is moved to the phone or the web when it is time to book.",
  },
  {
    title: "Consults pencilled into your real availability",
    body: "Your desk confirms, calls back or declines in one click. She never writes to your calendar herself.",
  },
  {
    title: "Your deposit rule, stated on the call",
    body: "Collected by your desk on confirmation, so a no-show is no longer free.",
  },
  {
    title: "A report that names what collected",
    body: "Every month: which recovered calls became consults, and which consults became revenue.",
  },
  {
    title: "A signed BAA and read-only access",
    body: "Patient information on US-only infrastructure, and nothing in your systems she can change or delete.",
  },
] as const;

export function WhyWaitExperience() {
  const [selectedId, setSelectedId] = useState(specialties[0]!.id);
  const selected = specialties.find((s) => s.id === selectedId) ?? specialties[0]!;
  const [callsPerWeek, setCallsPerWeek] = useState(80);
  const [missedPercent, setMissedPercent] = useState(28);

  return (
    <>
      <WhyGoSmart
        specialty={selected}
        onSelectSpecialty={setSelectedId}
        callsPerWeek={callsPerWeek}
        onCallsPerWeek={setCallsPerWeek}
        missedPercent={missedPercent}
        onMissedPercent={setMissedPercent}
      />

      <section aria-labelledby="try-heading" className="mt-10 mb-24 sm:mt-14">
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-14">
          {/* The ask. */}
          <div className="lg:sticky lg:top-28">
            {/* Block, not inline: the orb is an inline-grid and the eyebrow an
                inline-block, and side by side they shared a line. */}
            <div className="mb-7">
              <HealdeskSoul size={64} />
            </div>
            <p className="eyebrow-tag">No card, no setup, no call from sales</p>
            <h2
              id="try-heading"
              className="font-display text-ink mt-5 max-w-[16ch] text-[clamp(38px,4.8vw,64px)] leading-[1.02] font-normal tracking-[-0.03em] text-balance"
            >
              Try {site.agent} for free.
            </h2>
            <p className="text-muted mt-5 max-w-[46ch] text-[clamp(17px,1.25vw,19px)] leading-[1.55] font-medium">
              Ask her what a patient would ask, or what you would ask a supplier. Unlock the demo
              with your work email and it stays open to you for thirty days. Then decide.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href={`/${site.cta.secondary.href}`}
                className="bg-red hover:bg-red-deep inline-flex items-center justify-center gap-2 rounded-[6px] px-6 py-3.5 text-base font-semibold text-white transition-colors"
              >
                {site.cta.secondary.label}
              </a>
              <a href="/pricing" className="btn-outline px-6 py-3.5 text-base">
                See pricing
              </a>
            </div>

            <div className="border-line mt-10 border-t pt-6">
              <p className="text-muted text-[12.5px] font-bold tracking-[0.12em] uppercase">
                In the demo, today
              </p>
              <ul className="mt-3 space-y-2.5">
                {IN_THE_DEMO.map((line) => (
                  <li key={line} className="text-muted flex gap-2.5 text-[16px] leading-snug font-medium">
                    <span aria-hidden className="bg-line-strong mt-[9px] inline-block h-1.5 w-1.5 shrink-0 rounded-full" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* The sale: what the demo is standing in for. */}
          <div className="demo-field-warm rounded-[28px] p-3 sm:p-5">
            <div className="rounded-[20px] bg-white p-6 shadow-[0_32px_64px_-36px_rgb(23_42_58/0.45)] sm:p-8">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="font-display text-ink text-[clamp(26px,2.6vw,34px)] leading-tight font-normal tracking-[-0.025em]">
                  When she&apos;s yours
                </h3>
                <span className="text-muted text-[14px] font-semibold">
                  Every line is in the agreement
                </span>
              </div>

              <ol className="divide-line mt-6 divide-y">
                {WHEN_SHE_IS_YOURS.map((item) => (
                  <li key={item.title} className="flex gap-4 py-4 first:pt-0 last:pb-0">
                    <span
                      aria-hidden
                      className="bg-tint-peach text-red-deep mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-[13px] font-bold"
                    >
                      ✓
                    </span>
                    <div>
                      <p className="text-ink text-[17.5px] leading-snug font-semibold">{item.title}</p>
                      <p className="text-muted mt-1 text-[15.5px] leading-[1.5] font-medium">{item.body}</p>
                    </div>
                  </li>
                ))}
              </ol>

              <div className="border-line mt-7 flex flex-wrap items-center justify-between gap-4 border-t pt-6">
                <p className="text-muted max-w-[34ch] text-[14.5px] leading-snug font-medium">
                  Packages from {site.name}&apos;s pricing page, monthly or annual, cancel at the
                  end of any period.
                </p>
                <BuyButton className="px-6 py-3.5 text-base" />
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
