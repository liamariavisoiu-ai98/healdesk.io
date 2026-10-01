import {
  getConnectionGuide,
  getPlatform,
  personaliseGuide,
  type ConnectionGuide,
  type Platform,
} from "@healdesk/catalog";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { env } from "@/lib/env";
import {
  resolveConnectionLink,
  type ResolvedLink,
} from "@/lib/connections/links";

import { ConnectForm, CopyRow } from "./ConnectForm";
import { connectRequestContext } from "./request-context";

/**
 * The read-back credential handover.
 *
 * PHASE TWO: attribution read-back. Not part of v1: a pasted credential is
 * exactly what the v1 onboarding rules forbid ("Every connection is a login
 * button"), and v1 reads nothing back from a clinic's system. While
 * HEALDESK_PHASE_TWO_ATTRIBUTION is not "true" every token, real or not, gets
 * the same redirect to /connect/invalid, before the token is even looked at.
 * Clinics sign into the v1 clinic portal (not built yet), not here.
 *
 * In phase two: they arrive from one link in one email, follow the steps for
 * their platform and paste one credential.
 *
 * ## What authenticates this
 *
 * The token in the path, and nothing else. `/connect` is listed in proxy.ts
 * under PUBLIC_PATHS, which — as that file says of the machine-to-machine
 * routes below it — is a statement that the route does its own authentication,
 * not an exemption from it. `resolveConnectionLink()` hashes what arrives and
 * matches on the digest; connection_links stores SHA-256 and never the token,
 * so a dump of that table yields no working links.
 *
 * ## Why every failure is the same redirect
 *
 * Expired, already used, never issued and malformed come back as one
 * indistinguishable null, and all four end at `/connect/invalid`. Rendering
 * "this link for Radiance Med Spa expired on Tuesday" to whoever holds a stale
 * URL would confirm that the clinic exists, that it is our customer, and that
 * the token was once real — three facts a stranger has no business learning
 * from a page with no login. Nothing token-specific is rendered before the
 * resolve succeeds, which is the mechanical form of that rule. `redirect()`
 * rather than `notFound()` because a 404 and a redirect are themselves
 * distinguishable.
 *
 * ## Opening a link does not spend it
 *
 * No consumption here, on purpose. Mail gateways and link-safety scanners fetch
 * every URL in a message before the recipient ever sees it, so a link consumed
 * on GET would arrive dead for exactly the security-conscious clinics we most
 * want. Spending happens on the submission, in actions.ts.
 *
 * ## A finished submission never comes back through here
 *
 * It used to. The form is progressively enhanced, so without JavaScript the
 * browser POSTs to this same URL; Next runs `submitCredential()`, and then
 * renders this page to build the response. That render re-resolved a token the
 * request had just spent, got null, and sent a clinic whose credential was
 * safely stored to `/connect/invalid`.
 *
 * The redirect below is not the bug and must not be softened — it is the
 * anti-oracle rule above, and this component genuinely cannot tell a
 * post-action render from a GET (no method, no action header reaches it). The
 * fix is that success has its own URL: `submitCredential()` redirects to
 * `/connect/done` from outside its try/catch, so neither transport re-renders a
 * spent link. Nothing here needs a special case, and nothing here should grow
 * one.
 *
 * The audit row for an open belongs to `resolveConnectionLink()` and is
 * deliberately not written here. It is the only thing that can attribute a
 * *failed* open — it alone can map an unknown or expired token back to a clinic
 * — and recording the successful ones here as well would double every
 * scanner's prefetch in the clinic's own trail.
 *
 * ## Why an open is rate-limited at all
 *
 * That audit row is written on every open, including every rejected one, and
 * that is the property being protected rather than a side effect. Unbounded, it
 * is also a hose: a spent link still resolves to a clinic, so anyone who ever
 * held one — a forwarded email, a departing office manager — can append to that
 * clinic's `audit_log` indefinitely, and the runtime role has no DELETE on it.
 * The limiter runs before the token is looked at, so it costs a stranger the
 * same as an honest visitor and tells them the same thing. See
 * lib/connections/attempt-limit.ts.
 *
 * ## No PHI, by construction
 *
 * A clinic name and a platform's setup steps. Nothing patient-level reaches
 * this file, and nothing it renders comes from a table that holds any. See
 * docs/hipaa-compliance.md.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // Names no clinic: a title is the one piece of a page that leaks into browser
  // history, tab lists and screenshots shared in a support thread.
  title: "Connect your booking system",
  // Overridden, not inherited. The root layout's description is "Clinic console
  // for healdesk." — written when everything below it was staff-only and behind
  // a session. It names no clinic, for the same reason the title doesn't.
  description: "Give healdesk read-only access to your booking system, once.",
  // The root layout already says this. Repeated because this is the one page in
  // the app a non-employee is ever sent to, and inheriting a rule silently is
  // not the same as meaning it.
  robots: { index: false, follow: false },
};

export default async function ConnectPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const request = await connectRequestContext();

  // Before the database, and before the token has been examined at all — so a
  // real link, a spent one and a guess are all priced and answered identically,
  // and there is no shape of request that reaches the audit log for free.
  if (
    !withinConnectAttemptLimit("open", token, request.ipAddress ?? null)
  ) {
    return <Throttled />;
  }

  // Phase two is fenced before the token is examined: the same redirect as a
  // dead link, so the page says nothing about which tokens exist.
  if (!env.phaseTwoAttribution()) redirect("/connect/invalid");

  // No shape check in front of this. lib/connections/links.ts is contracted to
  // return null for anything malformed rather than throw, and a second, quietly
  // diverging opinion about what a token looks like would only add a timing
  // difference between "wrong shape" and "wrong token".
  const link: ResolvedLink | null = await resolveConnectionLink(token, request);

  if (!link) redirect("/connect/invalid");

  const platform = getPlatform(link.platformId);
  const guide = getConnectionGuide(link.platformId);

  // OAuth platforms, and clinics with nothing to connect, have no wizard. They
  // are still holding a live link, so they get a straight answer rather than
  // the dead-end page — being told your working link is broken is its own
  // support ticket.
  if (!platform || !guide) {
    return (
      <Shell clinicName={link.clinicName}>
        <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
          Nothing to do here yet
        </h1>
        <p className="mt-4 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
          {noWizardMessage(platform)}
        </p>
        <ContactLine />
      </Shell>
    );
  }

  const personalised = personaliseGuide(guide, link.clinicSlug);

  return (
    <Shell clinicName={link.clinicName}>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
        Connect {platform.name}
      </h1>
      <p className="mt-4 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
        About {personalised.estimatedMinutes} minutes, once. You&apos;ll create a
        read-only account for us inside {platform.name} and paste one thing back
        here. We never ask for your own login, and this access can&apos;t change
        anything in {platform.name}.
      </p>

      {personalised.vendorRequestNeeded ? (
        <p className="mt-6 rounded-xl border border-[color:var(--color-red)]/30 bg-[color:var(--color-red)]/[0.06] px-4 py-3 text-[15px] font-medium">
          {personalised.vendorRequestNeeded}
        </p>
      ) : null}

      <Boundaries guide={personalised} />

      <Steps guide={personalised} platformName={platform.name} />

      <ConnectForm token={token} fields={personalised.fields} />

      <ContactLine />
    </Shell>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * What to say to someone whose link is good but whose platform has no wizard.
 *
 * Three situations, and a clinic can tell them apart even if the code doesn't.
 * The trap is `NO_PLATFORM_ID`: it is a real row in the catalogue named "No
 * booking software", so `platform` is truthy for it and the obvious one-line
 * ternary greets a clinic with no booking system with "No booking software
 * connects with a single approval". The split is on `connection`, which is the
 * field that actually decides whether there is anything for them to do.
 *
 * All three end at the same place — nothing is needed from you today, here is
 * a human to reply to — because that is true in all three, and a live link is
 * never answered with the dead-end page.
 */
function noWizardMessage(platform: Platform | undefined): string {
  if (!platform || platform.connection === "none") {
    return "There's no booking system on your account for us to connect to, so there's nothing to set up here. If that doesn't sound right, reply to the email that brought you here and we'll sort it out.";
  }

  if (platform.connection === "oauth") {
    return `${platform.name} connects with a single approval rather than a setup wizard, and we'll email you the moment that's ready. Nothing is needed from you today.`;
  }

  // A readonly_user platform with no guide: the catalogue knows the platform
  // and not yet the steps. Guessing at someone's admin screens is exactly what
  // connection-steps.ts refuses to do, so we don't either.
  return `We're still writing the ${platform.name} steps, so we'll do this with you directly rather than guess at your admin screens. Nothing is needed from you today.`;
}

/**
 * What a throttled visitor sees.
 *
 * Not `/connect/invalid`, and not because that page is unfriendly. It tells a
 * clinic their link is dead and to ask for another — saying that to someone
 * whose link is perfectly good spends a live link over a refresh, and teaches
 * them to distrust the replacement. This says the true thing instead: come back
 * shortly.
 *
 * It discloses nothing, for the same mechanical reason the invalid page
 * doesn't: it is decided before the token is looked at, so it is the identical
 * response for a real link, a spent one and a guess. No `Shell`, because that
 * takes a clinic name and we have deliberately not gone and found one.
 */
function Throttled() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16 sm:px-6">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        healdesk
      </p>

      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
        Give it a minute
      </h1>

      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
        This page has been opened a lot in a short space of time, so we&apos;ve
        paused it briefly. Nothing is wrong with your link and nothing has been
        lost. Wait a few minutes and open it again.
      </p>

      <p className="mt-6 text-[15px]">
        If it still doesn&apos;t load, reply to the email that brought you here,
        or write to{" "}
        <a
          href="mailto:hello@healdesk.io"
          className="font-semibold underline underline-offset-2"
        >
          hello@healdesk.io
        </a>
        .
      </p>
    </main>
  );
}

function Shell({
  clinicName,
  children,
}: {
  clinicName: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        healdesk · {clinicName}
      </p>
      {children}
    </main>
  );
}

/**
 * What the credential does, and — the half that matters — does not grant.
 *
 * Above the steps, not after them. Every guide in connection-steps.ts names
 * clinical notes explicitly because that is the thing a clinic actually worries
 * about, and a person who reads it only after pasting their key was asked to
 * trust us on nothing. The catalogue's own rule: a step that says "paste your
 * API key" without saying what it grants is the step people abandon.
 */
function Boundaries({ guide }: { guide: ConnectionGuide }) {
  return (
    <section className="mt-8 rounded-2xl border border-[color:var(--color-line)] bg-white p-5 sm:p-6">
      <h2 className="text-[13px] font-bold tracking-[0.04em] uppercase">
        What you&apos;re handing over
      </h2>

      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <div>
          <p className="text-sm font-bold">It lets us read</p>
          <ul className="mt-2.5 space-y-2 text-[15px]">
            {guide.grants.map((item) => (
              <li key={item} className="flex gap-2.5">
                <span aria-hidden className="text-[color:var(--color-orange)]">
                  ✓
                </span>
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border border-[color:var(--color-red)]/25 bg-[color:var(--color-red)]/[0.05] p-4">
          <p className="text-sm font-bold">It never gives us</p>
          <ul className="mt-2.5 space-y-2 text-[15px]">
            {guide.doesNotGrant.map((item) => (
              <li key={item} className="flex gap-2.5">
                <span aria-hidden className="text-[color:var(--color-red)]">
                  ✕
                </span>
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/**
 * All steps, all visible.
 *
 * The deleted console wizard revealed one at a time. That was right for a
 * screen someone could come back to; it is wrong here, where the whole page is
 * a single sitting on a phone between patients and the person needs to see how
 * long this is before they agree to start it.
 */
function Steps({
  guide,
  platformName,
}: {
  guide: ConnectionGuide;
  platformName: string;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-[13px] font-bold tracking-[0.04em] uppercase">
        In {platformName}
      </h2>

      {/*
        connection-steps.ts marks a guide `verified` when its steps were
        confirmed against the platform's own documentation. Where it isn't, they
        are shown as our current understanding rather than as fact, because being
        confidently wrong about someone's admin screen sends them clicking
        through settings they should not be in, and costs more trust than
        admitting the screen may have moved.
      */}
      {!guide.verified ? (
        <p className="mt-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper-2)] px-4 py-3 text-sm">
          {platformName} may have moved these screens since we last checked
          them, so treat the steps below as a guide rather than gospel. If
          something doesn&apos;t match what you see, don&apos;t go hunting.
          reply to the email that brought you here and we&apos;ll walk through it
          with you.
        </p>
      ) : null}

      <ol className="mt-4 grid gap-3">
        {guide.steps.map((step, index) => (
          <li
            key={step.title}
            className="rounded-2xl border border-[color:var(--color-line)] bg-white p-4 sm:p-5"
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-[color:var(--color-paper-2)] text-[12px] font-bold"
              >
                {index + 1}
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium">{step.title}</p>

                {step.detail ? (
                  <p className="mt-1.5 text-sm text-[color:var(--color-muted)]">
                    {step.detail}
                  </p>
                ) : null}

                {step.copyable ? <CopyRow value={step.copyable} /> : null}

                {step.link ? (
                  <a
                    href={step.link.url}
                    target="_blank"
                    // noreferrer as much as noopener: this page's own URL is a
                    // live single-use credential, and a Referer header would
                    // hand it to the booking platform. next.config.ts sets
                    // Referrer-Policy: no-referrer for the whole app; this is
                    // the belt to that pair of braces.
                    rel="noreferrer noopener"
                    className="mt-3 inline-block text-sm font-bold text-[color:var(--color-red)] underline underline-offset-2"
                  >
                    {step.link.label} ↗
                  </a>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ContactLine() {
  return (
    <p className="mt-10 border-t border-[color:var(--color-line)] pt-6 text-sm text-[color:var(--color-muted)]">
      Stuck, or something doesn&apos;t look right? Reply to the email that
      brought you here, or write to{" "}
      <a
        href="mailto:hello@healdesk.io"
        className="font-semibold text-[color:var(--color-ink)] underline underline-offset-2"
      >
        hello@healdesk.io
      </a>
      . This link works once, and stops working the moment you finish.
    </p>
  );
}
