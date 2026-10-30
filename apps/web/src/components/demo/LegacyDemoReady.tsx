import { agreementClaim } from "@healdesk/catalog";

import { AgentMark, AgentPanel } from "@/components/agent-panel/AgentPanel";
import { VoiceCard } from "@/components/agent-panel/VoiceCard";
import { BuyModalProvider } from "@/components/BuyModal";
import { RefreshingOfferCountdown } from "@/components/checkout/SetupOfferBanner";
import { ClinicChatPanel } from "@/components/demo/ClinicChatPanel";
import { DemoNotFound } from "@/components/demo/DemoNotFound";
import { ClosePage } from "@/components/demo/ClosePage";
import { CoverageOffer } from "@/components/demo/CoverageOffer";
import { DemoBuyButton } from "@/components/demo/DemoBuyButton";
import { Archived, avatarLogo, chipsFor, Shell } from "@/components/demo/DemoShell";
import { CopyDemoLink, DemoCountdown } from "@/components/demo/DemoTimers";
import { DemoViewed } from "@/components/demo/DemoViewed";
import { demoCheckout, demoPrefill } from "@/lib/demo/checkout";
import { chatGreeting, demoModeLine } from "@/lib/demo/clinic-prompts";
import { DEMO_ONBOARD_LABEL } from "@/lib/demo/offer";
import { demoVariant } from "@/lib/demo/close";
import { weekSchedule } from "@/lib/demo/opening-hours";
import type { ClinicProfile } from "@/lib/demo/profile";
import { demoAudience, demoSetupCredit, isSelfServeDemo, type DemoSession } from "@/lib/demo/sessions";
import { site } from "@/lib/site";

/**
 * The demo page as it was before the owner's design of 30 October 2026
 * (lib/demo/v2), kept for veterinary demos only: the new page speaks of
 * patients, HIPAA and a Business Associate Agreement throughout, and a
 * practice whose patients are animals signs a data protection agreement
 * instead (agreementKindFor). The owner decides what a vet's demo shows; until
 * then this one stays true for them. Its two closes are as before.
 */
export function LegacyDemoReady({
  slug,
  session,
  profile,
  name,
  colour,
  expired,
  offerEnds,
  demoLine,
}: {
  slug: string;
  session: DemoSession;
  profile: ClinicProfile;
  name: string;
  colour: string;
  expired: boolean;
  offerEnds: Date | null;
  demoLine: string | null;
}) {
  const schedule = weekSchedule(profile.hours);
  // In the clinic's own word: a vet's callers are its clients (demoAudience).
  const audience = demoAudience(session);
  const one = audience === "clients" ? "client" : "patient";
  // A vet signs the data protection agreement, not a BAA: HIPAA cannot reach
  // a practice whose patients are animals (agreementKindFor).
  const agreementPoint =
    audience === "clients"
      ? agreementClaim("dpa", "clients")
      : "We sign a BAA and handle patient data under it";
  // A homepage demo buys through the homepage's own purchase, opened here
  // and knowing the demo; one an operator built keeps "Book Onboarding".
  const selfServe = isSelfServeDemo(session);
  const ctaStyle = { background: "var(--clinic)", color: "var(--clinic-ink)" };

  const page = (
    <Shell colour={colour}>
      {/* Top banner: the one-week clock, or the archive notice. */}
      {/* Sticky, so the clock, the offer and the link follow the visitor down
          the page. The offer is the setup credit checkout applies to a demo
          bought inside its 48 hours (api/checkout, from the same
          `demoOfferEndsAt`), so it carries its own clock and is never
          promised after that runs out, though the demo itself runs on. */}
      {expired ? (
        <div className="bg-ink sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 px-5 py-3 text-center text-[15px] font-semibold text-white sm:px-8">
          <span>Instance Archived — Server Allocation Window Expired for {name}</span>
          <CopyDemoLink />
        </div>
      ) : (
        <div
          className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 px-5 py-2.5 text-center text-[15px] font-semibold shadow-sm sm:px-8"
          style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
        >
          <span className="flex items-center gap-2">
            Private demo for {name}. Live for <DemoCountdown expiresAt={session.expiresAt.toISOString()} />
          </span>
          {offerEnds ? (
            <span className="inline-flex flex-wrap items-center gap-x-2 rounded-full bg-[#87d68d] px-3 py-1 text-[13.2px] font-bold text-[#172a3a]">
              {demoSetupCredit(session).percentOfSetupFee}% off your setup fee, ends in{" "}
              <RefreshingOfferCountdown endsAt={offerEnds.toISOString()} />
            </span>
          ) : null}
          <CopyDemoLink />
        </div>
      )}

      <header className="border-line/60 border-b">
        <div className="mx-auto flex max-w-[1240px] items-center gap-3 px-5 py-4 sm:px-8 lg:px-14">
          <AgentMark name={name} logoUrl={session.logoUrl} />
          {session.logoUrl ? null : (
            <span className="font-display hidden min-w-0 truncate text-[21px] font-semibold tracking-[-0.01em] sm:inline">{name}</span>
          )}
          {/* Both brands, side by side: the clinic's assistant, built by healdesk. */}
          <span aria-hidden className="text-muted text-[18px] font-light">×</span>
          <a href="/" aria-label="healdesk" className="shrink-0">
            <img src="/brand/healdesk-logo.webp" alt="healdesk" width={2400} height={437} className="h-[22px] w-auto sm:h-[26px]" />
          </a>
          {selfServe ? (
            <DemoBuyButton
              className="ml-auto shrink-0 rounded-full px-4 py-2 text-[15px] font-bold transition-opacity hover:opacity-90 sm:px-5 sm:py-2.5"
              style={ctaStyle}
              pressed={{ slug, placement: "header" }}
            >
              {site.cta.primary.label}
            </DemoBuyButton>
          ) : (
            <a
              href={`/demo/${slug}/onboard?from=header`}
              className="ml-auto shrink-0 rounded-full px-4 py-2 text-[15px] font-bold transition-opacity hover:opacity-90 sm:px-5 sm:py-2.5"
              style={ctaStyle}
            >
              {DEMO_ONBOARD_LABEL}
            </a>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1240px] px-5 pt-10 pb-16 sm:px-8 lg:px-14">
        <div className="max-w-[760px]">
          <h1 className="font-display mt-2 text-[34px] leading-[1.1] font-medium tracking-[-0.02em] sm:text-[44px]">
            {name}, answering every call and chat.
          </h1>
          <p className="text-muted mt-3 max-w-[56ch] text-[18px] leading-[1.5] font-medium">
            {site.agent} has already read {name}&rsquo;s website. Try her the way a {one} would.
          </p>
          {/* The owner asked for "the most human-like agent on the market" and
              "HIPAA compliant". Both are worded to what can be backed: the
              first is the visitor's own experience on this page, and CLAUDE.md
              forbids an unqualified "HIPAA compliant" (no body certifies it,
              and the FTC has charged that claim as deceptive on its own). */}
          <p className="text-ink mt-3 text-[20px] leading-snug font-semibold">
            {site.agent} sounds like a person, not a robot. Talk to her and hear it for yourself.
          </p>
          <ul className="mt-5 flex flex-wrap gap-2">
            {["Answers 24/7", "Phone, website & socials", "Books into your calendar", "Deposit links in chat", agreementPoint].map((point) => (
              <li key={point} className="border-line flex items-center gap-1.5 rounded-full border bg-white px-3.5 py-1.5 text-[14.4px] font-semibold">
                <span aria-hidden className="size-1.5 rounded-full bg-[#87d68d]" />
                {point}
              </li>
            ))}
          </ul>
        </div>

        {/* The two cards, drawn by the same parts as the homepage's
            (components/agent-panel), in the clinic's colour and logo. */}
        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          <AgentPanel label={`${site.agent} voice agent`} title="Your phone line" name={name} logoUrl={session.logoUrl} overlay={expired ? <Archived /> : null}>
            <VoiceCard
              name={name}
              portraitLabel={`${site.agent} \u00b7 ${name}\u2019s AI assistant`}
              callRoute={`/api/demo/${slug}/retell`}
              callerRoute={`/api/demo/${slug}/caller`}
              demoLine={demoLine}
              ringNote={`One demo call, because you asked. Live, it only answers: it never dials a ${one}.`}
              callbackExtra={{ demoSlug: slug }}
              prefillPhone={session.phoneE164}
              locked={expired}
              // A call here starts with "What's your name?" so AYA can greet the owner by it.
              askName
            />
          </AgentPanel>
          <AgentPanel
            label={`${site.agent} chat`}
            title="Your website, WhatsApp, Instagram and Messenger"
            name={name}
            logoUrl={session.logoUrl}
            overlay={expired ? <Archived /> : null}
          >
            <ClinicChatPanel
              slug={slug}
              clinicName={name}
              logoUrl={avatarLogo(session.logoUrl)}
              greeting={chatGreeting(name, audience)}
              chips={chipsFor(profile)}
              locked={expired}
            />
          </AgentPanel>
        </div>

        {/* What the demo could not find on the website or Google listing (owner, 29 October 2026). */}
        <DemoNotFound profile={profile} audience={audience} />

        {/* Under both panels: what the assistant does beyond answering (owner, 7 October 2026). */}
        <div className="mt-6 flex flex-col items-center gap-1 text-center">
          <p className="font-display text-[22px] leading-tight font-medium tracking-[-0.01em] sm:text-[26px]">
            {site.agent} can manage bookings, send payment links and look after people the way you would.
          </p>
        </div>

        {/* The training disclaimer, in the brief's words: what demo mode cannot do yet. */}
        <aside className="border-line mt-6 rounded-md border bg-white px-5 py-4 text-center">
          <p className="text-[15.6px] leading-[1.5] font-medium">&ldquo;{demoModeLine(name)}&rdquo;</p>
        </aside>

        <CoverageOffer
          slug={slug}
          clinicName={name}
          agent={site.agent}
          schedule={schedule}
          source={
            !schedule.listed
              ? null
              : profile.hoursSource === "google"
                ? { kind: "google", place: profile.hoursPlace }
                : { kind: "website" }
          }
          buy={selfServe}
          audience={audience}
        />
      </main>
    </Shell>
  );

  const variant = demoVariant(slug);
  const body =
    variant === "close" ? (
      <ClosePage
        slug={slug}
        session={session}
        name={name}
        colour={colour}
        profile={profile}
        expired={expired}
        offerEnds={offerEnds}
        demoLine={demoLine}
        schedule={schedule}
        ringNote={`One demo call, because you asked. Live, it only answers: it never dials a ${one}.`}
      />
    ) : (
      <>
        <DemoViewed slug={slug} />
        {page}
      </>
    );

  // A homepage demo buys through the purchase opened over the page, in both closes.
  if (!selfServe) return body;
  return (
    <BuyModalProvider
      // A demo already bought opens the plain purchase: its offer and its claim are spent.
      demo={session.claimed ? undefined : { slug, checkout: demoCheckout(session), prefill: demoPrefill(session) }}
    >
      {body}
    </BuyModalProvider>
  );
}
