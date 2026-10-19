import { audienceSingular } from "@healdesk/catalog";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import type { BookedAppointment, DepositToCollect, ShownRequest } from "@/lib/portal/bookings";
import { readBookingsScreen } from "@/lib/portal/bookings";
import { phoneText } from "@/lib/portal/conversation-words";
import { portalDay, portalMoment, portalMoney } from "@/lib/portal/format";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { patientGuardProps, requirePatientPage } from "@/lib/portal/patient-page";
import { REQUESTER_LABELS } from "@/lib/patient-rights/requesters";

import { FeedbackProvider } from "../feedback";
import { PatientPageGuard } from "../PatientPageGuard";
import { PortalShell } from "../PortalShell";

import { BookingOutcome, DepositPaid, RequestDecision } from "./BookingControls";

export const metadata: Metadata = { title: "Bookings · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * Bookings (plan Part F5; spec, "Portal map": "What the AI booked, with
 * deposit status, and the queue of anything flagged for manual deposit
 * collection or manual confirmation"). One page, four lists: requests
 * waiting for the team, requests that lapsed, deposits to collect, and what
 * was booked. A patient page: requirePatientPage first, so nothing is read
 * without this session's passkey step-up, and the lists' access rows are
 * written in the transaction that reads them (lib/portal/bookings.ts).
 * PatientPageGuard takes the rows off the screen when the step-up lapses.
 *
 * Every row carries an anchor (`request-<id>`, `deposit-<id>`,
 * `booking-<id>`) because that is where the clinic's alerts open
 * (alertPortalPath, lib/notices/booking-alerts.ts): a booking request (L7)
 * at its request, a deposit (L10) at its appointment, a calendar check (L34)
 * at its request, which a confirmed request carries on its booking's row.
 */
export default async function BookingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await requirePatientPage(slug, { returnTo: `/c/${slug}/bookings` });
  const now = new Date();
  const portalPage = await loadPortalPage(page.portal, now);
  if (!portalPage) notFound();
  const shell = shellProps(page.portal, portalPage, "bookings");
  const screen = await readBookingsScreen(page, { now });
  const zone = shell.timeZone;
  const when = (value: string) => portalMoment(new Date(value), zone, now);
  const person = audienceSingular(shell.audience);
  const clinicSlug = page.portal.clinicSlug;

  return (
    <PortalShell {...shell}>
      <FeedbackProvider>
        <h1 className="text-2xl font-semibold">Bookings</h1>
        <p className="text-muted mt-2">
          What AYA booked, and what is waiting for your team: booking requests to confirm and deposits to
          take. AYA never contacts anyone after a conversation, so the call to the {person} is always
          yours.
        </p>
        <PatientPageGuard {...patientGuardProps(page)}>
          <section aria-labelledby="waiting-heading" className="mt-8">
            <h2 id="waiting-heading" className="text-lg font-semibold">
              Waiting for you
            </h2>
            {screen.waiting.length === 0 ? (
              <p className="text-muted mt-2">No booking request is waiting for your team.</p>
            ) : (
              <>
                <p className="text-muted mt-2 text-sm">
                  Oldest first. Each {person} was told your team would call to settle a time; nothing is
                  booked until you confirm it.
                </p>
                <ul className="mt-3 grid gap-3">
                  {screen.waiting.map((r) => (
                    <RequestItem key={r.id} request={r} person={person} when={when} zone={zone} now={now}>
                      <RequestDecision
                        slug={clinicSlug}
                        requestId={r.id}
                        mode={r.status === "accepted" ? "confirm" : r.status === "rescheduling" ? "rescheduling" : "decide"}
                        service={r.service}
                        proposedSlots={r.proposedSlots}
                      />
                    </RequestItem>
                  ))}
                </ul>
              </>
            )}
          </section>

          {screen.missed.length > 0 ? (
            <section aria-labelledby="missed-heading" className="mt-10">
              <h2 id="missed-heading" className="text-lg font-semibold">
                Missed: they were told you&rsquo;d call
              </h2>
              <p className="text-muted mt-2 text-sm">
                Requests from the last week that waited seven days with no answer. A call is what is owed.
              </p>
              <ul className="mt-3 grid gap-3">
                {screen.missed.map((r) => (
                  <RequestItem key={r.id} request={r} person={person} when={when} zone={zone} now={now} />
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="deposits-heading" className="mt-10">
            <h2 id="deposits-heading" className="text-lg font-semibold">
              Deposits to collect
            </h2>
            {screen.deposits.length === 0 ? (
              <p className="text-muted mt-2">No deposit is waiting for your team.</p>
            ) : (
              <>
                <p className="text-muted mt-2 text-sm">
                  AYA booked these and left the deposit for your team. AYA never takes card numbers: take it
                  the way your practice does, then mark it paid here.
                </p>
                <ul className="mt-3 grid gap-3">
                  {screen.deposits.map((d) => (
                    <DepositItem key={d.appointmentId} deposit={d} slug={clinicSlug} when={when} />
                  ))}
                </ul>
              </>
            )}
          </section>

          <section aria-labelledby="booked-heading" className="mt-10">
            <h2 id="booked-heading" className="text-lg font-semibold">
              Booked
            </h2>
            {screen.booked.length === 0 ? (
              <p className="text-muted mt-2">Nothing booked through healdesk in the last two weeks or ahead.</p>
            ) : (
              <>
                <p className="text-muted mt-2 text-sm">
                  Appointments AYA booked and requests your team confirmed, from two weeks ago on. Once one&rsquo;s
                  time has come, mark how it went: it records it here only.
                </p>
                <ul className="mt-3 grid gap-3">
                  {screen.booked.map((b) => (
                    <BookedItem key={b.appointmentId} booking={b} slug={clinicSlug} when={when} />
                  ))}
                </ul>
              </>
            )}
          </section>
        </PatientPageGuard>
      </FeedbackProvider>
    </PortalShell>
  );
}

const E164 = /^\+[1-9]\d{6,14}$/;

/** "Call Dana on (415) 555-0192", a tap on a phone; healdesk places no call. */
function CallLink({ name, phone }: { name: string | null; phone: string | null }) {
  if (!phone || !E164.test(phone)) return <p className="text-muted mt-2">No number given.</p>;
  return (
    <p className="mt-2">
      <a href={`tel:${phone}`} className="inline-flex min-h-11 items-center font-semibold underline">
        Call {name ?? "them"} on {phoneText(phone)}
      </a>
    </p>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted text-sm">{term}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

/** Where a request stands, in one sentence. */
function standing(r: ShownRequest, when: (value: string) => string): string {
  const by = r.decidedByLabel ? ` by ${r.decidedByLabel}` : "";
  if (r.lapsed) return `Lapsed ${when(r.expiresAt)} with no answer. Call them.`;
  if (r.status === "accepted") {
    return `Accepted${r.decidedAt ? ` ${when(r.decidedAt)}` : ""}${by}. Call them to arrange a time, then confirm it here.`;
  }
  if (r.status === "rescheduling") {
    return `Other times proposed${r.decidedAt ? ` ${when(r.decidedAt)}` : ""}${by}. Call them to go through them, then confirm the one they choose.`;
  }
  if (r.unconfirmedDirect) {
    return "AYA tried to book this, but your calendar never confirmed it. Check your calendar first, then confirm a time here or call them.";
  }
  return "Nothing is booked yet.";
}

function RequestItem({
  request: r,
  person,
  when,
  zone,
  now,
  children,
}: {
  request: ShownRequest;
  person: string;
  when: (value: string) => string;
  zone: string;
  now: Date;
  children?: React.ReactNode;
}) {
  return (
    <li id={`request-${r.id}`} className="border-line scroll-mt-4 rounded-xl border bg-white px-4 py-4">
      <p className="font-semibold">
        {r.firstName ?? `A ${person}`} <span className="font-normal">· taken {when(r.createdAt)} on {r.via}</span>
      </p>
      <p className="mt-1">{standing(r, when)}</p>
      <CallLink name={r.firstName} phone={r.phone} />
      <dl className="mt-3 grid gap-3">
        <Row term="When suits them">
          {r.preferredWindow || "Not given"}
          {r.alternativeWindows.length > 0 ? `, or ${r.alternativeWindows.join(", or ")}` : null}
        </Row>
        {r.service ? <Row term="Asked about">{r.service}</Row> : null}
        {r.collected.map((c) => (
          <Row key={c.id} term={c.label}>
            {c.value}
          </Row>
        ))}
        {r.heldFor && r.heldUntil ? (
          <Row term="Held for them">
            {when(r.heldFor)}, until {when(r.heldUntil)}, while the deposit is sorted out. Confirm that time to
            keep it.
          </Row>
        ) : null}
        {r.status === "rescheduling" && r.proposedSlots.length > 0 ? (
          <Row term="Times you proposed">
            {r.proposedSlots.map((s) => s.label).join("; ")}
            {r.rescheduleExpiresAt ? `. They lapse ${when(r.rescheduleExpiresAt)} if none is confirmed.` : null}
          </Row>
        ) : null}
        {r.deskNote ? <Row term="Your note">{r.deskNote}</Row> : null}
      </dl>
      {r.amendments.length > 0 ? (
        <div className="mt-3">
          <p className="text-muted text-sm">Amendments at your practice&rsquo;s direction</p>
          <ul className="mt-1 grid gap-2">
            {r.amendments.map((a) => (
              <li key={a.id} className="border-line rounded-xl border px-3 py-2">
                <p className="whitespace-pre-line">{a.amendment}</p>
                <p className="text-muted mt-1 text-sm">
                  Recorded {portalDay(a.recordedAt, zone, now)}. Asked for by{" "}
                  {REQUESTER_LABELS[a.requestedBy].toLowerCase()}.
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {children}
    </li>
  );
}

/** "$75" from the stored "75.00", or null when no amount was set. */
function money(usd: string | null): string | null {
  if (usd === null) return null;
  const cents = Math.round(Number(usd) * 100);
  return Number.isFinite(cents) && cents > 0 ? portalMoney(cents) : null;
}

function DepositItem({
  deposit: d,
  slug,
  when,
}: {
  deposit: DepositToCollect;
  slug: string;
  when: (value: string) => string;
}) {
  const amount = money(d.depositUsd);
  return (
    <li id={`deposit-${d.appointmentId}`} className="border-line scroll-mt-4 rounded-xl border bg-white px-4 py-4">
      <p className="font-semibold">
        {when(d.scheduledFor)} <span className="font-normal">· {d.firstName ?? "No name given"}</span>
      </p>
      <p className="mt-1">
        Deposit to take{amount ? `: ${amount}` : ""}.{d.service ? ` For ${d.service}.` : ""}
      </p>
      <CallLink name={d.firstName} phone={d.phone} />
      <DepositPaid slug={slug} appointmentId={d.appointmentId} />
    </li>
  );
}

const DEPOSIT_WORDS: Record<BookedAppointment["depositStatus"], string | null> = {
  none: null,
  pending_front_desk: "Deposit: for your team to take",
  pending_link: "Deposit: payment link sent, not paid yet",
  paid: "Deposit: paid",
  waived: "Deposit: waived",
};

const MARKED_WORDS: Partial<Record<BookedAppointment["status"], string>> = {
  showed: "Marked: showed",
  no_show: "Marked: no-show",
  cancelled: "Marked: cancelled",
};

function calendarLine(b: BookedAppointment): string {
  switch (b.calendar.status) {
    case "written":
      return "In your Google Calendar.";
    case "writing":
    case "unknown":
      return "Checking it reached your Google Calendar.";
    case "failed":
      return b.calendar.error === "event_id_taken"
        ? "AYA's booking for it is already in your Google Calendar."
        : "Not in your Google Calendar: add it by hand.";
    case "none":
      return "healdesk didn't add it to a calendar: add it to your own calendar or booking system.";
  }
}

function BookedItem({
  booking: b,
  slug,
  when,
}: {
  booking: BookedAppointment;
  slug: string;
  when: (value: string) => string;
}) {
  const deposit = DEPOSIT_WORDS[b.depositStatus];
  const amount = money(b.depositUsd);
  return (
    <li id={`booking-${b.appointmentId}`} className="border-line scroll-mt-4 rounded-xl border bg-white px-4 py-4">
      {/* A link to the request it was confirmed from (an alert, Conversations) lands on its booking. */}
      {b.requestId ? <span id={`request-${b.requestId}`} /> : null}
      <p className="font-semibold">
        {when(b.scheduledFor)} <span className="font-normal">· {b.firstName ?? "No name given"}</span>
      </p>
      <p className="mt-1">
        {b.bookedByAssistant ? "Booked by AYA" : `Confirmed by ${b.confirmedBy ?? "your team"}`}
        {b.service ? `, for ${b.service}` : ""}.
      </p>
      {deposit ? (
        <p className="mt-1">
          {deposit}
          {amount && b.depositStatus !== "none" ? ` (${amount})` : ""}.
        </p>
      ) : null}
      <p className="text-muted mt-1 text-sm">{calendarLine(b)}</p>
      <CallLink name={b.firstName} phone={b.phone} />
      {MARKED_WORDS[b.status] ? <p className="mt-1 font-medium">{MARKED_WORDS[b.status]}</p> : null}
      {b.started ? <BookingOutcome slug={slug} appointmentId={b.appointmentId} current={b.status} /> : null}
    </li>
  );
}
