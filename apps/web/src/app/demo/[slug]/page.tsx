import { shortClinicName } from "@healdesk/catalog";
import type { Metadata } from "next";
import { Lora } from "next/font/google";
import { notFound } from "next/navigation";

import { DemoBuildWait } from "@/components/demo/DemoBuildWait";
import { avatarLogo, chipsFor, Shell } from "@/components/demo/DemoShell";
import { RefreshWhileBuilding } from "@/components/demo/DemoTimers";
import { DemoV2Islands } from "@/components/demo/DemoV2Islands";
import { DemoViewed } from "@/components/demo/DemoViewed";
import { LegacyDemoReady } from "@/components/demo/LegacyDemoReady";
import { chatGreeting } from "@/lib/demo/clinic-prompts";
import {
  demoAudience,
  demoBuildElapsedMs,
  demoBuildState,
  demoOfferEndsAt,
  demoSetupCredit,
  demoUrl,
  displayName,
  findDemoSession,
  getDemoSession,
  isDemoExpired,
  isDemoSlug,
  isSelfServeDemo,
  profileOf,
} from "@/lib/demo/sessions";
import { renderDemoV2 } from "@/lib/demo/v2/render";
import { SCRIPT_ID } from "@/lib/demo/v2/slots";
import { site } from "@/lib/site";

import "./demo-v2.css";

/**
 * The owner's page sets "Lora" as its serif from Google Fonts; the site's
 * CSP serves fonts from its own origin only, so Next serves the same Lora
 * here (demo-v2.css reads it through --hd-lora).
 */
const lora = Lora({ subsets: ["latin"], weight: ["500", "600"], style: ["normal", "italic"], variable: "--hd-lora", display: "swap" });

/**
 * /demo/[slug], one prospect's private, branded demo.
 *
 * Three states, decided on the server from the `demo_sessions` row:
 *
 *   - building (or failed): a holding screen that re-renders itself until
 *     the build lands. A failed build looks the same to the prospect; the
 *     reason is in the operator's console, not on their screen.
 *   - ready: the owner's demo page (owner, 30 October 2026; lib/demo/v2),
 *     the same for every demo but a vet's (which keeps the page it had,
 *     components/demo/LegacyDemoReady.tsx, because the new one promises a BAA), with the clinic's own name, phone, hours and
 *     what the build found filled in on the server, the demo's own discount
 *     and its server-side deadline, and the repo's voice and chat cards in its
 *     two card slots (components/demo/DemoV2Islands.tsx). Pay opens the normal
 *     purchase on the plan built on the page (/demo/[slug]/onboard), which
 *     signs the agreements and takes the card.
 *   - expired: the same page with both cards locked. The API routes refuse an
 *     expired demo on their own, so the lock is not just a coat of paint.
 *
 * The page reports demo viewed and button pressed (lib/demo/events.ts) as
 * before, and paid from the Stripe webhook.
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

export default async function DemoPage({ params }: Props) {
  const { slug } = await params;
  if (!isDemoSlug(slug)) notFound();
  const session = await findDemoSession(slug);
  // A failed read is not a missing demo: say it is loading and try again,
  // never the site's 404 (owner, 30 October 2026).
  if (session === "unavailable") {
    return (
      <Shell colour={FALLBACK_COLOUR}>
        <RefreshWhileBuilding everyMs={4_000} />
        <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center justify-center px-5 py-20 text-center">
          <h1 className="font-display text-[34px] leading-tight font-medium tracking-[-0.02em]">Your demo is loading</h1>
          <p className="text-muted mt-4 text-[17px]">This takes a few seconds. The page opens by itself.</p>
        </main>
      </Shell>
    );
  }
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
            {/* Every four seconds: a building row is cached for five (lib/demo/sessions.ts), so the demo opens within seconds of being ready. */}
            {expired ? null : <RefreshWhileBuilding everyMs={4_000} />}
            <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center justify-center px-5 py-20 text-center">
              <h1 className="font-display text-3xl leading-tight font-medium tracking-[-0.02em]">
                We&rsquo;re building {name}&rsquo;s demo
              </h1>
              <p className="text-muted mt-3 mb-10 text-sm font-medium">
                Your voice and chat assistants, from {host}.
              </p>
              <DemoBuildWait stage={state} elapsedMs={demoBuildElapsedMs(session)} host={host} name={name} logoUrl={session.logoUrl} />
            </main>
          </>
        ) : (
          <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center justify-center px-5 py-24 text-center">
            <h1 className="font-display text-3xl leading-tight font-medium tracking-[-0.02em]">
              We&rsquo;re preparing {name}&rsquo;s demo
            </h1>
            <p className="text-muted mt-3 text-base font-medium">
              {isSelfServeDemo(session)
                ? `Our team is putting the finishing touches on it, and we'll email you the moment it's ready. Questions: ${site.email}.`
                : "Our team is putting the finishing touches on it. Check back shortly, or reply to our email and we'll let you know the moment it's ready."}
            </p>
          </main>
        )}
      </Shell>
    );
  }

  // In the clinic's own word: a vet's callers are its clients (demoAudience).
  const audience = demoAudience(session);
  // The owner's page speaks of patients, HIPAA and a BAA throughout; a vet
  // signs a data protection agreement instead, so a vet's demo keeps the page
  // it had until the owner decides what it shows (components/demo/LegacyDemoReady.tsx).
  if (audience === "clients") {
    return (
      <LegacyDemoReady
        slug={slug}
        session={session}
        profile={profile}
        name={name}
        colour={colour}
        expired={expired}
        offerEnds={offerEnds}
        demoLine={demoLine}
      />
    );
  }
  // The owner's demo page (lib/demo/v2), for every demo (owner, 30 October
  // 2026): the clinic's own details filled in on the server, the real voice
  // and chat cards in its two card slots.
  const v2 = renderDemoV2({
    slug,
    url: demoUrl(slug),
    profile,
    name,
    logoUrl: session.logoUrl,
    leadEmail: session.leadEmail,
    percentOff: demoSetupCredit(session).percentOfSetupFee,
    // A demo already bought has spent its offer; the page shows it as ended.
    offerEndsAt: session.claimed ? null : offerEnds,
    ayaImage: "/brand/aya-hero.webp",
  });

  return (
    <>
      <DemoViewed slug={slug} />
      <div className={`hd-demo-v2 ${lora.variable}`} dangerouslySetInnerHTML={{ __html: v2.body }} />
      <DemoV2Islands
        slug={slug}
        name={name}
        clinic={shortClinicName(name)}
        locked={expired}
        logoUrl={avatarLogo(session.logoUrl)}
        greeting={chatGreeting(name, audience)}
        chips={chipsFor(profile)}
      />
      {/* The page's own script (lib/demo/v2/template.ts), as delivered but for render.ts's swaps; DemoV2Islands runs it after hydration. */}
      <script type="text/plain" id={SCRIPT_ID} dangerouslySetInnerHTML={{ __html: v2.script }} />
    </>
  );
}
