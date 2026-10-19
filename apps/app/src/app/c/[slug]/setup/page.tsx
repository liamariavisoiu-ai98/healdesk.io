import {
  AFTER_HOURS_ONLY_LANDLINE_NOTE,
  ASSISTANT_TONE_OPTIONS,
  audienceFor,
  CHANNEL_NAMES,
  COVERAGE_MODE_OPTIONS,
  timeZoneForUsAddress,
  US_TIME_ZONES,
} from "@healdesk/catalog";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import type { ActorContext } from "@/lib/audit";
import { connectConfigured } from "@/lib/billing/connect";
import { getDepositSettings } from "@/lib/billing/deposits";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { disclosureFor } from "@/lib/compliance/disclosure";
import { URGENT_ALERT_DELIVERED } from "@/lib/notices/booking-alerts";
import { MAX_PROVIDERS } from "@/lib/connections/google-calendar";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import {
  autoConfirmFor,
  calendarStep,
  readCalendarNotice,
  requestedScreen,
  type CalendarNotice,
} from "@/lib/setup/calendar";
import { channelNextStep, channelStatusLabel, setupSentence } from "@/lib/setup/channels";
import {
  defaultChatGreeting,
  defaultPhoneGreeting,
  META_GREETING_NOTE,
} from "@/lib/setup/greetings";
import {
  forwardingView,
  voiceForwardingReady,
  waitsOnDirectLine,
  type ForwardingFacts,
} from "@/lib/setup/forwarding";
import { readForwardingTest } from "@/lib/setup/forwarding-test-view";
import { formatPhone, helpContacts } from "@/lib/setup/help";
import { serviceInputOf } from "@/lib/setup/knowledge";
import {
  depositCollectionLine,
  readConnectOutcome,
  setupStripeView,
  type ConnectOutcome,
} from "@/lib/setup/payments";
import { providersStep } from "@/lib/setup/providers";
import {
  neighbours,
  resumeScreen,
  SCREEN_DEFINITIONS,
  STEP_TITLES,
  wizardFinished,
  type StepNumber,
} from "@/lib/setup/screens";
import type { SetupScreenId } from "@/lib/setup/screen-ids";
import { skipCost } from "@/lib/setup/skip-costs";
import { snippetOpen, widgetSnippet } from "@/lib/setup/snippet";
import { loadSetupState, type SetupState } from "@/lib/setup/state";
import { urgentHelpField } from "@/lib/setup/urgent";
import { readMetaConnectView } from "@/lib/meta/reconnect";
import { withTenant } from "@/lib/tenant";

import { HelpPanel } from "../HelpPanel";

import { connectCalendar, disconnectCalendar } from "./calendar-actions";
import { BackupScreen } from "./screens/BackupScreen";
import {
  CoverageScreen,
  DepositsScreen,
  DirectLineScreen,
  ToneScreen,
  UrgentScreen,
} from "./screens/BehaviourScreens";
import { ProvidersScreen } from "./screens/CalendarScreens";
import { CalendarStepView } from "./screens/CalendarStepView";
import { ChannelsScreen } from "./screens/ChannelsScreen";
import {
  BasicsScreen,
  HoursScreen,
  InsuranceScreen,
  QuestionScreen,
  ServicesScreen,
  type HoursInitial,
} from "./screens/PracticeScreens";

export const metadata: Metadata = { title: "Set up AYA", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * /c/<slug>/setup: the setup wizard (plan Part E). Four steps, one decision
 * per screen, each saved as it is left; without `?s=` it opens on the first
 * screen nobody has answered or skipped, so a clinic that stopped at step
 * three comes back to step three. Every screen is pre-filled from the
 * purchase and the website read, and says what skipping it costs. After the
 * last screen: the backup factor, once, then the build tracker on the
 * clinic's page.
 *
 * Anyone using the clinic's sign-in can continue setup; nothing here shows a
 * patient, so no step-up is asked for, except to change the direct line once
 * it is set (actions.ts), to disconnect a connected calendar
 * (calendar-actions.ts), and to put the bookings in another Google account,
 * which the calendar session's callback checks. Google's sign-in comes back
 * to this page with only `?calendar=<outcome>`, which opens the calendar
 * step and says what happened.
 */
export default async function SetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    s?: string | string[];
    calendar?: string | string[];
    connect?: string | string[];
    meta?: string | string[];
  }>;
}) {
  const { slug } = await params;
  const portal = await requirePortal(slug);
  const { s, calendar, connect, meta } = await searchParams;
  const actor = await portalActor(portal);
  const who: ActorContext = { type: "user", userId: portal.userId, label: actor.label };
  const state = await loadSetupState({
    clinicId: portal.clinicId,
    userId: portal.userId,
    actor: who,
  });
  if (!state) notFound();
  const home = `/c/${portal.clinicSlug}`;

  if (state.clinic.offboardingStartedAt) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-16">
        <h1 className="text-2xl font-semibold">This account has closed</h1>
        <p className="text-muted mt-3">
          There is nothing left to set up. If you think this is a mistake, email hello@healdesk.io.
        </p>
      </main>
    );
  }

  const notice = readCalendarNotice(calendar);
  // Stripe's return from 2.4's Connect Stripe opens the deposits screen
  // again, saying how it went (lib/setup/payments.ts).
  const connectOutcome = readConnectOutcome(connect);
  const requested =
    requestedScreen(state.screens, s, notice) ??
    (connectOutcome && state.screens.includes("deposits") ? "deposits" : null);
  if (!requested) {
    const resume = resumeScreen(state.screens, state.progress);
    redirect(resume ? `${home}/setup?s=${resume}` : home);
  }
  const screen: SetupScreenId = requested;
  const definition = SCREEN_DEFINITIONS[screen];
  const { previous } = neighbours(state.screens, screen);
  const backHref = previous ? `${home}/setup?s=${previous}` : null;
  const audience = audienceFor(state.clinic.specialty);
  return (
    <main className="mx-auto min-h-screen max-w-xl px-4 py-10">
      <p className="text-muted text-sm">
        <a href={home} className="underline underline-offset-2">
          {state.clinic.name}
        </a>{" "}
        · Setup
      </p>
      <Progress state={state} screen={screen} home={home} />
      <section className="mt-8">
        {renderScreen(state, screen, {
          slug: portal.clinicSlug,
          backHref,
          home,
          actor: who,
          steppedUp: actor.steppedUp,
          notice: screen === "calendar" ? notice : null,
          connectOutcome: screen === "deposits" ? connectOutcome : null,
          metaProblem: screen === "channels" && typeof meta === "string" ? meta : null,
        })}
      </section>
      <HelpPanel audience={audience} />
      {definition.step === "end" ? null : (
        <p className="text-muted mt-6 text-xs">
          Every step saves as you finish it. Close this page any time; setup picks up where you left
          it.
        </p>
      )}
    </main>
  );
}

/** "Step 1 of 4 · Your practice", the bar inside the step, and the step's screens with their ticks. */
function Progress({
  state,
  screen,
  home,
}: {
  state: SetupState;
  screen: SetupScreenId;
  home: string;
}) {
  const step = SCREEN_DEFINITIONS[screen].step;
  if (step === "end") {
    return (
      <p className="mt-4 text-sm font-semibold">
        {wizardFinished(state.screens, state.progress)
          ? "Setup done · one last thing"
          : "One last thing"}
      </p>
    );
  }
  const inStep = state.screens.filter((id) => SCREEN_DEFINITIONS[id].step === step);
  const done = inStep.filter((id) => state.progress.has(id)).length;
  return (
    <div className="mt-4">
      <p className="text-sm font-semibold">
        Step {step} of 4 · {STEP_TITLES[step as StepNumber]}
      </p>
      {/* One segment per screen, filled as each is left: no inline style,
          which the page's Content-Security-Policy would refuse. */}
      <div
        role="progressbar"
        aria-label={`Step ${step} progress`}
        aria-valuemin={0}
        aria-valuemax={inStep.length}
        aria-valuenow={done}
        className="mt-2 flex h-2 gap-1"
      >
        {inStep.map((id) => (
          <span
            key={id}
            className={`h-full flex-1 rounded-full ${state.progress.has(id) ? "bg-green" : "bg-paper-2"}`}
          />
        ))}
      </div>
      {inStep.length > 1 ? (
        <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {inStep.map((id) => {
            const outcome = state.progress.get(id)?.outcome;
            return (
              <li key={id}>
                <a
                  href={`${home}/setup?s=${id}`}
                  aria-current={id === screen ? "step" : undefined}
                  className={
                    id === screen
                      ? "font-semibold"
                      : "text-muted underline-offset-2 hover:underline"
                  }
                >
                  {SCREEN_DEFINITIONS[id].title}
                  {outcome === "done" ? (
                    <span className="text-green">
                      {" "}
                      ✓<span className="sr-only"> saved</span>
                    </span>
                  ) : outcome === "skipped" ? (
                    <span className="text-muted"> · skipped</span>
                  ) : null}
                </a>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

type Nav = {
  slug: string;
  backHref: string | null;
  home: string;
  actor: ActorContext;
  /** Whether a passkey step-up is live on this session. */
  steppedUp: boolean;
  /** What Google's return, or a calendar button, said happened: the calendar step only. */
  notice: CalendarNotice | null;
  /** What Stripe's return said happened: the deposits screen only. */
  connectOutcome: ConnectOutcome | null;
  /** A Meta login that could not start (`?meta=`): the channels screen only. */
  metaProblem: string | null;
};

function renderScreen(state: SetupState, screen: SetupScreenId, nav: Nav) {
  const common = { slug: nav.slug, backHref: nav.backHref, skipCost: skipCost(state, screen) };
  const { clinic, settings, knowledge } = state;
  const audience = audienceFor(clinic.specialty);
  const channels = state.channels.map((c) => c.channel);

  switch (screen) {
    case "basics":
      return (
        <BasicsScreen
          {...common}
          initial={{
            name: clinic.name,
            address: clinic.address ?? "",
            phone: clinic.publishedPhoneE164 ? formatPhone(clinic.publishedPhoneE164) : "",
            website: clinic.website ?? "",
            timezone: clinic.timezone,
            timezoneConfirmed: clinic.timezoneConfirmed,
          }}
          addressZone={timeZoneForUsAddress(clinic.address)}
          zones={US_TIME_ZONES}
          locations={(clinic.siteProfile?.locations ?? []).map((l) => ({
            label: l.label,
            address: l.address,
            phone: l.phone,
          }))}
        />
      );

    case "hours":
      return (
        <HoursScreen
          {...common}
          initial={clinic.openingHours ? (clinic.openingHours as unknown as HoursInitial) : null}
          closures={state.closures}
          readFromSite={clinic.siteProfile !== null && !clinic.onboarding.hours_confirmed}
          today={clinicLocalDate(new Date(), clinic.timezone)}
        />
      );

    case "services":
      return (
        <ServicesScreen
          {...common}
          initial={knowledge.services.map((service) => {
            const input = serviceInputOf(service);
            return {
              name: input.name,
              priceKind: input.priceKind,
              price: input.price === null ? "" : String(input.price),
              maxPrice: input.maxPrice === null ? "" : String(input.maxPrice),
              unit: input.unit ?? "",
              duration: input.durationMinutes === null ? "" : String(input.durationMinutes),
              depositUsd: input.depositUsd ?? null,
            };
          })}
          dropped={clinic.siteProfile?.dropped ?? 0}
          readFromSite={clinic.siteProfile !== null}
        />
      );

    case "question": {
      const fromSite = knowledge.mostAsked === null ? (knowledge.quickAnswers[0] ?? null) : null;
      const current = knowledge.mostAsked ?? fromSite;
      return (
        <QuestionScreen
          {...common}
          question={current?.question ?? ""}
          answer={current?.answer ?? ""}
          fromSite={fromSite !== null}
        />
      );
    }

    case "insurance":
      return <InsuranceScreen {...common} />;

    case "tone": {
      const name = clinic.name;
      const greetings = [];
      if (channels.includes("voice")) {
        greetings.push({
          kind: "phone" as const,
          lockedLine: disclosureFor({ clinicName: name, channel: "voice" }),
          text: settings.phoneGreeting ?? defaultPhoneGreeting(name),
          isDefault: settings.phoneGreeting === null,
        });
      }
      // Website chat's alone: Instagram, Messenger and WhatsApp open with
      // their own fixed line, and the clinic with them is told so.
      if (channels.includes("web")) {
        greetings.push({
          kind: "chat" as const,
          lockedLine: disclosureFor({ clinicName: name, channel: "web_chat" }),
          text: settings.chatGreeting ?? defaultChatGreeting(),
          isDefault: settings.chatGreeting === null,
          note: channels.includes("meta") ? META_GREETING_NOTE : null,
        });
      }
      return (
        <ToneScreen
          {...common}
          tone={settings.tone}
          toneOptions={ASSISTANT_TONE_OPTIONS}
          greetings={greetings}
        />
      );
    }

    case "coverage":
      return (
        <CoverageScreen
          {...common}
          coverageMode={settings.coverageMode}
          options={COVERAGE_MODE_OPTIONS}
          landlineNote={AFTER_HOURS_ONLY_LANDLINE_NOTE}
        />
      );

    case "direct_line":
      return (
        <DirectLineScreen
          {...common}
          directLine={settings.directLineE164 ? formatPhone(settings.directLineE164) : ""}
          isSet={settings.directLineE164 !== null}
        />
      );

    case "deposits":
      return (
        <DepositsStep
          state={state}
          common={common}
          actor={nav.actor}
          outcome={nav.connectOutcome}
        />
      );

    case "urgent": {
      // The clinic's own number only: the default (the direct line, or the
      // main number without phone) is named beside the field and resolved
      // when the number is read, so it is never frozen as a copy.
      const field = urgentHelpField(state);
      return (
        <UrgentScreen
          {...common}
          urgentHelp={field.value}
          urgentPlaceholder={field.placeholder}
          urgentHint={field.hint}
          vet={clinic.regulatoryRegime === "non-hipaa"}
          vetReferral={settings.vetReferralE164 ? formatPhone(settings.vetReferralE164) : ""}
          audience={audience}
          address={state.address}
          teamAlerted={URGENT_ALERT_DELIVERED}
        />
      );
    }

    case "calendar":
      return (
        <CalendarStep
          state={state}
          common={common}
          notice={nav.notice}
          actor={nav.actor}
          steppedUp={nav.steppedUp}
        />
      );

    case "providers":
      return <ProvidersStep state={state} common={common} actor={nav.actor} />;

    case "channels":
      return (
        <ChannelsStep
          state={state}
          slug={nav.slug}
          backHref={nav.backHref}
          actor={nav.actor}
          metaProblem={nav.metaProblem}
        />
      );

    case "backup":
      return <BackupScreen slug={nav.slug} doneHref={nav.home} />;
  }
}

/**
 * 2.4, with what the payment account says: whether Stripe is connected
 * decides the first line and the Connect Stripe button (lib/setup/payments.ts),
 * read here because setup's own state does not carry it.
 */
async function DepositsStep({
  state,
  common,
  actor,
  outcome,
}: {
  state: SetupState;
  common: { slug: string; backHref: string | null; skipCost: string };
  actor: ActorContext;
  outcome: ConnectOutcome | null;
}) {
  const channels = state.channels.map((c) => c.channel);
  const deposits = await withTenant({ clinicId: state.clinic.id, actor }, getDepositSettings);
  return (
    <DepositsScreen
      {...common}
      services={state.knowledge.services.map((s) => ({
        name: s.name,
        depositUsd: s.depositUsd ?? null,
      }))}
      collectionLine={depositCollectionLine({ channels, isConnected: deposits.isConnected })}
      stripe={setupStripeView({
        slug: common.slug,
        channels,
        isConnected: deposits.isConnected,
        connectConfigured: connectConfigured(),
        outcome,
      })}
    />
  );
}

/**
 * Step 4, bought channels only, with each one's step where it is ready:
 * the website line once website chat is open, the Meta login until a
 * platform is connected, and the forwarding steps only once voice is ready
 * for the clinic (lib/setup/forwarding.ts). Before that, each says what it
 * waits for in words, with no number and no codes.
 */
async function ChannelsStep({
  state,
  slug,
  backHref,
  actor,
  metaProblem,
}: {
  state: SetupState;
  slug: string;
  backHref: string | null;
  actor: ActorContext;
  metaProblem: string | null;
}) {
  const finished = state.screens
    .filter((id) => id !== "channels" && SCREEN_DEFINITIONS[id].step !== "end")
    .every((id) => state.progress.has(id));
  const bought = state.channels.map((c) => c.channel);
  const metaView = bought.includes("meta")
    ? await withTenant({ clinicId: state.clinic.id, actor }, (tx) => readMetaConnectView(tx.db, tx.clinicId))
    : null;
  const facts: ForwardingFacts = {
    voice: state.channels.find((c) => c.channel === "voice"),
    assistantNumberE164: state.clinic.assistantNumberE164,
    directLineE164: state.settings.directLineE164,
  };
  // "Test it now" and what it saw, beside the forwarding steps.
  const forwardingTest = voiceForwardingReady(facts)
    ? await withTenant({ clinicId: state.clinic.id, actor }, (tx) => readForwardingTest(tx))
    : null;
  return (
    <ChannelsScreen
      slug={slug}
      backHref={backHref}
      // This app's /help/call, as Help links it, which sends the browser on
      // to the scheduling page set now; never the scheduling page itself.
      callBookingUrl={helpContacts().callBookingUrl ? "/help/call" : null}
      metaProblem={metaProblem}
      rows={state.channels.map((c) => {
        const step = channelNextStep(c, finished);
        const row = {
          channel: c.channel,
          name: CHANNEL_NAMES[c.channel],
          status: channelStatusLabel(c, state.clinic.timezone, new Date()),
          line: setupSentence(c.channel, step),
        };
        // A step shown below the row is the one the row names, whatever
        // else is left in setup: the line never says "after setup" beside it.
        switch (c.channel) {
          case "web":
            return snippetOpen(c)
              ? {
                  ...row,
                  line: setupSentence("web", "snippet"),
                  snippet: widgetSnippet(state.clinic.slug),
                }
              : row;
          case "meta":
            return {
              ...row,
              meta: metaView,
            };
          case "voice":
            return voiceForwardingReady(facts)
              ? {
                  ...row,
                  line: setupSentence("voice", "forwarding"),
                  forwarding: forwardingView({
                    assistantNumberE164: state.clinic.assistantNumberE164!,
                    carrier: state.clinic.carrier,
                    phoneSystemType: state.clinic.phoneSystemType,
                    coverageMode: state.settings.coverageMode,
                  }),
                  forwardingTest,
                }
              : {
                  ...row,
                  directLineHref: waitsOnDirectLine(facts)
                    ? `/c/${slug}/setup?s=direct_line`
                    : null,
                };
        }
      })}
    />
  );
}

async function CalendarStep({
  state,
  common,
  notice,
  actor,
  steppedUp,
}: {
  state: SetupState;
  common: { slug: string; backHref: string | null; skipCost: string };
  notice: CalendarNotice | null;
  actor: ActorContext;
  steppedUp: boolean;
}) {
  const [step, autoConfirm] = await Promise.all([
    calendarStep({ id: state.clinic.id, name: state.clinic.name }, { actor }),
    autoConfirmFor(state.clinic.id, state.settings, { actor }),
  ]);
  return (
    <CalendarStepView
      {...common}
      step={step}
      notice={notice}
      bookingSystem={state.settings.bookingSystem}
      autoConfirm={autoConfirm}
      timeZone={state.clinic.timezone}
      steppedUp={steppedUp}
      actions={{ connect: connectCalendar, disconnect: disconnectCalendar }}
    />
  );
}

async function ProvidersStep({
  state,
  common,
  actor,
}: {
  state: SetupState;
  common: { slug: string; backHref: string | null; skipCost: string };
  actor: ActorContext;
}) {
  const services = state.knowledge.services.map((service) => service.name);
  const step = await providersStep(
    {
      id: state.clinic.id,
      name: state.clinic.name,
      services,
      siteProfile: state.clinic.siteProfile,
    },
    { actor },
  );
  return (
    <ProvidersScreen
      {...common}
      bookingDetail={state.settings.bookingDetail}
      named={
        step.kind === "named" ? { calendars: step.calendars, providers: step.providers } : null
      }
      unavailable={step.kind === "generic_only" ? step.reason : null}
      providersRead={state.clinic.siteProfile?.providers.length ?? 0}
      services={services}
      maxProviders={MAX_PROVIDERS}
    />
  );
}
