import { isBillingInterval } from "@healdesk/catalog";
import type { Metadata } from "next";
import { cookies } from "next/headers";

import { CheckoutFlow } from "@/components/checkout/CheckoutFlow";
import { type LinkNotice, SetupRequestForm } from "@/components/checkout/SetupRequestForm";
import { Brand } from "@/components/Nav";
import { DEMO_COOKIE } from "@/lib/demo/attribution";
import { demoCheckout, demoPrefill } from "@/lib/demo/checkout";
import { demoOfferEndsAt, demoSetupCredit, getDemoSession, isDemoSlug, type DemoSession } from "@/lib/demo/sessions";
import { planLink } from "@/lib/checkout/funnel";
import { type SetupOffer, strongestOffer } from "@/lib/checkout/review";
import { cohortCreditEndsAt, findLeadById } from "@/lib/leads";
import { replyByDate } from "@/lib/reply-by";
import { gateState, invitesToBuy } from "@/lib/setup-gate";
import { SETUP_COOKIE } from "@/lib/setup-link";
import { site } from "@/lib/site";
import { readSiteOfferToken, SITE_OFFER_COOKIE, siteOfferState } from "@/lib/site-offer";

/** Every link state a visitor can be told about, from the cookie or from /start's redirect. */
const NOTICES: readonly LinkNotice[] = ["invalid", "expired", "replaced", "used"];

export const metadata: Metadata = {
  title: "Get AYA",
  description:
    "Choose a package, tell us about your clinic, sign the agreement and pay the " +
    "setup fee. Each channel goes live as you connect it.",
  // A checkout funnel has no business in search results.
  robots: { index: false, follow: false },
};

/**
 * `plan` may name a plan (`voice-metachat-500-300`), a package (`voice`) or
 * a package retired on 13 October 2026 (`complete`), which lands on the
 * package that replaced it (lib/checkout/funnel.ts, `planLink`); it is the
 * only way a package arrives preselected. A stale or unknown one preselects
 * nothing rather than erroring: the buyer lands on the flow and chooses.
 * `cancelled=1` is Stripe's cancel page sending the buyer back, to Review and
 * pay with every step intact.
 *
 * A buyer arriving from a personalised demo's "Book Onboarding" carries the
 * demo in a cookie (lib/demo/attribution.ts): the form opens with that
 * clinic's name, website, specialty and email already in it. Every step is
 * still shown, and every field can still be changed. A setup link's own
 * request goes over it: its clinic name and website, and its address, which
 * the purchase is bound to.
 */
async function demoFromCookie(): Promise<DemoSession | null> {
  const slug = (await cookies()).get(DEMO_COOKIE)?.value;
  if (!isDemoSlug(slug)) return null;
  const session = await getDemoSession(slug);
  // Built and not yet bought. Whether it also lets them past the pilot gate
  // is the routes' test, invitesToBuy (lib/setup-gate.ts), applied below.
  return session && session.status === "ready" && !session.claimed ? session : null;
}

function prefillFrom(session: DemoSession | null) {
  return session ? demoPrefill(session) : undefined;
}

/**
 * The setup offer the page can vouch for, the strongest that holds (lib/
 * checkout/review.ts): the cohort credit, from the lead the setup link or
 * the `?lead=` link names, as /api/checkout finds it; the demo's share (50%
 * from an operator's demo, 30% from a homepage one), while `demoOfferEndsAt`
 * says it holds; then the website's 30%, from the signed cookie. Undefined
 * when none of the first two holds and the cookie is not set yet: the flow
 * then asks /api/site-offer, which sets it (a page cannot set a cookie). Null
 * when the website's offer has run out too.
 */
async function setupOfferFor(input: {
  leadId: string | null;
  demo: DemoSession | null;
  siteCookie: string | undefined;
}): Promise<SetupOffer | null | undefined> {
  const lead = input.leadId ? await findLeadById(input.leadId).catch(() => null) : null;
  const cohortEnds = lead ? cohortCreditEndsAt(lead) : null;
  const demoEnds = input.demo ? demoOfferEndsAt(input.demo) : null;
  const strongest = strongestOffer([
    cohortEnds ? { kind: "cohort", endsAt: cohortEnds.toISOString() } : null,
    demoEnds && input.demo
      ? {
          kind: "demo",
          endsAt: demoEnds.toISOString(),
          percentOfSetupFee: demoSetupCredit(input.demo).percentOfSetupFee,
        }
      : null,
  ]);
  if (strongest) return strongest;
  const siteAt = readSiteOfferToken(input.siteCookie);
  if (!siteAt) return undefined;
  const { endsAt } = siteOfferState(siteAt);
  return endsAt ? { kind: "site", endsAt } : null;
}

export default async function GetStartedPage({
  searchParams,
}: {
  searchParams: Promise<{
    plan?: string;
    interval?: string;
    link?: string;
    cancelled?: string;
    lead?: string;
  }>;
}) {
  const { plan, interval, link, cancelled, lead } = await searchParams;
  const initialPlan = planLink(plan) ? plan : undefined;
  const initialInterval = isBillingInterval(interval) ? interval : "month";
  const demo = await demoFromCookie();
  const initialState = prefillFrom(demo);

  /**
   * While the purchase is by invitation, the setup cookie decides what this
   * page is (lib/setup-gate.ts): the purchase, pre-filled from the request
   * and bound to its address, or "Tell us about your clinic". The routes
   * behind the purchase check the same cookie again, so this is what the
   * page shows, not what protects it.
   */
  const gate = await gateState((await cookies()).get(SETUP_COOKIE)?.value);
  // Worked out once, so the form's promise and the card beside it name the same day.
  const replyBy = replyByDate();
  const invited = gate.mode === "pilot" && gate.link === "valid" ? gate.request : null;
  const notice =
    gate.mode === "pilot" && gate.link !== "valid" && gate.link !== "none"
      ? gate.link
      : NOTICES.find((n) => n === link) ?? null;

  // The lead whose cohort credit /api/checkout would honour: the setup
  // link's own, or else the one the `?lead=` link names.
  const leadId = invited ? invited.leadId ?? null : typeof lead === "string" ? lead : null;
  const setupOffer = await setupOfferFor({
    leadId,
    demo,
    siteCookie: (await cookies()).get(SITE_OFFER_COOKIE)?.value,
  });

  return (
    <div className="min-h-screen">
      <header className="border-line/60 border-b">
        <div className="mx-auto flex max-w-[1240px] items-center px-5 py-4 sm:px-8 lg:px-14">
          <Brand />
          {/* A buyer from their demo goes back to it, not to the homepage
              (owner, 13 October 2026), from here and from Stripe's cancel page. */}
          <a
            href={demo ? `/demo/${demo.slug}` : "/"}
            className="text-muted hover:text-ink ml-auto text-sm font-semibold transition-colors"
          >
            {demo ? "Back to your demo" : "Back to site"}
          </a>
        </div>
      </header>

      <main className="px-5 py-12 sm:px-8 sm:py-16">
        {gate.mode === "pilot" && !invited && !(demo && invitesToBuy(demo)) ? (
          // The form, and beside it from 1024px what sending it leads to
          // (owner, 12 October 2026): on its own the page read as a bare
          // column of fields. Below 1024px the card follows the form. The
          // buy modal renders the same form without it, one column as before.
          <div className="mx-auto grid max-w-[1120px] items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:gap-16">
            <SetupRequestForm
              replyBy={replyBy}
              notice={notice}
              // From a homepage demo: what it already knows, so it is not asked for twice.
              initialEmail={initialState?.contactEmail}
              initialClinicName={initialState?.clinicName}
              initialWebsite={initialState?.website}
            />
            <WhatHappensNext replyBy={replyBy} />
          </div>
        ) : (
          <CheckoutFlow
            initialPlan={initialPlan}
            initialInterval={initialInterval}
            initialState={
              invited
                ? { ...initialState, clinicName: invited.clinicName, website: invited.website }
                : initialState
            }
            lockedEmail={invited?.email}
            returnedFromPayment={cancelled === "1"}
            demo={demo ? demoCheckout(demo) : undefined}
            // The one setup offer that applies, as the checkout route will
            // find it; undefined lets the flow start the website's own.
            setupOffer={setupOffer}
            // Stripe Tax is the server's setting; the page only says so.
            salesTax={process.env.STRIPE_AUTOMATIC_TAX === "true"}
          />
        )}
      </main>
    </div>
  );
}

/**
 * "What happens next", beside "Tell us about your clinic" (owner, 12 October
 * 2026).
 *
 * Every line is one the site or the code already stands behind, and nothing
 * else: the reply date is the form's own (`replyByDate`); a person reads each
 * request and replies with the setup link (SetupRequestForm, /admin/setup);
 * the purchase it opens is this page's own description, and the plan start
 * is the package step's sentence; the channels go live as the homepage's
 * answer to "How long until she's live?" says, step by step and never by the
 * clock, because the funnel promises no timing before purchase
 * (funnel-copy.test.ts). No price, no duration and no date but the reply's. A
 * step that cannot be traced to one of those does not belong here.
 */
function WhatHappensNext({ replyBy }: { replyBy: string }) {
  const steps = [
    {
      title: `We reply by ${replyBy}`,
      body: "A person reads your request and answers at the clinic email you give, with your setup link.",
    },
    {
      title: "Your setup link opens the purchase",
      body: `Choose a package, tell us about your clinic, sign the agreement and pay the setup fee. Your plan starts the day ${site.agent} first answers a patient.`,
    },
    {
      title: "Each channel goes live on its own",
      body: "Website chat once the snippet is on your site, Instagram and Messenger once you connect them, your phone once call forwarding is set, and WhatsApp once its account has a payment method.",
    },
  ] as const;

  return (
    <aside
      aria-labelledby="next-heading"
      className="demo-field-warm rounded-lg p-3 lg:sticky lg:top-10 lg:mt-11"
    >
      <div className="rounded-md bg-white p-6 shadow-md sm:p-7">
        <h2
          id="next-heading"
          className="font-display text-ink text-[26px] leading-tight font-normal tracking-[-0.02em]"
        >
          What happens next
        </h2>
        <ol className="divide-line mt-5 divide-y">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-4 py-4 last:pb-0">
              <span
                aria-hidden
                className="bg-tint-peach text-red-deep mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-[13px] font-bold tabular-nums"
              >
                {index + 1}
              </span>
              <div>
                <p className="text-ink text-[16.5px] leading-snug font-semibold">{step.title}</p>
                <p className="text-muted mt-1 text-[15px] leading-[1.5] font-medium">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="border-line text-muted mt-5 border-t pt-5 text-sm font-medium">
          Questions? Email{" "}
          <a href={`mailto:${site.email}`} className="text-ink underline underline-offset-2">
            {site.email}
          </a>
          .
        </p>
      </div>
    </aside>
  );
}
