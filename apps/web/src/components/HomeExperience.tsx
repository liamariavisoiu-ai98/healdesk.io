"use client";

import { useCallback } from "react";

import { AgentPanel } from "@/components/agent-panel/AgentPanel";
import { ChatDemo } from "@/components/ChatDemo";
import { NicheCarousel } from "@/components/NicheCarousel";
import { Outcomes } from "@/components/Outcomes";
import { OwnBranding } from "@/components/OwnBranding";
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
 * Until 9 October 2026 each panel sat in a field of soft colour, after the
 * product cards on reception.ai. The owner then asked for the cards to look
 * exactly like the personalised demo's ("Peachy"), so they are that page's
 * cards now, white on the page, in healdesk's red.
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
      <section id="aya" className="page-section scroll-mt-24">
        {/* Centred, and the copy the owner asked for on 9 October 2026: 24/7,
            every channel by name, bookings and payment links. Payment links
            are claimed for chat only, because voice cannot send one in v1;
            on a call she books and flags the deposit (docs/v1-product-spec.md). */}
        <div data-reveal="stagger" className="mx-auto mb-8 text-center sm:mb-10">
          <p className="eyebrow-tag">
            Meet your AI receptionist, {site.agent} 3.0
          </p>
          <h2 className="heading-section text-ink mx-auto mt-5">
            One assistant, every channel, 24/7
          </h2>
          <p className="text-muted mx-auto mt-4 max-w-[60ch] text-[clamp(var(--text-base),1.25vw,var(--text-lg))] leading-[1.55] font-medium">
            {site.agent} 3.0 answers your phone, website chat, Instagram, Facebook Messenger and
            WhatsApp, 24/7. She books into your calendar during the conversation, and in chat
            sends a deposit link through your own checkout. Try her below.
          </p>
        </div>

        {/* The two cards are the personalised demo's own (components/agent-panel),
            in healdesk's red, voice first as there (owner, 9 October 2026).
            One column below lg has to be declared: an undeclared one is sized
            to the cards' widest content, which ran the chat card past a 320px
            screen in Firefox and into the page's margin in Chrome. */}
        <div
          data-reveal="stagger"
          className="grid grid-cols-1 gap-5 lg:grid-cols-2"
          style={{ ["--clinic" as string]: "var(--color-red)", ["--clinic-ink" as string]: "#ffffff" }}
        >
          {/* No mark in the cards' top rows (owner, 12 October 2026): the
              soul sat there as a blurred orange orb, which at 36px read as a
              rendering fault. The label stands alone; AYA is in the cards. */}
          <AgentPanel label="Voice agent" name={site.agent} logoUrl={null} mark={false}>
            <VoiceDemo />
          </AgentPanel>
          <AgentPanel label="Website chat & Meta DMs" name={site.agent} logoUrl={null} mark={false}>
            <ChatDemo />
          </AgentPanel>
        </div>

        {/* Under the cards, her in theirs: their own demo, built from their
            site and emailed to them (owner, 9 October 2026). */}
        <OwnBranding />
      </section>

      {/* The eight outcomes, straight after the demos: meet her first, then
          see what a month of her changes, as the notifications it brings. */}
      <Outcomes />

      <NicheCarousel specialties={specialties} onSelect={goToDemo} />
    </>
  );
}
