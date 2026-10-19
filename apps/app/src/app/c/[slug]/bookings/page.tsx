import { collectedFieldRows } from "@healdesk/catalog";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { MAX_WRITE_ATTEMPTS } from "@/lib/booking/calendar";
import { channelLabel, DECIDABLE_FROM, type BookingRequestView } from "@/lib/meta/booking-requests";
import {
  BOOKED_LOOKBACK_DAYS,
  bookingRequestPath,
  bookingsPath,
  isDecidable,
  MISSED_DAYS,
  readBookingsScreen,
  requestWords,
  withFreeTimes,
  type BookedAppointment,
} from "@/lib/portal/bookings";
import { portalMoment, portalMoney } from "@/lib/portal/format";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { patientGuardProps, requirePatientPage, withPatientPage } from "@/lib/portal/patient-page";
import { formatPhone } from "@/lib/setup/help";

import { PatientPageGuard } from "../PatientPageGuard";
import { PortalShell } from "../PortalShell";

import { DecideForm } from "./DecideForm";
import { OutcomeControl } from "./OutcomeControl";

export const metadata: Metadata = {
  title: "Bookings · healdesk",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Bookings (plan Part F5; spec, "Portal map", 5. Bookings): what AYA booked,
 * with its deposit, and the queue of anything that needs staff.
 *
 * - **Needs you:** each open request, with "Call {first name}" and Confirm,
 *   Propose and Decline; and each deposit a booking left for the front desk.
 * - **Missed:** requests that lapsed. They were told the practice would call.
 * - **Booked by AYA:** her appointments, with the deposit and one click for
 *   Showed, No-show or Cancelled.
 *
 * Patient details, so the page opens only behind the passkey step-up
 * (requirePatientPage), reads in one patient transaction that logs each open
 * by the passkey (withPatientPage), and sits inside PatientPageGuard, which
 * takes it off the screen when the step-up lapses. `?request=<id>` is where
 * the emailed link (/booking/<token>) and a decision land: that request
 * first, with the calendar's free times when it is open, or what became of
 * it. The query carries an id and status words, never anything of the
 * person.
 */
type Query = { request?: string; followup?: string; calendar?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;

export default async function BookingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Query>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const focusId =
    typeof query.request === "string" && UUID.test(query.request) ? query.request : null;
  const page = await requirePatientPage(slug, {
    returnTo: focusId ? bookingRequestPath(slug, focusId) : bookingsPath(slug),
  });
  const now = new Date();
  const portalPage = await loadPortalPage(page.portal, now);
  if (!portalPage) notFound();
  const shell = shellProps(page.portal, portalPage, "bookings");
  const screen = await withFreeTimes(
    page,
    await withPatientPage(page, (tx) => readBookingsScreen(tx, { focus: focusId, now })),
  );
  const zone = screen.timeZone;
  const readOnly = portalPage.state.clinic.offboardingStartedAt !== null;
  const focus = screen.focus;
  // The request in focus goes first in its list.
  const open = focus
    ? [...screen.open].sort((a, b) => rank(a, focus) - rank(b, focus))
    : screen.open;
  const decided = Boolean(query.followup || query.calendar);

  return (
    <PortalShell {...shell}>
      <PatientPageGuard {...patientGuardProps(page)}>
        <h1 className="text-2xl font-semibold">Bookings</h1>
        <p className="text-muted mt-2">
          What AYA booked, and what needs you. Opened on {page.stepUp.deviceLabel}; every open is
          logged.
        </p>

        <div role="status" aria-live="polite">
          {focus ? <FocusNote view={focus} query={query} decided={decided} now={now} /> : null}
        </div>

        <section aria-labelledby="needs-you" className="mt-8">
          <h2 id="needs-you" className="text-xl font-semibold">
            Needs you
          </h2>
          {open.length === 0 && screen.deposits.length === 0 ? (
            <p className="border-line mt-3 rounded-xl border bg-white px-4 py-3">
              Nothing needs you right now.
            </p>
          ) : null}
          {open.length > 0 ? (
            <ul className="mt-3 grid gap-4">
              {open.map((r) => (
                <li key={r.id}>
                  <RequestCard
                    slug={page.portal.clinicSlug}
                    view={r}
                    zone={zone}
                    now={now}
                    inFocus={focus?.id === r.id}
                    writableCalendar={screen.writableCalendar}
                    readOnly={readOnly}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          {screen.deposits.length > 0 ? (
            <>
              <h3 className="mt-6 font-semibold">Deposits to collect</h3>
              <ul className="mt-2 grid gap-2">
                {screen.deposits.map((a) => (
                  <li key={a.id} className="border-line rounded-xl border bg-white p-4">
                    <p className="font-semibold">
                      {depositAmount(a)} from {a.firstName ?? "this booking"}, before{" "}
                      {portalMoment(a.scheduledFor, zone, now)}
                    </p>
                    <p className="text-muted mt-1 text-sm">
                      {a.bookedBy === "assistant"
                        ? "AYA booked it and said you’ll call to take the deposit."
                        : "Your team confirmed it, and the deposit is still to take."}
                    </p>
                    <CallLink name={a.firstName} phone={a.phone} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        <section aria-labelledby="missed" className="mt-10">
          <h2 id="missed" className="text-xl font-semibold">
            Missed
          </h2>
          <p className="text-muted mt-1">
            Requests nobody answered in time. They were told you&rsquo;d call.
          </p>
          {screen.missed.length === 0 ? (
            <p className="border-line mt-3 rounded-xl border bg-white px-4 py-3">
              None in the last {MISSED_DAYS} days.
            </p>
          ) : (
            <ul className="mt-3 grid gap-2">
              {screen.missed.map((r) => (
                <li
                  key={r.id}
                  id={`request-${r.id}`}
                  className={`rounded-xl border bg-white p-4 ${focus?.id === r.id ? "border-ink" : "border-line"}`}
                >
                  <p className="font-semibold">
                    {r.firstName ?? "Someone"}, {requestWords(r).via}
                  </p>
                  <p className="text-muted mt-1 text-sm">
                    Asked {portalMoment(r.createdAt, zone, now)} for {r.preferredWindow}. Lapsed{" "}
                    {portalMoment(lapsedAt(r), zone, now)}.
                  </p>
                  <Amendments items={r.amendments} zone={zone} now={now} />
                  <CallLink name={r.firstName} phone={r.phone} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="booked" className="mt-10">
          <h2 id="booked" className="text-xl font-semibold">
            Booked by AYA
          </h2>
          <p className="text-muted mt-1">
            Appointments from AYA&rsquo;s conversations: the ones she booked, and the requests your
            team confirmed. Mark how each one went.
          </p>
          {screen.booked.length === 0 ? (
            <p className="border-line mt-3 rounded-xl border bg-white px-4 py-3">
              Nothing booked in the last {BOOKED_LOOKBACK_DAYS} days, and nothing coming up.
            </p>
          ) : (
            <ul className="mt-3 grid gap-2">
              {screen.booked.map((a) => (
                <li key={a.id} id={`appointment-${a.id}`}>
                  <BookedRow
                    slug={page.portal.clinicSlug}
                    appointment={a}
                    zone={zone}
                    now={now}
                    readOnly={readOnly}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </PatientPageGuard>
    </PortalShell>
  );
}

function rank(view: BookingRequestView, focus: BookingRequestView): number {
  return view.id === focus.id ? 0 : 1;
}

/** When a lapsed request stopped being decidable. */
function lapsedAt(view: BookingRequestView): Date {
  if (view.status === "expired" && view.decidedAt) return view.decidedAt;
  if (view.rescheduleExpiresAt && view.rescheduleExpiresAt < view.expiresAt) {
    return view.rescheduleExpiresAt;
  }
  return view.expiresAt;
}

/** "Maria" from "Maria Lopez": the button says the first name only. */
function firstNameOf(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

function CallLink({ name, phone }: { name: string | null; phone: string | null }) {
  if (!phone) return null;
  const first = firstNameOf(name);
  const shown = formatPhone(phone);
  if (!E164.test(phone)) {
    return (
      <p className="mt-3 text-sm font-semibold">
        Call {first ?? "them"} on {shown}
      </p>
    );
  }
  return (
    <p className="mt-3 flex flex-wrap items-center gap-3">
      <a
        href={`tel:${phone}`}
        className="bg-ink inline-flex min-h-11 items-center rounded-full px-5 text-sm font-bold text-white"
      >
        Call {first ?? "them"}
      </a>
      <span className="text-muted text-sm">{shown}</span>
    </p>
  );
}

function Amendments({
  items,
  zone,
  now,
}: {
  items: { text: string; requestedAt: Date }[];
  zone: string;
  now: Date;
}) {
  if (items.length === 0) return null;
  return (
    <div className="bg-paper-2 mt-3 rounded-xl px-3 py-2 text-sm">
      <p className="font-semibold">Amended at your practice&rsquo;s direction</p>
      <ul className="mt-1 grid gap-1">
        {items.map((a, i) => (
          <li key={i}>
            {a.text} <span className="text-muted">({portalMoment(a.requestedAt, zone, now)})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RequestCard(props: {
  slug: string;
  view: BookingRequestView;
  zone: string;
  now: Date;
  inFocus: boolean;
  writableCalendar: boolean;
  readOnly: boolean;
}) {
  const { view: r, zone, now } = props;
  const service = r.treatment ?? r.collectedFields.service ?? null;
  // In catalogue order, in the practice's words: a vet's "client", and its
  // client's animal by name and species (collectedFieldRows).
  const collected = collectedFieldRows(r.collectedFields, r.audience).filter(
    (row) => row.id !== "service",
  );
  const unconfirmedDirect = r.bookedVia === "agent_direct" && r.status === "requested";
  const mode =
    r.status === "requested" ? "decide" : r.status === "rescheduling" ? "rescheduling" : "confirm";
  const words = requestWords(r);
  const lapses =
    r.status === "rescheduling" && r.rescheduleExpiresAt
      ? portalMoment(r.rescheduleExpiresAt, zone, props.now)
      : null;
  return (
    <article
      id={`request-${r.id}`}
      aria-labelledby={`request-${r.id}-name`}
      className={`rounded-2xl border bg-white p-4 ${props.inFocus ? "border-ink" : "border-line"}`}
    >
      {props.inFocus ? (
        <p className="text-muted text-xs font-bold tracking-[0.06em] uppercase">From your email</p>
      ) : null}
      <h3 id={`request-${r.id}-name`} className="text-lg font-semibold">
        {r.firstName ?? "Someone"} {words.headline}
      </h3>
      <p className="text-muted mt-1 text-sm">
        {words.via.charAt(0).toUpperCase() + words.via.slice(1)},{" "}
        {portalMoment(r.createdAt, zone, now)}.{" "}
        {r.status === "accepted"
          ? "You said you'd call to arrange it."
          : r.status === "rescheduling"
            ? "You proposed other times."
            : r.source === "contact_form"
              ? "They were told you'd call them back."
              : "AYA told them you'd call."}
      </p>
      {unconfirmedDirect ? (
        <p className="bg-tint-butter mt-3 rounded-xl px-3 py-2 text-sm">
          AYA tried to book this but couldn&rsquo;t confirm it reached your calendar. Check your
          calendar first.
        </p>
      ) : null}
      <CallLink name={r.firstName} phone={r.phone} />
      <dl className="mt-3 grid gap-1 text-sm">
        <Row label={words.timeLabel} value={r.preferredWindow} />
        {r.alternativeWindows.length ? (
          <Row label="Also works" value={r.alternativeWindows.join("; ")} />
        ) : null}
        {service ? <Row label="Asked about" value={service} /> : null}
        {collected.map((row) => (
          <Row key={row.id} label={row.label} value={row.value} />
        ))}
        {r.heldFor ? <Row label="AYA held" value={portalMoment(r.heldFor, zone, now)} /> : null}
      </dl>
      {r.status === "rescheduling" && r.proposedSlots.length ? (
        <div className="mt-3 text-sm">
          <p className="font-semibold">You proposed</p>
          <ul className="mt-1 grid gap-1">
            {r.proposedSlots.map((s) => (
              <li key={s.at}>{s.label}</li>
            ))}
          </ul>
          {lapses ? (
            <p className="text-muted mt-1">These lapse {lapses} if none is chosen.</p>
          ) : null}
        </div>
      ) : null}
      <Amendments items={r.amendments} zone={zone} now={now} />
      {props.readOnly ? null : (
        <DecideForm
          slug={props.slug}
          requestId={r.id}
          treatment={service}
          mode={mode}
          canDecline={(DECIDABLE_FROM.declined as readonly string[]).includes(r.status)}
          calendar={r.calendar}
          freeTimesHref={
            props.writableCalendar && !props.inFocus ? bookingRequestPath(props.slug, r.id) : null
          }
          proposedSlots={r.proposedSlots.map((s) => ({ at: s.at, label: s.label }))}
        />
      )}
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <dt className="text-muted text-xs font-bold tracking-[0.06em] uppercase">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function depositAmount(a: BookedAppointment): string {
  const usd = a.depositUsd === null ? NaN : Number(a.depositUsd);
  return Number.isFinite(usd) && usd > 0
    ? `A ${portalMoney(Math.round(usd * 100))} deposit`
    : "A deposit";
}

function depositLine(a: BookedAppointment): string {
  const usd = a.depositUsd === null ? NaN : Number(a.depositUsd);
  const amount = Number.isFinite(usd) && usd > 0 ? ` of ${portalMoney(Math.round(usd * 100))}` : "";
  switch (a.depositStatus) {
    case "pending_front_desk":
      return `Deposit${amount} to collect: call them`;
    case "pending_link":
      return `Deposit${amount}: payment link sent, not paid yet`;
    case "paid":
      return `Deposit${amount} paid`;
    case "waived":
      return "Deposit waived";
    default:
      return "No deposit";
  }
}

function calendarLine(a: BookedAppointment): string | null {
  const w = a.calendarWrite;
  if (w.status === "written" || w.status === "none") return null;
  if (w.status === "failed" && w.error === "event_id_taken") return null;
  if (w.status === "failed") return "Not in your calendar: add it by hand.";
  return w.attempts >= MAX_WRITE_ATTEMPTS
    ? "We couldn't confirm it reached your calendar: check, and add it by hand if it isn't there."
    : "We're checking your calendar and will add it if it isn't there.";
}

function BookedRow(props: {
  slug: string;
  appointment: BookedAppointment;
  zone: string;
  now: Date;
  readOnly: boolean;
}) {
  const { appointment: a, zone, now } = props;
  const calendar = calendarLine(a);
  return (
    // The request's anchor too: a link to a conversation's booking
    // (/c/<slug>/bookings#request-<id>) lands here once it is booked.
    <article id={`request-${a.requestId}`} className="border-line rounded-xl border bg-white p-4">
      <h3 className="font-semibold">
        {a.firstName ?? "Someone"}, {portalMoment(a.scheduledFor, zone, now)}
      </h3>
      <p className="text-muted mt-1 text-sm">
        {a.treatment ? `${a.treatment}. ` : ""}
        {a.bookedBy === "assistant"
          ? `AYA booked it through ${channelLabel(a.channel, a.platform)}.`
          : `${a.decidedByLabel ? `Confirmed by ${a.decidedByLabel}` : "Your team confirmed it"} from AYA's request.`}
      </p>
      <p className="mt-1 text-sm font-medium">{depositLine(a)}</p>
      {calendar ? <p className="mt-1 text-sm font-medium">{calendar}</p> : null}
      <Amendments items={a.amendments} zone={zone} now={now} />
      {a.depositStatus === "pending_front_desk" ? (
        <CallLink name={a.firstName} phone={a.phone} />
      ) : null}
      {props.readOnly ? null : (
        <OutcomeControl
          slug={props.slug}
          appointmentId={a.id}
          current={a.status}
          started={a.scheduledFor.getTime() <= now.getTime()}
        />
      )}
    </article>
  );
}

/**
 * What became of the request the page was opened for: the emailed link's,
 * or one decided a moment ago (with the follow-up and the calendar write
 * from the decision's redirect).
 */
function FocusNote(props: { view: BookingRequestView; query: Query; decided: boolean; now: Date }) {
  const { view: r, query } = props;
  const zone = r.timeZone;
  const box = "border-line mt-6 rounded-xl border bg-white px-4 py-3";
  if (isDecidable(r) && !props.decided) {
    return <p className={box}>The request from your email is first under Needs you.</p>;
  }
  if (r.lapsed || r.status === "expired") {
    return (
      <p className={box}>
        This request lapsed {portalMoment(lapsedAt(r), zone, props.now)}, so it&rsquo;s under
        Missed. They were told you&rsquo;d call.
      </p>
    );
  }
  const when = r.decidedAt ? portalMoment(r.decidedAt, zone, props.now) : null;
  const by = r.decidedByLabel ? ` by ${r.decidedByLabel}` : "";
  const direct = r.status === "confirmed" && (r.decidedByLabel ?? "").startsWith("assistant");
  const heading = direct
    ? "AYA booked this on the call"
    : r.status === "confirmed"
      ? `Confirmed${when ? ` ${when}` : ""}${by}`
      : r.status === "declined"
        ? `Declined${when ? ` ${when}` : ""}${by}. Anything further happens by phone`
        : r.status === "rescheduling"
          ? "Times proposed. Call them to go through them, then confirm the one they choose"
          : "Accepted. Call them to arrange a time";
  const slot = r.confirmedFor ? portalMoment(r.confirmedFor, zone, props.now) : null;
  const calendarStatus =
    query.calendar && query.calendar !== "none"
      ? query.calendar
      : (r.calendarWrite?.status ?? null);
  const calendar =
    !slot || !calendarStatus || calendarStatus === "none" || calendarStatus === "not-connected"
      ? null
      : calendarStatus === "written"
        ? "Added to your calendar."
        : calendarStatus === "failed" && r.calendarWrite?.error === "event_id_taken"
          ? "AYA's booking for this request is already in your calendar, so nothing more was added."
          : calendarStatus === "failed"
            ? `Not added to your calendar: add it by hand, ${slot}.`
            : "We're checking your calendar and will add it if it isn't there.";
  const relayed =
    r.channel !== "meta"
      ? null
      : query.followup === "sent"
        ? "They were told on their message thread that you'll be in touch."
        : query.followup === "outside_window" ||
            query.followup === "failed" ||
            query.followup === "no-channel"
          ? "Nothing reached them on their message thread, so call them."
          : query.followup === "withheld"
            ? "Your Instagram, Messenger and WhatsApp replies are off or paused, so nothing was sent there. Call them."
            : null;
  return (
    <div className={box}>
      <p className="font-semibold">{heading}.</p>
      {slot ? (
        <p className="mt-1">
          Appointment: {slot}.{" "}
          {direct ? "AYA told the caller on the call." : "Call them to confirm the time."}
        </p>
      ) : null}
      {calendar ? <p className="mt-1 font-medium">{calendar}</p> : null}
      {relayed ? <p className="text-muted mt-1">{relayed}</p> : null}
    </div>
  );
}
