import { agreementClaim } from "@healdesk/catalog";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AgentMark, AgentPanel } from "@/components/agent-panel/AgentPanel";
import { VoiceCard } from "@/components/agent-panel/VoiceCard";
import { BuyModalProvider } from "@/components/BuyModal";
import { RefreshingOfferCountdown } from "@/components/checkout/SetupOfferBanner";
import { ClinicChatPanel } from "@/components/demo/ClinicChatPanel";
import { BuildProgress } from "@/components/demo/BuildProgress";
import { DemoBuyButton } from "@/components/demo/DemoBuyButton";
import { CopyDemoLink, DemoCountdown, RefreshWhileBuilding } from "@/components/demo/DemoTimers";
import { CoverageOffer } from "@/components/demo/CoverageOffer";
import { demoCheckout, demoPrefill } from "@/lib/demo/checkout";
import { chatGreeting, demoModeLine } from "@/lib/demo/clinic-prompts";
import { readableOn } from "@/lib/demo/colour";
import { weekSchedule } from "@/lib/demo/opening-hours";
import type { ClinicProfile } from "@/lib/demo/profile";
import {
  demoAudience,
  demoBuildElapsedMs,
  demoBuildState,
  demoOfferEndsAt,
  demoSetupCredit,
  displayName,
  getDemoSession,
  isDemoExpired,
  isDemoSlug,
  isSelfServeDemo,
  profileOf,
} from "@/lib/demo/sessions";
import { site } from "@/lib/site";

/**
 * /demo/[slug], one prospect's private, branded demo.
 *
 * Three states, decided on the server from the `demo_sessions` row:
 *
 *   - building (or failed): a holding screen that re-renders itself until
 *     the build lands. A failed build looks the same to the prospect; the
 *     reason is in the operator's console, not on their screen.
 *   - active: the countdown banner, the voice agent and the website chat side
 *     by side under the clinic's own name, logo and colour, the demo-mode
 *     disclaimer, and the way to buy.
 *   - expired: the archived banner, both panels locked, the way to buy
 *     still there. The API routes refuse an expired demo on their own, so
 *     the lock is not just a coat of paint.
 *
 * The way to buy depends on who asked for the demo. One an operator built
 * for a prospect has "Book Onboarding", which goes to /get-started. One the
 * visitor asked for on the homepage has "Get AYA", the homepage's own
 * purchase, opened over the demo and knowing it (components/BuyModal.tsx),
 * so closing it leaves them on their demo (owner, 13 October 2026).
 *
 * Private by construction: noindex here, `/demo` disallowed in robots.ts,
 * no analytics on the path (lib/analytics.ts), and the slug is unguessable.
 * Built from the clinic's public website, so nothing on it is patient data.
 */

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const session = isDemoSlug(slug) ? await getDemoSession(slug) : null;
  return {
    title: session ? `${displayName(session)} · AI front desk demo` : "Demo",
    robots: { index: false, follow: false },
  };
}

const FALLBACK_COLOUR = "#172a3a";

/** "peachystudio.com", as the visitor typed it, for the holding screen. */
function hostOf(websiteUrl: string): string {
  try {
    return new URL(websiteUrl).hostname.replace(/^www\./, "");
  } catch {
    return websiteUrl;
  }
}

function chipsFor(profile: ClinicProfile): string[] {
  // A treatment with a real figure, not the free consultation: "How much is
  // Complimentary Consultation?" asks a question the name already answers.
  const priced = profile.services.find((s) => s.price && /\d/.test(s.price) && !/complimentary|free/i.test(`${s.name} ${s.price}`));
  const first = priced ?? profile.services[0];
  return [
    first ? `How much is ${first.name}?` : "What treatments do you offer?",
    profile.hours.length > 0 ? "Are you open on Saturdays?" : "What are your opening hours?",
    "Can I book a consultation for next week?",
  ];
}

/**
 * The logo, if it fits in a circle. A wide wordmark (Peachy's is six times
 * wider than tall) shrinks to an unreadable line in a 28-pixel chat avatar,
 * so the avatars show the clinic's initial instead and the wordmark stays in
 * the headers. Only an inline SVG says its shape; a linked image is assumed
 * to be an icon-shaped logo, which is what sites usually link.
 */
function avatarLogo(logoUrl: string | null): string | null {
  if (!logoUrl?.startsWith("data:image/svg+xml;base64,")) return logoUrl;
  const svg = Buffer.from(logoUrl.slice("data:image/svg+xml;base64,".length), "base64").toString();
  const box = /viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg);
  if (!box) return null;
  const ratio = Number(box[1]) / Number(box[2]);
  return ratio > 0 && ratio <= 1.6 ? logoUrl : null;
}

function Shell({
  colour,
  children,
}: {
  colour: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="bg-paper text-ink flex min-h-dvh flex-col"
      style={{ ["--clinic" as string]: colour, ["--clinic-ink" as string]: readableOn(colour) }}
    >
      {children}
    </div>
  );
}

/** Laid over each card once the demo's week is over. */
function Archived() {
  return (
    <div className="bg-paper/80 absolute inset-0 grid place-items-center backdrop-blur-[2px]">
      <p className="bg-ink rounded-full px-4 py-2 text-[14.4px] font-semibold text-white">Archived</p>
    </div>
  );
}

export default async function DemoPage({ params }: Props) {
  const { slug } = await params;
  if (!isDemoSlug(slug)) notFound();
  const session = await getDemoSession(slug);
  if (!session) notFound();

  const name = displayName(session);
  const colour = session.brandColor ?? FALLBACK_COLOUR;
  const profile = profileOf(session);
  const expired = isDemoExpired(session);
  // The demo's setup offer: 50% off for 48 hours from the demo being ready
  // (owner, 13 October 2026; a week until then), never past the demo itself.
  const offerEnds = demoOfferEndsAt(session);
  // "Call us" needs the demo line and the clinic agent its webhook hands calls to.
  const demoLine =
    process.env.RETELL_CLINIC_DEMO_AGENT_ID && /^\+1\d{10}$/.test(process.env.RETELL_DEMO_FROM_NUMBER ?? "")
      ? process.env.RETELL_DEMO_FROM_NUMBER!
      : null;

  // Building, being audited (lib/demo/audit.ts), or held or failed and the
  // team is finishing it by hand. Only an audited demo is ever shown. While it
  // builds, the page shows how far it has got and the time left (owner,
  // 13 October 2026; lib/demo/build-progress.ts). A build past its route's
  // 300 s will never land, and its row says "building" for good, so it is the
  // team's to finish too (`demoBuildState`), and the bar comes down: the
  // homepage opens this page the moment a demo is asked for, so its visitor
  // would otherwise watch it creep on indefinitely.
  const state = demoBuildState(session);
  if (!profile || state !== "ready") {
    const host = hostOf(session.websiteUrl);
    return (
      <Shell colour={colour}>
        {state === "building" || state === "auditing" ? (
          <>
            {expired ? null : <RefreshWhileBuilding />}
            <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center justify-center px-5 py-24 text-center">
              <h1 className="font-display text-[34px] leading-tight font-medium tracking-[-0.02em]">
                We&rsquo;re building {name}&rsquo;s demo
              </h1>
              <p className="text-muted mt-3 mb-9 text-[17px] font-medium">
                Your voice and chat assistants, from {host}.
              </p>
              <BuildProgress stage={state} elapsedMs={demoBuildElapsedMs(session)} host={host} />
            </main>
          </>
        ) : (
          <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center justify-center px-5 py-24 text-center">
            <h1 className="font-display text-[34px] leading-tight font-medium tracking-[-0.02em]">
              We&rsquo;re preparing {name}&rsquo;s demo
            </h1>
            <p className="text-muted mt-3 text-[17px] font-medium">
              {isSelfServeDemo(session)
                ? `Our team is putting the finishing touches on it, and we'll email you the moment it's ready. Questions: ${site.email}.`
                : "Our team is putting the finishing touches on it. Check back shortly, or reply to our email and we'll let you know the moment it's ready."}
            </p>
          </main>
        )}
      </Shell>
    );
  }

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
            >
              {site.cta.primary.label}
            </DemoBuyButton>
          ) : (
            <a
              href={`/demo/${slug}/onboard`}
              className="ml-auto shrink-0 rounded-full px-4 py-2 text-[15px] font-bold transition-opacity hover:opacity-90 sm:px-5 sm:py-2.5"
              style={ctaStyle}
            >
              Book Onboarding
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
            {site.agent} already knows {name}&rsquo;s services, prices and FAQs. Try her the way a {one} would.
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

  if (!selfServe) return page;
  return (
    <BuyModalProvider
      // A demo already bought opens the plain purchase: its offer and its claim are spent.
      demo={session.claimed ? undefined : { slug, checkout: demoCheckout(session), prefill: demoPrefill(session) }}
    >
      {page}
    </BuyModalProvider>
  );
}
