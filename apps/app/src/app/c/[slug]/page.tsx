import { audienceSingular, CHANNEL_NAMES, getPlan, planStartSentence } from "@healdesk/catalog";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getBillingSummary } from "@/lib/billing/summary";
import { setupLastDay } from "@/lib/clinic/setup-window";
import { getCalendarConnection } from "@/lib/connections/google-calendar";
import { readMetaConnectView } from "@/lib/meta/reconnect";
import { requirePortal } from "@/lib/portal/access";
import { needsAttention } from "@/lib/portal/attention";
import { portalDay } from "@/lib/portal/format";
import { readHomeFacts } from "@/lib/portal/home";
import { isBuiltSection, sectionPath } from "@/lib/portal/nav";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { channelNextStep, channelStatusWord, setupSentence } from "@/lib/setup/channels";
import { wizardFinished } from "@/lib/setup/screens";
import { buildTracker, joinWords } from "@/lib/setup/tracker";
import { withTenant } from "@/lib/tenant";

import { PortalShell } from "./PortalShell";

export const metadata: Metadata = { title: "Home · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * Home (plan Part F1; spec, "Home: what happened, and is everything
 * working"). Before go-live: what needs the clinic, the build tracker and
 * Talk to your AYA (locked until every stage is done, naming what is left),
 * each channel's status in words with no dates, and when the plan starts.
 *
 * After go-live M5 and M6 add the "Waiting for you" card and the week's three
 * numbers from the claims function; until then Home shows the channels and
 * the plan as they stand. Nothing here shows a patient, so no step-up.
 */
export default async function ClinicHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const portal = await requirePortal(slug);
  const now = new Date();
  const page = await loadPortalPage(portal, now);
  if (!page) notFound();
  const { state } = page;
  const shell = shellProps(portal, page, "home");

  if (state.clinic.offboardingStartedAt) {
    return (
      <PortalShell {...shell}>
        <h1 className="text-2xl font-semibold">Home</h1>
        <p className="border-line mt-6 rounded-xl border bg-white px-4 py-3">
          This account has closed.
        </p>
      </PortalShell>
    );
  }

  const facts = await readHomeFacts({
    clinicId: portal.clinicId,
    address: state.address,
    actor: page.actorContext,
  });
  const calendar = await getCalendarConnection(portal.clinicId, { actor: page.actorContext });
  const live = shell.status.kind !== "not_yet";
  const meta = state.channels.some((c) => c.channel === "meta")
    ? await withTenant({ clinicId: portal.clinicId, actor: page.actorContext }, (tx) =>
        readMetaConnectView(tx.db, tx.clinicId),
      )
    : null;
  const attention = needsAttention({ slug: portal.clinicSlug, state, ...facts, live, calendar, meta });
  const tracker = buildTracker(state, calendar, facts.practice);
  const finished = wizardFinished(state.screens, state.progress);
  const plan = state.billing ? getPlan(state.billing.boughtPlanId) : undefined;
  const one = audienceSingular(shell.audience);
  const started = state.billing?.planStartedAt ?? null;
  const summary = started ? await getBillingSummary(portal.clinicId, { now }) : null;

  return (
    <PortalShell {...shell}>
      <h1 className="text-2xl font-semibold">Home</h1>

      {attention.length > 0 ? (
        <section aria-labelledby="attention-heading" className="mt-6">
          <h2 id="attention-heading" className="text-lg font-semibold">
            Needs attention
          </h2>
          <ul className="mt-3 grid gap-2">
            {attention.map((item) => (
              <li
                key={item.id}
                className="border-line flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white px-4 py-3"
              >
                <span>{item.text}</span>
                <a
                  href={item.action.href}
                  className="bg-ink inline-flex min-h-11 items-center rounded-full px-5 text-sm font-bold text-white"
                >
                  {item.action.label}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {live ? null : (
        <section id="tracker" aria-labelledby="tracker-heading" className="mt-10 scroll-mt-6">
          <h2 id="tracker-heading" className="text-lg font-semibold">
            Building your AYA
          </h2>
          <ol className="mt-3 grid gap-2">
            {tracker.stages.map((stage) => (
              <li key={stage.id} className="border-line rounded-xl border bg-white px-4 py-3">
                <p className="flex items-center justify-between gap-3 font-semibold">
                  <span>{stage.label}</span>
                  <span
                    className={stage.state === "done" ? "text-green text-sm" : "text-muted text-sm"}
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
                <>Every stage above is done: talk to her before anyone else does.</>
              ) : (
                <>
                  Opens when every stage above is done. Still to come:{" "}
                  {joinWords(tracker.left.map((l) => l.toLowerCase()))}.
                </>
              )}{" "}
              In the preview nothing reaches {shell.audience}, and nothing is booked.
            </p>
          </div>
        </section>
      )}

      <section aria-labelledby="channels-heading" className="mt-10">
        <h2 id="channels-heading" className="text-lg font-semibold">
          Your channels
        </h2>
        <ul className="mt-3 grid gap-2">
          {state.channels.map((c) => (
            <li key={c.channel} className="border-line rounded-xl border bg-white px-4 py-3">
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
              {plan.name}. Your plan started on {portalDay(started, state.clinic.timezone, now)},
              when AYA first answered
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
              {plan.name}. {planStartSentence(plan, state.billing.interval, one)}
            </p>
          )}
          {state.billing.setupDeadlineAt && !started ? (
            <p className="text-muted mt-2 text-sm">
              Setup stays available until{" "}
              {portalDay(
                setupLastDay(state.billing.setupDeadlineAt, state.clinic.timezone),
                state.clinic.timezone,
                now,
              )}
              . If nothing is answering {shell.audience} by the end of that day, the account closes.
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
