import {
  audienceFor,
  audienceSingular,
  CHANNEL_NAMES,
  getPlan,
  planStartSentence,
} from "@healdesk/catalog";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { formatReplyBy } from "@/lib/reply-by";
import { setupLastDay } from "@/lib/clinic/setup-window";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { channelNextStep, channelStatusWord, setupSentence } from "@/lib/setup/channels";
import {
  resumeScreen,
  SCREEN_DEFINITIONS,
  stepsLeft,
  wizardFinished,
  wizardScreens,
} from "@/lib/setup/screens";
import { loadSetupState } from "@/lib/setup/state";
import { buildTracker, joinWords } from "@/lib/setup/tracker";

import { HelpPanel } from "./HelpPanel";

export const dynamic = "force-dynamic";

/**
 * The clinic's page before go-live (plan Part F1, "Before go-live"): where
 * setup stands, the build tracker, Talk to your AYA (locked until every
 * stage is done, naming what is left), each channel's status in words, and
 * when the plan starts. M3's later screens (Settings, Knowledge, Billing)
 * join it from the same guard; nothing here shows a patient.
 */

async function signOut(): Promise<void> {
  "use server";
  await auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

export default async function ClinicHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const portal = await requirePortal(slug);
  const actor = await portalActor(portal);
  const state = await loadSetupState({
    clinicId: portal.clinicId,
    userId: portal.userId,
    actor: { type: "user", userId: portal.userId, label: actor.label },
  });
  if (!state) notFound();

  const home = `/c/${portal.clinicSlug}`;
  const audience = audienceFor(state.clinic.specialty);
  const one = audienceSingular(audience);
  const tracker = buildTracker(state);
  const finished = wizardFinished(state.screens, state.progress);
  const resume = resumeScreen(wizardScreens(state.screens), state.progress);
  const skipped = wizardScreens(state.screens).filter(
    (id) => state.progress.get(id)?.outcome === "skipped",
  );
  const plan = state.billing ? getPlan(state.billing.boughtPlanId) : undefined;
  const live = state.channels.some((c) => c.liveAt !== null);

  return (
    <main className="mx-auto min-h-screen max-w-xl px-4 py-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{state.clinic.name}</h1>
        <form action={signOut}>
          <button
            type="submit"
            className="border-line min-h-11 rounded-full border px-5 py-2 text-sm font-semibold"
          >
            Sign out
          </button>
        </form>
      </header>

      {state.clinic.offboardingStartedAt ? (
        <p className="mt-6 rounded-xl border border-line bg-white px-4 py-3">
          This account has closed.
        </p>
      ) : (
        <>
          {live ? null : (
            <p className="mt-6 rounded-xl border border-line bg-paper-2 px-4 py-3 text-sm font-semibold">
              AYA isn&rsquo;t answering {audience} yet.{" "}
              <a href="#tracker" className="underline underline-offset-2">
                See where she&rsquo;s up to
              </a>
              .
            </p>
          )}

          <section aria-labelledby="setup-heading" className="mt-8">
            <h2 id="setup-heading" className="text-lg font-semibold">
              Setup
            </h2>
            {finished ? (
              <p className="text-muted mt-2">
                Setup is done.{" "}
                {skipped.length > 0 ? (
                  <>
                    You skipped{" "}
                    {joinWords(skipped.map((id) => SCREEN_DEFINITIONS[id].title.toLowerCase()))}:{" "}
                    <a href={`${home}/setup?s=${skipped[0]}`} className="font-semibold underline">
                      finish {skipped.length === 1 ? "it" : "them"}
                    </a>
                    .
                  </>
                ) : (
                  <a href={`${home}/setup?s=basics`} className="underline underline-offset-2">
                    Change your answers
                  </a>
                )}
              </p>
            ) : (
              <div className="mt-3 rounded-xl border border-line bg-white px-4 py-4">
                <p>
                  {stepsLeft(state.screens, state.progress) === 1
                    ? "One step left, about fifteen minutes in all."
                    : `${stepsLeft(state.screens, state.progress)} steps left, about fifteen minutes in all.`}
                </p>
                <a
                  href={resume ? `${home}/setup?s=${resume}` : `${home}/setup`}
                  className="bg-ink mt-3 inline-flex min-h-11 items-center rounded-full px-6 py-3 text-sm font-bold text-white"
                >
                  Continue setup
                </a>
              </div>
            )}
            {finished && !state.hasBackup ? (
              <p className="text-muted mt-3 text-sm">
                No backup way in yet.{" "}
                <a href={`${home}/setup?s=backup`} className="font-semibold underline">
                  Add an authenticator app
                </a>{" "}
                in case the device with your Face ID is lost.
              </p>
            ) : null}
          </section>

          <section id="tracker" aria-labelledby="tracker-heading" className="mt-10">
            <h2 id="tracker-heading" className="text-lg font-semibold">
              Building your AYA
            </h2>
            <ol className="mt-3 grid gap-2">
              {tracker.stages.map((stage) => (
                <li key={stage.id} className="rounded-xl border border-line bg-white px-4 py-3">
                  <p className="flex items-center justify-between gap-3 font-semibold">
                    <span>{stage.label}</span>
                    <span
                      className={
                        stage.state === "done" ? "text-green text-sm" : "text-muted text-sm"
                      }
                    >
                      {stage.state === "done"
                        ? "Done ✓"
                        : stage.state === "info"
                          ? "For now"
                          : "Not yet"}
                    </span>
                  </p>
                  <p className="text-muted mt-1 text-sm">{stage.detail}</p>
                </li>
              ))}
            </ol>
            <div className="mt-4 rounded-xl border border-line bg-white px-4 py-4">
              <button
                type="button"
                disabled
                aria-describedby="preview-left"
                className="bg-ink min-h-11 rounded-full px-6 py-3 text-sm font-bold text-white opacity-50"
              >
                Talk to your AYA
              </button>
              <p id="preview-left" className="text-muted mt-2 text-sm">
                Opens when every stage above is done. Still to come:{" "}
                {joinWords(tracker.left.map((l) => l.toLowerCase()))}. In the preview nothing
                reaches {audience}, and nothing is booked.
              </p>
            </div>
          </section>

          <section aria-labelledby="channels-heading" className="mt-10">
            <h2 id="channels-heading" className="text-lg font-semibold">
              Your channels
            </h2>
            <ul className="mt-3 grid gap-2">
              {state.channels.map((c) => (
                <li key={c.channel} className="rounded-xl border border-line bg-white px-4 py-3">
                  <p className="flex items-center justify-between gap-3">
                    <span className="font-semibold">{CHANNEL_NAMES[c.channel]}</span>
                    <span className="bg-paper-2 shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold">
                      {channelStatusWord(c.status)}
                    </span>
                  </p>
                  <p className="text-muted mt-1 text-sm">
                    {setupSentence(c.channel, channelNextStep(c, finished))}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          {plan && state.billing ? (
            <section aria-labelledby="plan-heading" className="mt-10">
              <h2 id="plan-heading" className="text-lg font-semibold">
                Your plan
              </h2>
              <p className="text-muted mt-2">
                {plan.name}. {planStartSentence(plan, state.billing.interval, one)}
              </p>
              {state.billing.setupDeadlineAt && !state.billing.planStartedAt ? (
                <p className="text-muted mt-2 text-sm">
                  Setup stays available until{" "}
                  {formatReplyBy(
                    setupLastDay(state.billing.setupDeadlineAt, state.clinic.timezone),
                  )}
                  . If nothing is answering {audience} by the end of that day, the account closes.
                </p>
              ) : null}
            </section>
          ) : null}
        </>
      )}

      <HelpPanel audience={audience} />
    </main>
  );
}
