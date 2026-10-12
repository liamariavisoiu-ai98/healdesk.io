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
import { clinicLocalDate } from "@/lib/clinic/closures";
import { disclosureFor } from "@/lib/compliance/disclosure";
import { MAX_PROVIDERS } from "@/lib/connections/google-calendar";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import {
  calendarStep,
  readCalendarNotice,
  requestedScreen,
  type CalendarNotice,
} from "@/lib/setup/calendar";
import { channelNextStep, channelStatusWord, setupSentence } from "@/lib/setup/channels";
import { defaultChatGreeting, defaultPhoneGreeting } from "@/lib/setup/greetings";
import { formatPhone, helpContacts } from "@/lib/setup/help";
import { serviceInputOf } from "@/lib/setup/knowledge";
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
import { loadSetupState, type SetupState } from "@/lib/setup/state";
import { urgentHelpField } from "@/lib/setup/urgent";

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
 * it is set (actions.ts) and to reconnect or disconnect a connected calendar
 * (calendar-actions.ts). Google's sign-in comes back to this page with only
 * `?calendar=<outcome>`, which opens the calendar step and says what happened.
 */
export default async function SetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ s?: string | string[]; calendar?: string | string[] }>;
}) {
  const { slug } = await params;
  const portal = await requirePortal(slug);
  const { s, calendar } = await searchParams;
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
  const requested = requestedScreen(state.screens, s, notice);
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
          notice: screen === "calendar" ? notice : null,
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
  /** What Google's return, or a calendar button, said happened: the calendar step only. */
  notice: CalendarNotice | null;
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
      if (channels.includes("web") || channels.includes("meta")) {
        greetings.push({
          kind: "chat" as const,
          // Website chat's line where the clinic has it; a Meta-only clinic's
          // people read the Meta channels' own warning first.
          lockedLine: disclosureFor({
            clinicName: name,
            channel: channels.includes("web") ? "web_chat" : "instagram_dm",
          }),
          text: settings.chatGreeting ?? defaultChatGreeting(),
          isDefault: settings.chatGreeting === null,
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
        <DepositsScreen
          {...common}
          services={knowledge.services.map((s) => ({
            name: s.name,
            depositUsd: s.depositUsd ?? null,
          }))}
          collectionLine={
            channels.includes("voice") && channels.length === 1
              ? "On a call AYA can't take a card, so she books the appointment and flags the deposit for your team to collect."
              : "Until a payment account is connected, AYA books the appointment and flags the deposit for your team to collect."
          }
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
        />
      );
    }

    case "calendar":
      return <CalendarStep state={state} common={common} notice={nav.notice} actor={nav.actor} />;

    case "providers":
      return <ProvidersStep state={state} common={common} actor={nav.actor} />;

    case "channels": {
      const finished = state.screens
        .filter((id) => id !== "channels" && SCREEN_DEFINITIONS[id].step !== "end")
        .every((id) => state.progress.has(id));
      return (
        <ChannelsScreen
          slug={nav.slug}
          backHref={nav.backHref}
          callBookingUrl={helpContacts().callBookingUrl}
          rows={state.channels.map((c) => {
            const step = channelNextStep(c, finished);
            return {
              channel: c.channel,
              name: CHANNEL_NAMES[c.channel],
              status: channelStatusWord(c.status),
              line: setupSentence(c.channel, step),
            };
          })}
        />
      );
    }

    case "backup":
      return <BackupScreen slug={nav.slug} doneHref={nav.home} />;
  }
}

async function CalendarStep({
  state,
  common,
  notice,
  actor,
}: {
  state: SetupState;
  common: { slug: string; backHref: string | null; skipCost: string };
  notice: CalendarNotice | null;
  actor: ActorContext;
}) {
  const step = await calendarStep({ id: state.clinic.id, name: state.clinic.name }, { actor });
  return (
    <CalendarStepView
      {...common}
      step={step}
      notice={notice}
      settings={state.settings}
      timeZone={state.clinic.timezone}
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
