import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ClinicChatPanel } from "@/components/demo/ClinicChatPanel";
import { ClinicVoicePanel } from "@/components/demo/ClinicVoicePanel";
import { DemoCountdown, RefreshWhileBuilding } from "@/components/demo/DemoTimers";
import { chatGreeting, demoModeLine } from "@/lib/demo/clinic-prompts";
import type { ClinicProfile } from "@/lib/demo/profile";
import { displayName, getDemoSession, isDemoExpired, isDemoSlug, profileOf } from "@/lib/demo/sessions";
import { entityLine } from "@/lib/legal";
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
 *     disclaimer, and Book Onboarding.
 *   - expired: the archived banner, both panels locked, Book Onboarding
 *     still there. The API routes refuse an expired demo on their own, so
 *     the lock is not just a coat of paint.
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

/** Readable text on the clinic's colour: dark ink on a light brand, white on a dark one. */
function inkOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.45 ? "#172a3a" : "#ffffff";
}

function chipsFor(profile: ClinicProfile): string[] {
  const priced = profile.services.find((s) => s.price);
  const first = priced ?? profile.services[0];
  return [
    first ? `How much is ${first.name}?` : "What treatments do you offer?",
    profile.hours.length > 0 ? "Are you open on Saturdays?" : "What are your opening hours?",
    "Can I book a consultation for next week?",
  ];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
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
      style={{ ["--clinic" as string]: colour, ["--clinic-ink" as string]: inkOn(colour) }}
    >
      {children}
      <footer className="border-line mt-auto border-t px-5 py-6 text-center sm:px-8">
        <p className="text-muted text-[13.2px] font-medium">
          Demo built by{" "}
          <a href="/" className="text-ink font-semibold underline-offset-2 hover:underline">
            {site.name}
          </a>{" "}
          from the clinic&rsquo;s public website. {entityLine()}{" "}
          <a href="/privacy" className="underline underline-offset-2">
            Privacy
          </a>{" "}
          ·{" "}
          <a href="/terms" className="underline underline-offset-2">
            Terms
          </a>
        </p>
      </footer>
    </div>
  );
}

function ClinicMark({ name, logoUrl, size = 40 }: { name: string; logoUrl: string | null; size?: number }) {
  return logoUrl ? (
    // A third-party image by design: the clinic's own logo, from its own site.
    <img
      src={logoUrl}
      alt={`${name} logo`}
      referrerPolicy="no-referrer"
      className="shrink-0 rounded-lg bg-white object-contain"
      style={{ height: size, maxWidth: size * 3.5 }}
    />
  ) : (
    <span
      className="font-display grid shrink-0 place-items-center rounded-lg font-semibold"
      style={{ width: size, height: size, background: "var(--clinic)", color: "var(--clinic-ink)", fontSize: size * 0.45 }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
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

  // Building, or a build that failed and the team is finishing by hand.
  if (!profile || session.status !== "ready") {
    return (
      <Shell colour={colour}>
        {session.status === "building" && !expired ? <RefreshWhileBuilding /> : null}
        <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center justify-center px-5 py-24 text-center">
          <span
            aria-hidden
            className="size-10 animate-spin rounded-full border-4 border-[var(--clinic)] border-t-transparent"
          />
          <h1 className="font-display mt-8 text-[34px] leading-tight font-medium tracking-[-0.02em]">
            We&rsquo;re preparing {name}&rsquo;s demo
          </h1>
          <p className="text-muted mt-3 text-[17px] font-medium">
            {session.status === "building"
              ? "We're reading your website and setting up your voice and chat assistants. This usually takes a minute or two, and this page will update by itself."
              : "Our team is putting the finishing touches on it. Check back shortly, or reply to our email and we'll let you know the moment it's ready."}
          </p>
        </main>
      </Shell>
    );
  }

  return (
    <Shell colour={colour}>
      {/* Top banner: the one-week clock, or the archive notice. */}
      {expired ? (
        <div className="bg-ink px-5 py-3 text-center text-[15px] font-semibold text-white sm:px-8">
          Instance Archived — Server Allocation Window Expired for {name}
        </div>
      ) : (
        <div
          className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-5 py-2.5 text-center text-[15px] font-semibold sm:px-8"
          style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
        >
          <span>Private demo for {name}. Live for</span>
          <DemoCountdown expiresAt={session.expiresAt.toISOString()} />
        </div>
      )}

      <header className="border-line/60 border-b">
        <div className="mx-auto flex max-w-[1240px] items-center gap-3 px-5 py-4 sm:px-8 lg:px-14">
          <ClinicMark name={name} logoUrl={session.logoUrl} />
          <span className="font-display min-w-0 truncate text-[21px] font-semibold tracking-[-0.01em]">{name}</span>
          <a
            href={`/demo/${slug}/onboard`}
            className="ml-auto shrink-0 rounded-full px-4 py-2 text-[15px] font-bold transition-opacity hover:opacity-90 sm:px-5 sm:py-2.5"
            style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
          >
            Book Onboarding
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1240px] px-5 pt-10 pb-16 sm:px-8 lg:px-14">
        <div className="max-w-[760px]">
          <p className="text-muted text-[13.2px] font-bold tracking-[0.1em] uppercase">Your AI front desk, built from {hostOf(session.websiteUrl)}</p>
          <h1 className="font-display mt-2 text-[34px] leading-[1.1] font-medium tracking-[-0.02em] sm:text-[44px]">
            {name}, answering every call and chat.
          </h1>
          <p className="text-muted mt-3 text-[17px] font-medium">
            Both assistants below already know {name}&rsquo;s services, prices, hours and FAQs from your website. Call it, have it call
            you, or chat with it, the way a patient would.
          </p>
        </div>

        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          {[
            {
              label: "AI voice agent",
              title: "Your phone line",
              body: (
                <ClinicVoicePanel slug={slug} clinicName={name} prefillPhone={session.phoneE164} locked={expired} />
              ),
            },
            {
              label: "Website chat",
              title: "The chat on your website",
              body: (
                <ClinicChatPanel
                  slug={slug}
                  clinicName={name}
                  logoUrl={session.logoUrl}
                  greeting={chatGreeting(name)}
                  chips={chipsFor(profile)}
                  locked={expired}
                />
              ),
            },
          ].map((panel) => (
            <section
              key={panel.label}
              className="border-line relative flex flex-col overflow-hidden rounded-3xl border bg-white shadow-[0_1px_2px_rgb(23_42_58/0.06),0_12px_40px_-12px_rgb(23_42_58/0.18)]"
            >
              <div className="border-line flex items-center gap-3 border-b px-5 py-3.5">
                <ClinicMark name={name} logoUrl={session.logoUrl} size={28} />
                <div className="min-w-0">
                  <p className="text-muted text-[12px] font-bold tracking-[0.1em] uppercase">{panel.label}</p>
                  <p className="truncate text-[15.6px] font-semibold">{panel.title}</p>
                </div>
              </div>
              {panel.body}
              {expired ? (
                <div className="bg-paper/80 absolute inset-0 grid place-items-center backdrop-blur-[2px]">
                  <p className="bg-ink rounded-full px-4 py-2 text-[14.4px] font-semibold text-white">Archived</p>
                </div>
              ) : null}
            </section>
          ))}
        </div>

        {/* The training disclaimer, in the brief's words: what demo mode cannot do yet. */}
        <aside className="border-line mt-6 flex gap-3 rounded-2xl border bg-white px-5 py-4">
          <span
            className="mt-0.5 shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-bold tracking-[0.06em] uppercase"
            style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
          >
            Demo mode
          </span>
          <p className="text-[15.6px] leading-[1.5] font-medium">&ldquo;{demoModeLine(name)}&rdquo;</p>
        </aside>

        <section className="bg-panel mt-12 rounded-3xl px-6 py-10 text-center sm:px-10">
          <h2 className="font-display text-[28px] leading-tight font-medium tracking-[-0.02em] sm:text-[34px]">
            Put this on {name}&rsquo;s phone and website.
          </h2>
          <p className="text-muted mx-auto mt-3 max-w-[56ch] text-[16.8px] font-medium">
            Choose voice, website chat or a bundle. Setup takes about fifteen minutes of your time, and each channel goes live as you
            connect it: chat once the snippet is pasted, the phone once call forwarding is set, usually the same day.
          </p>
          <a
            href={`/demo/${slug}/onboard`}
            className="mt-6 inline-flex rounded-full px-7 py-3.5 text-[17px] font-bold shadow-md transition-all duration-200 hover:-translate-y-px"
            style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
          >
            Book Onboarding
          </a>
          <p className="text-muted mt-3 text-[13.2px] font-medium">
            We sign a business associate agreement and handle patient data under it.
          </p>
        </section>
      </main>
    </Shell>
  );
}
