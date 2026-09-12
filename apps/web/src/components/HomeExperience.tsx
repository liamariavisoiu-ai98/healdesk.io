"use client";

import { useCallback, useState } from "react";

import { ChatDemo } from "@/components/ChatDemo";
import { NicheCarousel } from "@/components/NicheCarousel";
import { VoiceDemo } from "@/components/VoiceDemo";
import { WhyGoSmart } from "@/components/WhyGoSmart";
import { site } from "@/lib/site";
import { specialties } from "@/lib/specialties";

/**
 * The client half of the homepage: the two demos, the niche reel, and the
 * revenue question.
 *
 * ## The demos are not configured per specialty, and that is the point
 *
 * There used to be a row of specialty pills above the two panels, and picking
 * one reconfigured the chat's system prompt and the scripted call. It has gone.
 *
 * It was demonstrating the wrong product. What ships is ONE agent that starts
 * generalist and goes deeper as the conversation tells it who it is talking to
 * the knowledge tree is built that way on purpose, because a caller who says
 * "actually we mostly do weight loss now" has to be a turn in the conversation
 * rather than a dead end. A picker in front of the chat said the opposite: that
 * healdesk is six configured bots and you were about to meet one.
 *
 * The reel below is unchanged in what it claims. It is the list of phones this
 * one agent already knows, not a menu to choose from.
 *
 * The calculator keeps a specialty selector, and that is not an inconsistency:
 * it needs a ticket size and a booking rate to do arithmetic with. Asking which
 * practice you run in order to price it is a different act from asking which
 * bot you would like to speak to.
 */
export function HomeExperience() {
  // Owned here rather than inside WhyGoSmart so that a click on the reel can
  // set it, and so the visitor's own volume numbers survive a specialty change.
  const [selectedId, setSelectedId] = useState(specialties[0]!.id);
  const selected = specialties.find((s) => s.id === selectedId) ?? specialties[0]!;

  const [callsPerWeek, setCallsPerWeek] = useState(80);
  const [missedPercent, setMissedPercent] = useState(28);

  /** Reel click: go and talk to her. There is nothing to select any more. */
  const goToDemo = useCallback(() => {
    const target = document.getElementById("aya");
    if (!target) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, []);

  return (
    <>
      {/* The navbar's secondary CTA points here. */}
      <section id="aya" className="scroll-mt-24 pt-6">
        <div className="mx-0.5 mb-[18px] flex flex-wrap items-baseline gap-x-3.5 gap-y-2">
          <span className="text-muted text-xs font-bold tracking-[0.14em] uppercase">
            Talk to {site.agent}
          </span>
          <span className="font-display text-[clamp(24px,2.64vw,31.2px)] font-medium tracking-[-0.02em]">
            Designed around your customer&apos;s specialty-related behaviour
          </span>
        </div>

        <div className="grid gap-[18px] lg:grid-cols-2">
          <ChatDemo />
          <VoiceDemo />
        </div>
      </section>

      <NicheCarousel specialties={specialties} onSelect={goToDemo} />

      <WhyGoSmart
        specialty={selected}
        onSelectSpecialty={setSelectedId}
        callsPerWeek={callsPerWeek}
        onCallsPerWeek={setCallsPerWeek}
        missedPercent={missedPercent}
        onMissedPercent={setMissedPercent}
      />
    </>
  );
}
