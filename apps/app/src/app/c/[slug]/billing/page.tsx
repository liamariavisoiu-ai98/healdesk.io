import {
  additionalLocationChargeUsd,
  annualTotalUsd,
  audienceSingular,
  CHANNEL_NAMES,
  channelList,
  getPlan,
  planStartSentence,
  plans,
  type BillingInterval,
} from "@healdesk/catalog";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { setupLastDay } from "@/lib/clinic/setup-window";
import { LOCATION_CLINICS_READY } from "@/lib/location-clinic";
import { readBillingView } from "@/lib/portal/billing";
import { portalCount, portalDay, portalMoney } from "@/lib/portal/format";
import { requirePortal } from "@/lib/portal/access";
import { sectionPath } from "@/lib/portal/nav";
import { loadPortalPage, shellProps } from "@/lib/portal/page";

import { FeedbackProvider } from "../feedback";
import { PortalShell } from "../PortalShell";

import {
  AddLocation,
  AllowanceChoice,
  BillingSwitch,
  ChangePlan,
  StripePortalButton,
  type PlanOption,
} from "./BillingControls";

export const metadata: Metadata = { title: "Billing · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * Billing (plan Part F6; spec, "Billing"): the plan, its channels and
 * locations; when it starts, or the next charge once it has; the price while
 * not every channel is in service; the usage meters; the three switches
 * together (when the allowance runs out, usage alerts, auto-renew); changing
 * the plan, with the setup-fee difference first; adding a location; Stripe's
 * own portal for the card and the invoices; and the agreement on file.
 *
 * Every amount is the billing summary's or Stripe's own preview
 * (lib/portal/billing.ts), and every change is Package C's action. Nothing on
 * this page is about a patient: opening it needs no step-up, and the changes
 * that move money ask for one when they are made.
 */
export default async function BillingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const portal = await requirePortal(slug);
  const now = new Date();
  const page = await loadPortalPage(portal, now);
  if (!page) notFound();
  const shell = shellProps(portal, page, "billing");
  const { clinic } = page.state;
  const view = await readBillingView({ clinicId: portal.clinicId, actor: page.actorContext, now });
  const { summary } = view;
  const tz = clinic.timezone;

  if (!summary) {
    return (
      <PortalShell {...shell}>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="border-line mt-6 rounded-xl border bg-white px-4 py-3">
          There&rsquo;s no billing account on this clinic. If that&rsquo;s unexpected, email
          hello@healdesk.io.
        </p>
      </PortalShell>
    );
  }

  const bought = summary.boughtPlanId ? getPlan(summary.boughtPlanId) : undefined;
  const one = audienceSingular(shell.audience);
  const ended = summary.status === "canceled" || summary.status === "purged";
  const setupLast =
    summary.setupDeadlineAt && !summary.isPlanStarted
      ? portalDay(setupLastDay(new Date(summary.setupDeadlineAt), tz), tz, now)
      : null;

  const priceOf = (planId: string, interval: BillingInterval) => {
    const plan = getPlan(planId)!;
    return interval === "year"
      ? `${portalMoney(annualTotalUsd(plan) * 100)} a year`
      : `${portalMoney(plan.monthlyUsd * 100)} a month`;
  };
  const plansByInterval = Object.fromEntries(
    (["month", "year"] as const).map((interval) => [
      interval,
      plans.map((plan): PlanOption => ({
        id: plan.id,
        name: plan.name,
        price: priceOf(plan.id, interval),
        current: plan.id === summary.boughtPlanId && interval === summary.interval,
        pending: view.pendingChange?.planId === plan.id && view.pendingChange.interval === interval,
      })),
    ]),
  ) as Record<"month" | "year", PlanOption[]>;
  const location = bought ? additionalLocationChargeUsd(bought, summary.interval) : null;

  return (
    <PortalShell {...shell}>
      <h1 className="text-2xl font-semibold">Billing</h1>
      <FeedbackProvider>
        <div className="mt-6 grid gap-6">
          {/* The plan */}
          <section
            id="plan"
            aria-labelledby="plan-heading"
            className="border-line scroll-mt-6 rounded-2xl border bg-white px-4 py-4 sm:px-5"
          >
            <h2 id="plan-heading" className="text-lg font-semibold">
              Your plan
            </h2>
            {bought ? (
              <>
                <p className="mt-2 font-semibold">
                  {bought.name}, billed {summary.interval === "year" ? "annually" : "monthly"}
                </p>
                <p className="text-muted mt-1 text-sm">
                  {channelList(bought)
                    .map((c) => CHANNEL_NAMES[c])
                    .join(" · ")}
                  {" · "}
                  {summary.locations === 1 ? "one location" : `${summary.locations} locations`}
                </p>
              </>
            ) : null}

            {ended ? (
              <p className="mt-3">This plan has ended.</p>
            ) : summary.isPlanStarted ? (
              <div className="mt-3 grid gap-1 text-sm">
                {summary.planStartedAt ? (
                  <p>Your plan started on {portalDay(new Date(summary.planStartedAt), tz, now)}.</p>
                ) : null}
                {view.nextInvoice?.status === "ok" ? (
                  <p>
                    Next charge: {portalMoney(view.nextInvoice.amountDueCents)}
                    {view.nextInvoice.nextPaymentOn
                      ? ` on ${portalDay(view.nextInvoice.nextPaymentOn, tz, now)}`
                      : ""}
                    .
                  </p>
                ) : view.nextInvoice ? (
                  <p className="text-muted">{view.nextInvoice.message}</p>
                ) : null}
                {view.billedUntil ? (
                  <p>
                    Billed at the {view.billedUntil.billedPlanName} price until{" "}
                    {view.billedUntil.waiting.join(" and ")}{" "}
                    {view.billedUntil.waiting.length === 1 ? "is" : "are"} in service. The full{" "}
                    {view.billedUntil.boughtPlanName} price applies from the day{" "}
                    {view.billedUntil.waiting.length === 1 ? "it" : "each"} first answers.
                  </p>
                ) : null}
              </div>
            ) : bought ? (
              <div className="mt-3 grid gap-1 text-sm">
                <p>{planStartSentence(bought, summary.interval, one)}</p>
                {channelList(bought).length > 1 ? (
                  <p>
                    Until every channel in your package is in service, your monthly price is the
                    price of the channels that are.
                  </p>
                ) : null}
                {setupLast ? (
                  <p className="text-muted">
                    Setup stays available until {setupLast}. If nothing is answering{" "}
                    {shell.audience} by the end of that day, the account closes.
                  </p>
                ) : null}
              </div>
            ) : null}

            {summary.openInvoice ? (
              <p className="mt-3 rounded-xl border border-red-200 px-4 py-3 text-sm text-red-800">
                A payment didn&rsquo;t go through
                {summary.openInvoice.amountDueCents
                  ? `: ${portalMoney(summary.openInvoice.amountDueCents)} is due`
                  : ""}
                .{" "}
                {summary.openInvoice.url ? (
                  <a
                    href={summary.openInvoice.url}
                    className="font-semibold underline"
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    Pay it on Stripe
                  </a>
                ) : null}
              </p>
            ) : null}
          </section>

          {/* Usage */}
          <section
            id="usage"
            aria-labelledby="usage-heading"
            className="border-line scroll-mt-6 rounded-2xl border bg-white px-4 py-4 sm:px-5"
          >
            <h2 id="usage-heading" className="text-lg font-semibold">
              Usage
            </h2>
            {summary.usage.length === 0 ? (
              <p className="text-muted mt-2 text-sm">Nothing to measure on this plan.</p>
            ) : (
              <ul className="mt-2 grid gap-3">
                {summary.usage.map((meter) => {
                  const words =
                    meter.meter === "voice_minutes"
                      ? (["voice minute", "voice minutes"] as const)
                      : (["chat conversation", "chat conversations"] as const);
                  const daysLeft =
                    meter.isWindowOpen && meter.windowEnd
                      ? Math.max(
                          0,
                          Math.ceil(
                            (new Date(meter.windowEnd).getTime() - now.getTime()) / 86_400_000,
                          ),
                        )
                      : null;
                  return (
                    <li key={meter.meter} className="text-sm">
                      <p className="font-semibold">
                        {portalCount(meter.used, words[0], words[1])} used of{" "}
                        {meter.included.toLocaleString("en-US")} included
                      </p>
                      <p className="text-muted">
                        {meter.isWindowOpen
                          ? `${meter.overUnits > 0 ? `${portalCount(meter.overUnits, words[0], words[1])} over: ${portalMoney(meter.overageCents)} so far. ` : "No overage. "}${daysLeft === 1 ? "1 day left" : `${daysLeft} days left`} in this month's allowance.`
                          : "Your allowance starts when your plan does."}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* The three switches */}
          {ended ? null : (
            <section
              id="switches"
              aria-labelledby="switches-heading"
              className="border-line scroll-mt-6 rounded-2xl border bg-white px-4 py-4 sm:px-5"
            >
              <h2 id="switches-heading" className="text-lg font-semibold">
                Allowance, alerts and renewal
              </h2>
              <p className="text-muted mt-1 text-sm">
                Each needs Face ID or your screen lock on a device you&rsquo;ve added.
              </p>
              <div className="divide-line mt-2 divide-y">
                <AllowanceChoice slug={portal.clinicSlug} initial={summary.overageMode} />
                <BillingSwitch
                  slug={portal.clinicSlug}
                  settingKey="usage_alerts"
                  label="Usage alerts"
                  line="Emails at 80% and 100% of the allowance."
                  initial={summary.usageAlertsEnabled}
                />
                <BillingSwitch
                  slug={portal.clinicSlug}
                  settingKey="auto_renew"
                  label="Auto-renew"
                  line={
                    summary.isPlanStarted
                      ? "Off cancels at the end of the period you've paid for, and can be turned back on until then."
                      : "Off means your plan won't start, and nothing more is charged."
                  }
                  offLine={
                    summary.closesOn
                      ? summary.isPlanStarted
                        ? `Your plan ends on ${portalDay(new Date(summary.closesOn), tz, now)}. Turn it back on any time before then.`
                        : `Your plan won't start, and nothing more is charged. Turn it back on any time before ${portalDay(new Date(summary.closesOn), tz, now)}.`
                      : undefined
                  }
                  initial={summary.isAutoRenewOn}
                />
              </div>
            </section>
          )}

          {/* Change plan, locations */}
          {ended || !bought ? null : (
            <section
              id="change"
              aria-labelledby="change-heading"
              className="border-line scroll-mt-6 rounded-2xl border bg-white px-4 py-4 sm:px-5"
            >
              <h2 id="change-heading" className="text-lg font-semibold">
                Change your plan
              </h2>
              <p className="text-muted mt-1 text-sm">
                Pick a plan to see what it costs before anything is charged. A bigger package pays
                the difference in setup fee first.
              </p>
              <ChangePlan
                slug={portal.clinicSlug}
                interval={summary.interval}
                isStarted={summary.isPlanStarted}
                plansByInterval={plansByInterval}
              />
              <div className="border-line mt-2 border-t pt-3">
                <h3 className="font-semibold">Add a location</h3>
                {location ? (
                  <p className="text-muted mt-1 text-sm">
                    Each extra location is {portalMoney(location.recurringUsd * 100)}{" "}
                    {summary.interval === "year" ? "a year" : "a month"} plus a{" "}
                    {portalMoney(location.setupFeeUsd * 100)} setup fee, with the allowances pooled.
                  </p>
                ) : null}
                {LOCATION_CLINICS_READY ? (
                  <AddLocation slug={portal.clinicSlug} interval={summary.interval} />
                ) : (
                  <p className="mt-2 text-sm">
                    To add one, email{" "}
                    <a href="mailto:hello@healdesk.io" className="font-semibold underline">
                      hello@healdesk.io
                    </a>{" "}
                    and we&rsquo;ll set it up with you.
                  </p>
                )}
              </div>
            </section>
          )}

          {/* Stripe's portal */}
          <section
            id="payment-method"
            aria-labelledby="payment-heading"
            className="border-line scroll-mt-6 rounded-2xl border bg-white px-4 py-4 sm:px-5"
          >
            <h2 id="payment-heading" className="text-lg font-semibold">
              Card and invoices
            </h2>
            <p className="text-muted mt-1 text-sm">
              Your card and past invoices are kept by Stripe, our payment processor. Cancelling is
              Auto-renew above, not Stripe.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <StripePortalButton
                slug={portal.clinicSlug}
                flow="payment_method_update"
                label="Change the card"
              />
              <StripePortalButton slug={portal.clinicSlug} flow={null} label="See invoices" />
            </div>
          </section>

          {/* The agreement */}
          <section
            id="agreement"
            aria-labelledby="agreement-heading"
            className="border-line scroll-mt-6 rounded-2xl border bg-white px-4 py-4 sm:px-5"
          >
            <h2 id="agreement-heading" className="text-lg font-semibold">
              Your agreement
            </h2>
            {view.agreement ? (
              <>
                <p className="mt-2 text-sm">
                  {view.agreement.kind === "dpa"
                    ? "Data protection agreement"
                    : "Business associate agreement"}
                  , version {view.agreement.version}, signed by {view.agreement.signatory} on{" "}
                  {portalDay(view.agreement.acceptedAt, tz, now)}.
                </p>
                <p className="text-muted mt-1 text-sm">
                  Notices under it go to {page.state.address ?? "your practice's address"}, the
                  address you sign in with.{" "}
                  <a
                    href={`${sectionPath(portal.clinicSlug, "settings")}#sign-in`}
                    className="text-ink font-semibold underline"
                  >
                    See it in Settings
                  </a>
                </p>
                <a
                  href={`/c/${portal.clinicSlug}/billing/agreement`}
                  className="border-line mt-3 inline-flex min-h-11 items-center rounded-full border px-5 text-sm font-semibold"
                >
                  Download it (PDF)
                </a>
                {view.agreement.kind === "dpa" ? (
                  <p className="text-muted mt-3 text-sm">
                    If your practice starts billing any health insurance electronically, email{" "}
                    <a href="mailto:hello@healdesk.io" className="text-ink font-semibold underline">
                      hello@healdesk.io
                    </a>
                    : your agreement becomes a business associate agreement, and we send it to you
                    to sign.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-muted mt-2 text-sm">
                We&rsquo;re attaching your signed agreement. Email hello@healdesk.io if you need a
                copy now.
              </p>
            )}
          </section>
        </div>
      </FeedbackProvider>
    </PortalShell>
  );
}
