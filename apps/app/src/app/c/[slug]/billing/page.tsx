import {
  additionalLocationChargeUsd,
  asksCoveredQuestion,
  audienceSingular,
  CHANNEL_NAMES,
  channelList,
  CURRENT_BAA_VERSION,
  getPlan,
  isSpecialtyId,
  planStartSentence,
  USAGE_ALERT_PERCENT,
} from "@healdesk/catalog";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readOpenResign } from "@/lib/agreements/resign";
import { setupLastDay } from "@/lib/clinic/setup-window";
import { LOCATION_CLINICS_READY } from "@/lib/location-clinic";
import { backupsExpireOn, type AfterCancellation } from "@/lib/offboarding/after-cancellation";
import {
  extraBlockLine,
  includedLine,
  meterWords,
  pastAlertMark,
  readBillingView,
} from "@/lib/portal/billing";
import { portalCount, portalDay, portalMoney } from "@/lib/portal/format";
import { requirePortal } from "@/lib/portal/access";
import { sectionPath } from "@/lib/portal/nav";
import { loadPortalPage, shellProps } from "@/lib/portal/page";

import { FeedbackProvider } from "../feedback";
import { PortalShell } from "../PortalShell";

import {
  AddLocation,
  AgreementResignButton,
  AllowanceChoice,
  BillingSwitch,
  ChangePlan,
  StripePortalButton,
} from "./BillingControls";

export const metadata: Metadata = { title: "Billing · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * Billing (plan Part F6; spec, "Billing"): the plan, its channels, locations
 * and steps (what it includes each month); when it starts, or the next charge
 * once it has; the price while not every channel is in service; the usage
 * meters against what is included, with the extra-100 price of each, marked
 * provisional; the three switches together (when the allowance runs out,
 * usage alerts, auto-renew); changing the plan, a package and its steps, with
 * the setup-fee difference first; adding a location; Stripe's own portal for
 * the card and the invoices; and the agreement on file.
 *
 * Since the pricing sheet of 13 October 2026 a plan is a package at a usage
 * step per product (100 to 1,500 voice minutes, chat conversations), so the
 * plan section names the package and says the steps, and the usage section
 * says, past the alert mark (USAGE_ALERT_PERCENT, 90%), what the alert email
 * says: move up a step, which costs less than extra blocks, or let them bill.
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
  const resign = view.agreement ? await readOpenResign(portal.clinicId, page.actorContext) : null;
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
  // Read-only once the service has ended, however it ended: nothing left to
  // switch or change, the export's deadline and the data's dates instead.
  const ended =
    summary.status === "canceled" ||
    summary.status === "purged" ||
    view.afterCancellation !== null;
  const setupLast =
    summary.setupDeadlineAt && !summary.isPlanStarted
      ? portalDay(setupLastDay(new Date(summary.setupDeadlineAt), tz), tz, now)
      : null;

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
                  {bought.packageName}, billed {summary.interval === "year" ? "annually" : "monthly"}
                </p>
                <p className="text-muted mt-1 text-sm">
                  {channelList(bought)
                    .map((c) => CHANNEL_NAMES[c])
                    .join(" · ")}
                  {" · "}
                  {summary.locations === 1 ? "one location" : `${summary.locations} locations`}
                </p>
                <p className="mt-1 text-sm">
                  Includes {includedLine(bought, summary.locations)} a month
                  {summary.locations > 1 ? ", pooled across your locations" : ""}.
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

          {/* After cancellation: the export and the data */}
          {view.afterCancellation ? (
            <section
              id="your-data"
              aria-labelledby="your-data-heading"
              className="border-line scroll-mt-6 rounded-2xl border bg-white px-4 py-4 sm:px-5"
            >
              <h2 id="your-data-heading" className="text-lg font-semibold">
                Your export and your data
              </h2>
              <AfterCancellationLines
                slug={portal.clinicSlug}
                state={view.afterCancellation}
                timeZone={tz}
                now={now}
              />
            </section>
          ) : null}

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
              <>
                <ul className="mt-2 grid gap-4">
                  {summary.usage.map((meter) => {
                    const [one, many] = meterWords(meter.meter);
                    const daysLeft =
                      meter.isWindowOpen && meter.windowEnd
                        ? Math.max(
                            0,
                            Math.ceil(
                              (new Date(meter.windowEnd).getTime() - now.getTime()) / 86_400_000,
                            ),
                          )
                        : null;
                    const percent =
                      meter.included > 0 ? Math.floor((meter.used * 100) / meter.included) : 0;
                    const extra = bought ? extraBlockLine(bought, meter.meter) : null;
                    return (
                      <li key={meter.meter} className="text-sm">
                        <p className="font-semibold">
                          {portalCount(meter.used, one, many)} used of{" "}
                          {meter.included.toLocaleString("en-US")} included
                          {meter.included > 0 ? ` (${percent}%)` : ""}
                        </p>
                        {meter.included > 0 ? (
                          // A native meter, coloured by the browser past the
                          // alert mark: the portal carries no inline styles.
                          <meter
                            aria-hidden="true"
                            min={0}
                            max={100}
                            low={USAGE_ALERT_PERCENT}
                            high={USAGE_ALERT_PERCENT}
                            optimum={0}
                            value={Math.min(100, percent)}
                            className="mt-1 h-2 w-full"
                          />
                        ) : null}
                        <p className="text-muted mt-1">
                          {meter.isWindowOpen
                            ? `${meter.overUnits > 0 ? `${portalCount(meter.overUnits, one, many)} over: ${portalMoney(meter.overageCents)} so far. ` : "No overage. "}${daysLeft === 1 ? "1 day left" : `${daysLeft} days left`} in this month's allowance.`
                            : "Your allowance starts when your plan does."}
                        </p>
                        {extra ? <p className="text-muted">Past it: {extra} (provisional).</p> : null}
                        {meter.isWindowOpen && pastAlertMark(meter) && !ended ? (
                          <p className="mt-1">
                            You&rsquo;re past {USAGE_ALERT_PERCENT}% of this month&rsquo;s allowance.{" "}
                            {summary.overageMode === "allow"
                              ? "Moving up a step costs less than extra blocks; or do nothing, and each started block of 100 bills at the price above."
                              : "When it's used, AYA falls back to your team until it renews; moving up a step gives her more."}{" "}
                            <a href="#change" className="font-semibold underline">
                              Change your plan
                            </a>
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <p className="text-muted mt-3 text-sm">
                  Extra blocks are billed only while &ldquo;Keep going and bill the extra&rdquo; is
                  chosen below. Their prices are provisional until we&rsquo;ve measured what each
                  minute and conversation costs us.
                </p>
              </>
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
                  line={`Emails at ${USAGE_ALERT_PERCENT}% and 100% of the allowance, with the choice to move up a step.`}
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
                Choose a package and how much it includes each month, in steps of 100. Moving
                between steps of your package has no setup fee; a bigger package pays the
                difference in setup fee first. You see what it costs before anything is charged.
              </p>
              <ChangePlan
                slug={portal.clinicSlug}
                isStarted={summary.isPlanStarted}
                current={{ planId: bought.id, interval: summary.interval }}
                pending={view.pendingChange}
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
                {view.agreement.kind === "baa" && resign?.reason === "baa_version" ? (
                  <div className="mt-3 text-sm">
                    <p className="font-semibold">Your updated agreement is waiting to be signed.</p>
                    <p className="text-muted mt-1">
                      Version {CURRENT_BAA_VERSION} replaces version {view.agreement.version}, and
                      it only changes when you sign it.{" "}
                      {resign.holdsPause
                        ? "AYA is paused until it\u2019s signed."
                        : "AYA keeps answering while you sign it."}
                    </p>
                    <AgreementResignButton slug={portal.clinicSlug} open />
                  </div>
                ) : view.agreement.kind === "dpa" && resign ? (
                  <div className="mt-3 text-sm">
                    <p className="font-semibold">Your updated agreement is waiting to be signed.</p>
                    <p className="text-muted mt-1">
                      Your practice now needs a business associate agreement in place of this one.
                      AYA is paused until it&rsquo;s signed.
                    </p>
                    <AgreementResignButton slug={portal.clinicSlug} open />
                  </div>
                ) : view.agreement.kind === "dpa" &&
                  isSpecialtyId(clinic.specialty) &&
                  asksCoveredQuestion(clinic.specialty) ? (
                  <div className="mt-3 text-sm">
                    <p className="text-muted">
                      If your practice starts billing any health insurance electronically, yourself
                      or through a clearinghouse, your agreement becomes a business associate
                      agreement, which you sign here.
                    </p>
                    <AgreementResignButton slug={portal.clinicSlug} open={false} />
                  </div>
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

/**
 * Billing after cancellation (plan Part F6): read-only until the data is
 * destroyed, with the export's deadline and the destruction's date, by the
 * rule of the agreement the service ended under (destructionPlan). The same
 * dates E2, E4 and E5 give; then the destruction, and what is kept.
 */
function AfterCancellationLines(props: {
  slug: string;
  state: AfterCancellation;
  timeZone: string;
  now: Date;
}) {
  const { state, timeZone: tz, now } = props;
  if (state.destroyedAt) {
    return (
      <div className="mt-2 grid gap-1 text-sm">
        <p>Your data was destroyed on {portalDay(state.destroyedAt, tz, now)}.</p>
        <p className="text-muted">
          Copies in our encrypted database backups expire by{" "}
          {portalDay(backupsExpireOn(state.destroyedAt), tz, now)}. We keep the signed agreement
          and your billing history, as the agreement and tax law require.
        </p>
      </div>
    );
  }
  if (state.exportDeliveredAt) {
    // The hourly destruction job reaches it within the hour it is due.
    const goneBy = new Date(state.destroyDueAt.getTime() + 60 * 60 * 1000);
    return (
      <div className="mt-2 grid gap-1 text-sm">
        <p>
          Your export was delivered on {portalDay(state.exportDeliveredAt, tz, now)}. We destroy our
          copies of your data by {portalDay(goneBy, tz, now)}.
        </p>
        <p className="text-muted">Billing records are kept, as tax law requires.</p>
      </div>
    );
  }
  return (
    <div className="mt-2 grid gap-1 text-sm">
      <p>
        Your export is ready in Conversations. Download it by{" "}
        {portalDay(state.downloadByOn, tz, now)}.
      </p>
      <p className="text-muted">
        We destroy our copies of your data within 30 days of your export being delivered, and by{" "}
        {portalDay(state.destroyByOn, tz, now)} at the latest. Billing records are kept, as tax law
        requires.
      </p>
      <a
        href={`${sectionPath(props.slug, "conversations")}#export`}
        className="border-line mt-2 inline-flex min-h-11 w-fit items-center rounded-full border px-5 font-semibold"
      >
        Open the export
      </a>
    </div>
  );
}
