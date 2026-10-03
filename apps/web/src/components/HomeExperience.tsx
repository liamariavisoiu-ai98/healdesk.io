"use client";

import { useCallback } from "react";

import { ChatDemo } from "@/components/ChatDemo";
import { NicheCarousel } from "@/components/NicheCarousel";
import { Outcomes } from "@/components/Outcomes";
import { VoiceDemo } from "@/components/VoiceDemo";
import { site } from "@/lib/site";
import { specialties } from "@/lib/specialties";

/**
 * The client half of the homepage: the two demos, the outcomes deck and the
 * niche deck, in that order. The demos come first, straight under the hero, on
 * the owner's instruction of 3 October 2026.
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
 * ## The calculator is not here any more
 *
 * It moved to /why-wait on 23 September 2026 (see WhyWaitExperience). The
 * homepage is for meeting her; the arithmetic is one click away in the navbar
 * for the visitor who is already convinced.
 *
 * ## The section's dress
 *
 * Each panel sits in a field of soft colour, after the product cards on
 * reception.ai: the white panel reads as a device someone is holding, the
 * field behind it as the room it is in. The fields are plain CSS gradients
 * (`demo-field-*` in globals.css), warm behind the chat and cool behind the
 * call, so the two are told apart before a word is read.
 */
export function HomeExperience() {
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
      <section id="aya" className="scroll-mt-24 pt-16 sm:pt-24">
        <div className="mb-8 max-w-[760px] sm:mb-10">
          <p className="eyebrow-tag">
            {site.agent} 1.0 · Meet your smart assistant
          </p>
          <h2 className="font-display text-ink mt-5 text-[clamp(36px,4.8vw,66px)] leading-[1.02] font-normal tracking-[-0.03em]">
            Website, DMs &amp; Phone
          </h2>
          <p className="text-muted mt-4 max-w-[58ch] text-[clamp(17px,1.25vw,19px)] leading-[1.55] font-medium">
            One agent behind your website chat, your Instagram, Messenger and WhatsApp messages,
            and your phone line. The chat is live; the call is a scripted example, or have her
            place one demo call to you.
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-2 lg:gap-6">
          <div className="demo-field-warm rounded-[28px] p-3 sm:p-5">
            <ChatDemo />
          </div>
          <div className="demo-field-cool rounded-[28px] p-3 sm:p-5">
            <VoiceDemo />
          </div>
        </div>
      </section>

      {/* The eight outcomes, straight after the demos: meet her first, then
          see what a month of her changes. Its cards scroll back up to the
          demo, the same hand-off the niche deck makes below. */}
      <Outcomes onOpen={goToDemo} />

      <NicheCarousel specialties={specialties} onSelect={goToDemo} />
    </>
  );
}
