import {
  BOOKING_FIELDS,
  currentDirectBookingAddendum,
  EXCLUDED_FIELDS,
  renderDirectBookingAddendum,
  resolveBookingRequirements,
} from "@healdesk/catalog";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { resolveConnectionLink, type ResolvedLink } from "@/lib/connections/links";
import { directBookingOffered } from "@/lib/onboarding/requirements";

import { connectRequestContext } from "../../connect/[token]/request-context";
import { SetupForm, type SetupFieldView } from "./SetupForm";

/**
 * The minimum-information step (design of 23 September 2026, §H.3).
 *
 * The second of the two pages a clinic ever sees, and it mirrors the first
 * (app/connect/[token]/page.tsx) in every property that matters: the token
 * is the whole authentication; the open is rate-limited before the token is
 * examined; every failure is the same redirect to /setup/invalid; opening
 * does not spend the link; success leaves this URL for /setup/done. The
 * header of the connect page explains each, and nothing here departs from it.
 *
 * What is different is what the page asks. Not a credential — a choice from
 * a closed catalogue of booking-request fields, none of them clinical, with
 * the four that make a request a request locked on. The practice can only
 * narrow what the assistant asks; the "Never asked" list says what it could
 * never widen to. An optional Direct booking section renders the addendum
 * verbatim when counsel has approved it and the platform is one healdesk can
 * write into; until then the section is absent, not disabled.
 *
 * The link resolves with `purpose: "setup"`, so a connect token opened here
 * is a null, and the reverse — the same anti-oracle rule as an unknown one.
 *
 * ## No PHI, by construction
 *
 * A clinic name, a specialty, a catalogue and a contract's text. Nothing on
 * this page comes from a table that holds a patient.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "What your assistant asks for",
  description: "Confirm, once, which details healdesk's assistant collects when someone wants to book.",
  robots: { index: false, follow: false },
};

export default async function SetupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const request = await connectRequestContext();

  if (!withinConnectAttemptLimit("open", token, request.ipAddress ?? null)) {
    return <Throttled />;
  }

  const link: ResolvedLink | null = await resolveConnectionLink(token, request, "setup");
  if (!link) redirect("/setup/invalid");

  const defaults = new Set(resolveBookingRequirements(link.specialty, null).map((f) => f.id));
  const fields: SetupFieldView[] = BOOKING_FIELDS.map((f) => ({
    id: f.id,
    label: f.label,
    ask: f.ask,
    locked: f.locked,
    preselected: defaults.has(f.id),
    phoneOnly: !f.metaEligible,
  }));

  const offered = directBookingOffered(link.platformId);
  const addendum = currentDirectBookingAddendum();
  // Rendered with placeholders for the two things the person has not typed
  // yet, so the page shows the exact instrument. The server renders it again
  // with the real name and title on submit and hashes THAT (§E.6).
  const addendumPreview = offered
    ? renderDirectBookingAddendum({
        clinicLegalName: link.clinicName,
        signatoryName: "[your name]",
        signatoryTitle: "[your title]",
        acceptedOn: new Date().toISOString().slice(0, 10),
      })
    : null;

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        healdesk · {link.clinicName}
      </p>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
        What your assistant asks for when someone wants to book
      </h1>
      <p className="mt-4 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
        Two minutes, once. Tick the details your front desk needs to place a booking, and nothing
        more. The first four are always asked — they are what a booking request is. We have
        pre-selected a sensible set for your kind of practice; adjust it or leave it as is.
      </p>
      <p className="mt-3 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
        Nothing clinical can be selected here, and nothing here creates an account or a login.
        If nobody opens this link before it expires, the pre-selected set applies, and you can
        change it at any time by telling us.
      </p>

      <SetupForm
        token={token}
        fields={fields}
        neverAsked={[...EXCLUDED_FIELDS]}
        directBooking={offered && addendumPreview ? { version: addendum.version, text: addendumPreview } : null}
      />

      <p className="mt-10 border-t border-[color:var(--color-line)] pt-6 text-sm text-[color:var(--color-muted)]">
        Something doesn&apos;t look right? Reply to the email that brought you here, or write to{" "}
        <a href="mailto:hello@healdesk.io" className="font-semibold text-[color:var(--color-ink)] underline underline-offset-2">
          hello@healdesk.io
        </a>
        . This link works once, and stops working the moment you finish.
      </p>
    </main>
  );
}

/** Decided before the token is looked at; identical for a real link, a spent one and a guess. */
function Throttled() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16 sm:px-6">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">healdesk</p>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">Give it a minute</h1>
      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
        This page has been opened a lot in a short space of time, so we&apos;ve paused it briefly.
        Nothing is wrong with your link and nothing has been lost. Wait a few minutes and open it again.
      </p>
    </main>
  );
}
