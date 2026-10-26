import { AgentMark, AgentPanel } from "@/components/agent-panel/AgentPanel";
import { VoiceCard } from "@/components/agent-panel/VoiceCard";
import { ClinicChatPanel } from "@/components/demo/ClinicChatPanel";
import { ClosingOffer } from "@/components/demo/ClosingOffer";
import { CoverageModes } from "@/components/demo/CoverageModes";
import { ActivateButton, DemoCloseProvider, TopOfferBar } from "@/components/demo/DemoClose";
import { DemoPanels, MobileBarAfterHere } from "@/components/demo/DemoPanels";
import { Archived, avatarLogo, chipsFor, Shell } from "@/components/demo/DemoShell";
import { CopyDemoLink, DemoCountdown } from "@/components/demo/DemoTimers";
import { ValueTiles } from "@/components/demo/ValueTiles";
import { demoCheckout } from "@/lib/demo/checkout";
import { chatGreeting, demoModeLine } from "@/lib/demo/clinic-prompts";
import type { WeekSchedule } from "@/lib/demo/opening-hours";
import type { ClinicProfile } from "@/lib/demo/profile";
import { ASSUMED_SHOW_RATE, DEFAULT_MISSED_CALLS_PER_WEEK, DEFAULT_MISSED_MESSAGES_PER_WEEK } from "@/lib/demo/roi";
import { demoAudience, demoSetupCredit, type DemoSession, isSelfServeDemo } from "@/lib/demo/sessions";
import { site } from "@/lib/site";

/**
 * The redesigned close (lib/demo/close.ts). The demo cards are the same; what
 * is new is around them. A demo past its week keeps its cards locked, as
 * before, and the offer gives way to the standard setup fee, said plainly.
 */
export function ClosePage({
  slug,
  session,
  name,
  colour,
  profile,
  expired,
  offerEnds,
  demoLine,
  schedule,
  initialEnded,
  ringNote,
}: {
  /** Under "Have it ring your phone", in the clinic's own word for its people (the page's own). */
  ringNote: string;
  /** Which demo conversations have ended already: none, on a real page. */
  initialEnded?: { voice: boolean; chat: boolean };
  slug: string;
  session: DemoSession;
  name: string;
  colour: string;
  profile: ClinicProfile;
  expired: boolean;
  offerEnds: Date | null;
  demoLine: string | null;
  schedule: WeekSchedule;
}) {
  const roi = demoCheckout(session).roi;
  // In the clinic's own word: a vet's callers are its clients (demoAudience).
  const audience = demoAudience(session);
  const one = audience === "clients" ? "client" : "patient";
  const source = !schedule.listed
    ? null
    : profile.hoursSource === "google"
      ? ({ kind: "google", place: profile.hoursPlace } as const)
      : ({ kind: "website" } as const);
  return (
    <DemoCloseProvider
      slug={slug}
      clinicName={name}
      logoUrl={session.logoUrl}
      selfServe={isSelfServeDemo(session)}
      audience={audience}
      initialInputs={{
        ...roi,
        missedCallsPerWeek: DEFAULT_MISSED_CALLS_PER_WEEK,
        missedMessagesPerWeek: DEFAULT_MISSED_MESSAGES_PER_WEEK,
        showRate: ASSUMED_SHOW_RATE,
      }}
      terms={{ percent: demoSetupCredit(session).percentOfSetupFee, endsAt: offerEnds ? offerEnds.toISOString() : null }}
      initialEnded={initialEnded}
    >
      <Shell colour={colour}>
        {expired ? (
          <div className="bg-ink sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 px-5 py-3 text-center text-[15px] font-semibold text-white sm:px-8">
            <span>This demo has ended. {name}&rsquo;s {site.agent} is still ready to activate.</span>
            <CopyDemoLink />
          </div>
        ) : (
          <TopOfferBar demoClock={<DemoCountdown expiresAt={session.expiresAt.toISOString()} />} copyLink={<CopyDemoLink />} />
        )}

        <header className="border-line/60 border-b">
          <div className="mx-auto flex max-w-[1240px] items-center gap-3 px-4 py-4 sm:px-8 lg:px-14">
            <AgentMark name={name} logoUrl={session.logoUrl} />
            {session.logoUrl ? null : (
              <span className="font-display hidden min-w-0 truncate text-[21px] font-semibold tracking-[-0.01em] sm:inline">{name}</span>
            )}
            <span aria-hidden className="text-muted text-[18px] font-light">×</span>
            <a href="/" aria-label="healdesk" className="shrink-0">
              <img src="/brand/healdesk-logo.webp" alt="healdesk" width={2400} height={437} className="h-[20px] w-auto sm:h-[26px]" />
            </a>
            <ActivateButton placement="header" size="sm" subLabel={false} className="ml-auto shrink-0" />
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1240px] px-4 pt-10 pb-28 sm:px-8 sm:pb-16 lg:px-14">
          <div className="max-w-[760px]">
            <h1 className="font-display mt-2 text-[34px] leading-[1.1] font-medium tracking-[-0.02em] sm:text-[44px]">
              {name}, answering every call and chat.
            </h1>
            <p className="text-muted mt-3 max-w-[56ch] text-[18px] leading-[1.5] font-medium">
              Your {site.agent} already knows {name}&rsquo;s services, prices and hours. Call her or message her the way a{" "}
              {one} would.
            </p>
          </div>

          {expired ? (
            <>
              <div className="mt-8 grid gap-5 lg:grid-cols-2">
                <AgentPanel label={`${site.agent} voice agent`} title="Your phone line" name={name} logoUrl={session.logoUrl} overlay={<Archived />}>
                  <VoiceCard
                    name={name}
                    callRoute={`/api/demo/${slug}/retell`}
                    demoLine={null}
                    ringNote={ringNote}
                    locked
                  />
                </AgentPanel>
                <AgentPanel label={`${site.agent} chat`} title="Your website, WhatsApp, Instagram and Messenger" name={name} logoUrl={session.logoUrl} overlay={<Archived />}>
                  <ClinicChatPanel slug={slug} clinicName={name} logoUrl={avatarLogo(session.logoUrl)} greeting={chatGreeting(name, audience)} chips={[]} locked />
                </AgentPanel>
              </div>
              <MobileBarAfterHere />
            </>
          ) : (
            <DemoPanels
              slug={slug}
              logoUrl={session.logoUrl}
              avatarLogoUrl={avatarLogo(session.logoUrl)}
              greeting={chatGreeting(name, audience)}
              chips={chipsFor(profile)}
              demoLine={demoLine}
              prefillPhone={session.phoneE164}
              ringNote={ringNote}
            />
          )}

          <aside className="border-line mt-6 rounded-md border bg-white px-5 py-4 text-center">
            <p className="text-[15.6px] leading-[1.5] font-medium">&ldquo;{demoModeLine(name)}&rdquo;</p>
          </aside>

          <CoverageModes schedule={schedule} source={source} />
          <ValueTiles schedule={schedule} />
          <ClosingOffer />
        </main>
      </Shell>
    </DemoCloseProvider>
  );
}
