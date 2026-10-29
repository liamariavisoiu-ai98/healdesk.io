import {
  audienceSingular,
  CHANNEL_NAMES,
  getPlan,
  planStartSentence,
} from "@healdesk/catalog";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getBillingSummary } from "@/lib/billing/summary";
import { setupLastDay } from "@/lib/clinic/setup-window";
import { getCalendarConnection } from "@/lib/connections/google-calendar";
import { readMetaConnectView } from "@/lib/meta/reconnect";
import { requirePortal } from "@/lib/portal/access";
import { needsAttention } from "@/lib/portal/attention";
import { readLaterLocations } from "@/lib/portal/location-details";
import { portalDay } from "@/lib/portal/format";
import {
  HOME_WEEK_DAYS,
  readHomeFacts,
  readHomePatientRequests,
} from "@/lib/portal/home";
import { needItems, weekHeadline } from "@/lib/portal/home-summary";
import { isBuiltSection, sectionPath } from "@/lib/portal/nav";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { claimLines } from "@/lib/reporting/claim-words";
import { claimsPayload } from "@/lib/reporting/claims";
import {
  channelPresentation,
  metaNeedsReconnect,
} from "@/lib/setup/channel-status";
import { channelSetupFinished } from "@/lib/setup/screens";
import { buildTracker, joinWords } from "@/lib/setup/tracker";
import { withTenant } from "@/lib/tenant";

import { AnswerAttentionCard } from "./AnswerAttentionCard";
import { ChannelPill } from "./ChannelStatus";
import { HomeUnavailable, NeedsYou, WhatAyaDid } from "./HomeSections";
import { PatientRequestsCard } from "./PatientRequestsCard";
import { PortalShell } from "./PortalShell";

export const metadata: Metadata = {
  title: "Home · healdesk",
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * Home (plan Part F1; spec, "Home: what happened, and is everything
 * working"). Before go-live: what needs the clinic, the build tracker and
 * Talk to your AYA (locked until every stage is done, naming what is left),
 * each channel's status in words, never an opening date (channelStatusLabel,
 * the wizard's: once live, since when, and a pause until when), and when the
 * plan starts.
 *
 * After go-live: first the "Waiting for you" card, counts only, one tap into
 * Bookings (lib/portal/waiting-words.ts); then Needs attention, which adds a
 * channel gone quiet; then this week's numbers from the claims function, the
 * one the daily summary and the weekly recap share (lib/reporting/claims.ts,
 * claim-words.ts); then the channels and the plan. Nothing here shows a
 * patient, never a name, a time or a service, so no step-up.
 *
 * Before and after go-live, and on a closed account, first of all: each
 * patient's request passed to the practice that nobody has marked received
 * (L32), with its day and one tap to its page, behind the step-up.
 */
export default async function ClinicHome({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const portal = await requirePortal(slug);
  const now = new Date();
  const page = await loadPortalPage(portal, now);
  if (!page) notFound();
  const { state } = page;
  const shell = shellProps(portal, page, "home");

  if (state.clinic.offboardingStartedAt) {
    const requests = await readHomePatientRequests({
      clinicId: portal.clinicId,
      actor: page.actorContext,
    });
    return (
      <PortalShell {...shell}>
        <h1 className="text-2xl font-semibold">Home</h1>
        <PatientRequestsCard
          slug={portal.clinicSlug}
          requests={requests}
          audience={shell.audience}
          timeZone={shell.timeZone}
          now={now}
        />
        <p className="border-line mt-6 rounded-xl border bg-white px-4 py-3">
          This account has closed.
        </p>
      </PortalShell>
    );
  }

  let facts: Awaited<ReturnType<typeof readHomeFacts>>;
  try {
    facts = await readHomeFacts({
      clinicId: portal.clinicId,
      address: state.address,
      actor: page.actorContext,
      channels: state.channels,
      now,
    });
  } catch {
    return (
      <PortalShell {...shell}>
        <h1 className="text-2xl font-semibold">Home</h1>
        <HomeUnavailable />
      </PortalShell>
    );
  }
  const calendar = await getCalendarConnection(portal.clinicId, {
    actor: page.actorContext,
  });
  const live = shell.status.kind !== "not_yet";
  const meta = state.channels.some((c) => c.channel === "meta")
    ? await withTenant(
        { clinicId: portal.clinicId, actor: page.actorContext },
        (tx) => readMetaConnectView(tx.db, tx.clinicId),
      )
    : null;
  const locationsToConfirm = (
    await withTenant(
      { clinicId: portal.clinicId, actor: page.actorContext },
      (tx) => readLaterLocations(tx),
    )
  ).filter((l) => !l.confirmed);
  const attention = needsAttention({
    slug: portal.clinicSlug,
    state,
    ...facts,
    live,
    calendar,
    meta,
    locationsToConfirm,
  });
  const bookingsHref = isBuiltSection("bookings")
    ? sectionPath(portal.clinicSlug, "bookings")
    : null;
  const conversationsHref = isBuiltSection("conversations")
    ? sectionPath(portal.clinicSlug, "conversations")
    : null;
  const needs = needItems({
    waiting: live ? facts.waiting : null,
    endedEarly: live ? facts.endedEarly : 0,
    attention,
    bookingsHref,
    conversationsHref,
    now,
    weekDays: HOME_WEEK_DAYS,
  });
  const week = facts.week ? claimLines(claimsPayload(facts.week)) : [];
  const tracker = buildTracker(
    state,
    calendar,
    facts.practice,
    facts.goLive ?? undefined,
  );
  const finished = channelSetupFinished(state.screens, state.progress);
  const plan = state.billing ? getPlan(state.billing.boughtPlanId) : undefined;
  const one = audienceSingular(shell.audience);
  const started = state.billing?.planStartedAt ?? null;
  const summary = started
    ? await getBillingSummary(portal.clinicId, { now })
    : null;

  return (
    <PortalShell {...shell}>
      <h1 className="text-2xl font-semibold">Home</h1>

      <AnswerAttentionCard slug={portal.clinicSlug} attention={facts.answering} />

      <PatientRequestsCard
        slug={portal.clinicSlug}
        requests={facts.patientRequests}
        audience={shell.audience}
        timeZone={shell.timeZone}
        now={now}
      />

      <NeedsYou items={needs} answering={shell.status.kind === "answering"} />

      {live ? null : (
        <section
          id="tracker"
          aria-labelledby="tracker-heading"
          className="mt-10 scroll-mt-6"
        >
          <h2 id="tracker-heading" className="text-lg font-semibold">
            Building your AYA
          </h2>
          <ol className="mt-3 grid gap-2">
            {tracker.stages.map((stage) => (
              <li
                key={stage.id}
                className="border-line rounded-xl border bg-white px-4 py-3"
              >
                <p className="flex items-center justify-between gap-3 font-semibold">
                  <span>{stage.label}</span>
                  <span
                    className={
                      stage.state === "done"
                        ? "text-green text-sm"
                        : "text-muted text-sm"
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
          <div className="border-line mt-4 rounded-xl border bg-white px-4 py-4">
            {/* Talk to your AYA, the preview (/c/[slug]/preview). Until every
                blocking stage is done the button stays locked and names what
                is left; once they are, it is a link to the preview, which
                checks the same tracker again itself. */}
            {tracker.previewUnlocked ? (
              <a
                href={`/c/${portal.clinicSlug}/preview`}
                aria-describedby="preview-left"
                className="bg-ink inline-flex min-h-11 items-center rounded-full px-6 py-3 text-sm font-bold text-white"
              >
                Talk to your AYA
              </a>
            ) : (
              <button
                type="button"
                disabled
                aria-describedby="preview-left"
                className="bg-ink min-h-11 rounded-full px-6 py-3 text-sm font-bold text-white opacity-50"
              >
                Talk to your AYA
              </button>
            )}
            <p id="preview-left" className="text-muted mt-2 text-sm">
              {tracker.previewUnlocked ? (
                <>
                  Every stage above is done: talk to her before anyone else
                  does.
                </>
              ) : (
                <>
                  Opens when every stage above is done. Still to come:{" "}
                  {joinWords(tracker.left.map((l) => l.toLowerCase()))}.
                </>
              )}{" "}
              In the preview nothing reaches {shell.audience}, and nothing is
              booked.
            </p>
          </div>
        </section>
      )}

      {live && facts.week ? (
        <WhatAyaDid
          headline={weekHeadline(claimsPayload(facts.week))}
          lines={week}
        />
      ) : null}

      <section aria-labelledby="channels-heading" className="mt-10">
        <h2 id="channels-heading" className="text-lg font-semibold">
          Your channels
        </h2>
        <ul className="mt-3 grid gap-2">
          {state.channels.map((c) => {
            const presentation = channelPresentation(c, {
              setupFinished: finished,
              timeZone: state.clinic.timezone,
              now,
              needsReconnect: c.channel === "meta" && metaNeedsReconnect(meta),
            });
            return (
              <li
                key={c.channel}
                className="border-line rounded-xl border bg-white px-4 py-3"
              >
                <p className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    {CHANNEL_NAMES[c.channel]}
                  </span>
                  {/* The same pill and sentence as Settings and the wizard; it wraps rather than overflows. */}
                  <span>
                    <ChannelPill presentation={presentation} />
                  </span>
                </p>
                <p className="text-muted mt-1 text-sm">{presentation.detail}</p>
              </li>
            );
          })}
        </ul>
        {isBuiltSection("settings") ? (
          <p className="text-muted mt-3 text-sm">
            Switch a channel on or off in{" "}
            <a
              href={`${sectionPath(portal.clinicSlug, "settings")}#channels`}
              className="font-semibold underline"
            >
              Settings
            </a>
            .
          </p>
        ) : null}
      </section>

      {plan && state.billing ? (
        <section aria-labelledby="plan-heading" className="mt-10">
          <h2 id="plan-heading" className="text-lg font-semibold">
            Your plan
          </h2>
          {started && summary ? (
            <p className="text-muted mt-2">
              {plan.name}. Your plan started on{" "}
              {portalDay(started, state.clinic.timezone, now)}, when AYA first
              answered
              {summary.firstPeriodEndsAt
                ? `; your first ${state.billing.interval === "year" ? "year" : "month"} runs to ${portalDay(
                    new Date(new Date(summary.firstPeriodEndsAt).getTime() - 1),
                    state.clinic.timezone,
                    now,
                  )}`
                : ""}
              .
            </p>
          ) : (
            <p className="text-muted mt-2">
              {plan.name}.{" "}
              {planStartSentence(plan, state.billing.interval, one)}
            </p>
          )}
          {state.billing.setupDeadlineAt && !started ? (
            <p className="text-muted mt-2 text-sm">
              Setup stays available until{" "}
              {portalDay(
                setupLastDay(
                  state.billing.setupDeadlineAt,
                  state.clinic.timezone,
                ),
                state.clinic.timezone,
                now,
              )}
              . If nothing is answering {shell.audience} by the end of that day,
              the account closes.
            </p>
          ) : null}
          {isBuiltSection("billing") ? (
            <p className="mt-3 text-sm">
              <a
                href={sectionPath(portal.clinicSlug, "billing")}
                className="font-semibold underline"
              >
                See Billing
              </a>
            </p>
          ) : null}
        </section>
      ) : null}
    </PortalShell>
  );
}
