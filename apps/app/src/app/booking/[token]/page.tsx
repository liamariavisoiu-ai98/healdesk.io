import { audienceSingular, collectedFieldRows } from "@healdesk/catalog";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { connectRequestContext } from "@/app/connect/[token]/request-context";
import { MAX_WRITE_ATTEMPTS } from "@/lib/booking/calendar";
import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { channelLabel, resolveBookingRequest, type ResolvedBookingRequest } from "@/lib/meta/booking-requests";

import { DecideForm } from "./DecideForm";

/**
 * The desk's view of one booking request, and the one place it is decided.
 *
 * Until 19 October 2026 the desk was emailed a link to this page whenever
 * an agent, on the phone or on a Meta thread, took a booking request. No
 * email carries it any more: the clinic's booking alert (L7,
 * lib/notices/booking-alerts.ts) is a pointer into the signed-in portal,
 * because the token in the path is the whole of the authentication here,
 * exactly as it is for /connect/[token], and the portal rule puts the
 * passkey step-up before any booking opens. Expired, unknown and malformed
 * tokens are one redirect to /booking/invalid, so a stale URL confirms
 * nothing about which requests exist. TODO(v1): the clinic portal's Bookings
 * screen is where this queue belongs, and it retires this page; until it is
 * built a request is read on its conversation in Conversations and confirmed
 * in the clinic's own system.
 *
 * This is the manual booking path: what happens when the assistant did not
 * book directly (manual booking mode, Auto-confirm off, a broken calendar,
 * and for now every clinic, until the Google Calendar adapter exists). The
 * desk has the final say here: confirm a time, which is the moment the
 * appointment row comes into existence; accept and call them; propose up to
 * three other times (23 September 2026, §C) and go through them by phone; or
 * decline. healdesk contacts no one about a request. Where the clinic
 * connected a writable calendar, confirming also adds the appointment there
 * and this page says whether that worked; in v1 no such calendar exists yet,
 * so the appointment is recorded here and the desk adds it to its own system.
 *
 * This page does show patient details — a name, a number, the times they
 * asked for, what the assistant collected, and on a phone request the
 * service asked for — because that is what the desk needs in order to call. It lives
 * in apps/app, the PHI side, is served over the BAA-covered host, and is
 * never indexed. The email that used to carry the link named none of it.
 *
 * A decided request still renders, read-only, with its outcome: a second
 * click on the same email should show what happened, not a dead end. An
 * accepted request can still be confirmed to a slot from here, and
 * proposed alternatives can be confirmed, replaced or declined. An
 * appointment the assistant booked itself (§E.5) is read-only from the
 * start: the practice changes it in its own calendar.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Booking request",
  description: "A booking request from a patient, for the front desk to confirm, propose other times, call back or decline.",
  robots: { index: false, follow: false },
};

type Params = { followup?: string; calendar?: string };

export default async function BookingRequestPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Params> }) {
  const { token } = await params;
  const query = await searchParams;
  const request = await connectRequestContext();

  if (!withinConnectAttemptLimit("open", token, request.ipAddress ?? null)) {
    return (
      <Shell>
        <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight sm:text-3xl">Give it a few minutes</h1>
        <p className="mt-4 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
          That link has been opened many times in a row. Wait ten minutes and open it again from the email.
        </p>
      </Shell>
    );
  }

  const req: ResolvedBookingRequest | null = await resolveBookingRequest(token, request);
  if (!req) redirect("/booking/invalid");

  const when = req.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: req.timeZone });
  const via = channelLabel(req.channel, req.platform);
  const open = req.status === "requested";
  const acceptedPending = req.status === "accepted";
  const rescheduling = req.status === "rescheduling";
  // Booked by the assistant only once its write is confirmed (plan §7.7): an
  // `agent_direct` request still `requested` is one whose booking could not
  // be confirmed in the calendar, and the desk decides it like any other.
  const direct = req.status === "confirmed" && (req.decidedByLabel ?? "").startsWith("assistant");
  const unconfirmedDirect = req.bookedVia === "agent_direct" && !direct;
  const service = req.treatment ?? req.collectedFields.service ?? null;
  // In catalogue order, in the practice's words: a vet's "client", and its
  // client's animal by name and species (collectedFieldRows).
  const collected = collectedFieldRows(req.collectedFields, req.audience).filter((row) => row.id !== "service");
  const person = audienceSingular(req.audience);

  const heading = direct
    ? "Booked by the assistant on the call"
    : unconfirmedDirect && open
      ? "The assistant couldn't confirm this booking reached your calendar"
      : open
      ? `A ${person} would like to book`
      : acceptedPending
        ? "Accepted — awaiting your call"
        : rescheduling
          ? "Alternatives proposed — awaiting your call"
          : req.status === "expired" && req.proposedSlots.length
            ? "Alternatives lapsed"
            : `Request ${req.status}`;

  return (
    <Shell clinicName={req.clinicName}>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight sm:text-3xl">{heading}</h1>
      <p className="mt-4 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
        {direct
          ? `Taken on ${when} through ${via}. Your assistant booked this caller directly into your calendar. Nothing further is needed unless you want to change it, which you do in your calendar.`
          : unconfirmedDirect
            ? `Taken on ${when} through ${via}. The assistant tried to book this caller but couldn't confirm the booking reached your calendar. Check your calendar, then confirm a time here or call them.`
            : `Taken on ${when} through ${via}. The assistant took these details and confirmed nothing; it told the person you would call. Nothing is booked until you confirm it here or by phone.`}
      </p>

      <dl className="mt-6 grid gap-3 rounded-2xl border border-[color:var(--color-line)] p-5 text-[15px]">
        <Row label="First name" value={req.firstName ?? "—"} />
        <Row label="Phone" value={req.phone ?? "—"} />
        <Row label="First choice" value={req.preferredWindow} />
        {req.alternativeWindows.length ? req.alternativeWindows.map((w, i) => <Row key={i} label="Also works" value={w} />) : <Row label="Also works" value="—" />}
        {service ? <Row label="Asked about" value={service} /> : null}
      </dl>
      {collected.length ? (
        <dl className="mt-3 grid gap-3 rounded-2xl border border-[color:var(--color-line)] p-5 text-[15px]">
          <p className="text-[13px] font-bold tracking-[0.06em] text-[color:var(--color-muted)] uppercase">Collected by the assistant</p>
          {collected.map((row) => (
            <Row key={row.id} label={row.label} value={row.value} />
          ))}
        </dl>
      ) : null}
      {req.amendmentCount ? (
        // The practice's amendments: the request stays as it was made, and
        // every screen of healdesk's that shows it carries them (clause 14(b)
        // of BAA 1.5.0, as of 1.3.0). This page opens with the emailed token
        // alone, so it says how many and where to read them, never what they
        // say.
        <p className="mt-3 rounded-2xl border border-[color:var(--color-line)] p-5 text-[15px]">
          {req.amendmentCount === 1 ? "1 amendment" : `${req.amendmentCount} amendments`} at your practice&rsquo;s direction. Read
          {req.amendmentCount === 1 ? " it" : " them"} in the {person}&rsquo;s export before you act on this request.
        </p>
      ) : null}

      {direct ? (
        <Decided req={req} query={query} />
      ) : open || acceptedPending || rescheduling ? (
        <>
          <p className="mt-6 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
            {open
              ? "Confirm a time if you can see them then; the appointment is recorded and they are told by phone. Accept if you'd rather call to arrange it; they'll be told you will call. Propose other times if you can't offer theirs. Decline if you can't offer anything; they'll be told you will call to find another time. On a message thread the reply names no time and no provider."
              : acceptedPending
                ? "You accepted this and said you would call. Once you have agreed a time with them, confirm it here so the appointment is recorded — or propose other times and go through them by phone."
                : "You proposed these times. Call them to go through them, then confirm the one they choose here; if none work you can propose others or decline."}
          </p>
          {rescheduling ? <Proposed req={req} query={query} /> : null}
          <DecideForm
            token={token}
            treatment={service}
            mode={open ? "decide" : rescheduling ? "rescheduling" : "confirm"}
            calendar={req.calendar}
            preferred={{ primary: req.preferredWindow, alternatives: req.alternativeWindows }}
            proposedSlots={req.proposedSlots.map((s) => ({ at: s.at, label: s.label }))}
          />
          {acceptedPending ? <Decided req={req} query={query} /> : null}
        </>
      ) : (
        <Decided req={req} query={query} />
      )}
    </Shell>
  );
}

/** The alternatives the desk proposed. The desk carries them, by phone: healdesk places no calls. */
function Proposed({ req, query }: { req: ResolvedBookingRequest; query: Params }) {
  const carried = "Call them to offer these times, then confirm the one they choose here.";
  const thread =
    req.channel !== "meta"
      ? null
      : query.followup === "sent"
        ? "They have also been told on the thread that you will go through some options by phone."
        : query.followup === "outside_window"
          ? "Their message thread's 24-hour window has closed, so nothing was sent there."
          : query.followup === "withheld"
            ? "Your Instagram, Messenger and WhatsApp replies are switched off or paused, so nothing was sent there."
            : null;
  const lapses = req.rescheduleExpiresAt?.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: req.timeZone });
  return (
    <div className="mt-6 rounded-2xl border border-[color:var(--color-line)] p-5 text-[15px]">
      <p className="text-[13px] font-bold tracking-[0.06em] text-[color:var(--color-muted)] uppercase">Proposed</p>
      <ul className="mt-2 grid gap-1">
        {req.proposedSlots.map((s) => (
          <li key={s.at} className="font-medium">
            {s.label}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[color:var(--color-muted)]">{carried}</p>
      {thread ? <p className="mt-2 text-[color:var(--color-muted)]">{thread}</p> : null}
      {lapses ? <p className="mt-2 text-[color:var(--color-muted)]">These lapse on {lapses} if nothing is chosen.</p> : null}
    </div>
  );
}

function Decided({ req, query }: { req: ResolvedBookingRequest; query: Params }) {
  const when = req.decidedAt?.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: req.timeZone });
  const slot = req.confirmedFor?.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: req.timeZone });
  const direct = req.status === "confirmed" && (req.decidedByLabel ?? "").startsWith("assistant");
  const heldFor = req.heldFor?.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: req.timeZone });
  const relayed =
    req.channel !== "meta"
      ? null
      : query.followup === "sent"
        ? "They have been told on the thread that you will be in touch."
        : query.followup === "failed"
          ? "We could not reach them on the thread just now — please call them directly."
          : query.followup === "outside_window"
            ? "Their message thread's 24-hour window has closed, so nothing was sent there — please call them directly."
            : query.followup === "no-channel"
              ? "The channel this came from is no longer connected, so please call them directly."
              : query.followup === "withheld"
                ? "Your Instagram, Messenger and WhatsApp replies are switched off or paused, so nothing was sent there — please call them directly."
                : null;
  // §B.4: the write's outcome, from the redirect just now or from the row on a later open.
  const calendarStatus = query.calendar && query.calendar !== "none" ? query.calendar : req.calendarWrite?.status ?? null;
  const calendarError = req.calendarWrite?.error ?? null;
  const calendarLine =
    !slot || !calendarStatus || calendarStatus === "none" || calendarStatus === "not-connected"
      ? null
      : calendarStatus === "written"
        ? "Added to your calendar."
        : calendarStatus === "failed" && calendarError === "event_id_taken"
          ? `Recorded here. The assistant's booking for this request is already in your calendar${heldFor ? ` at ${heldFor}` : ""}, so nothing more was added; change it there if needed.`
          : calendarStatus === "failed" && calendarError === "calendar_not_connected"
            ? `Recorded here, but NOT added to your calendar, because your Google Calendar isn't connected right now — please add it by hand: ${slot}.`
            : calendarStatus === "failed"
              ? `Recorded here, but NOT added to your calendar — please add it by hand: ${slot}.`
              : (req.calendarWrite?.attempts ?? 0) >= MAX_WRITE_ATTEMPTS
                ? // Out of attempts, nothing will try again: say so rather than "we're checking".
                  `Recorded here, but we couldn't confirm it reached your calendar — please check your calendar and add it by hand if it isn't there: ${slot}.`
                : "Recorded here; we're checking your calendar and will add it if it isn't there.";
  const confirmLine = !slot
    ? null
    : direct
      ? "The assistant told the caller on the call."
      : "Call them to confirm the time.";
  const heading = direct
    ? "Booked"
    : req.status === "confirmed"
      ? "Confirmed"
      : req.status === "accepted"
        ? "Accepted, awaiting your call"
        : req.status === "declined"
          ? "Declined"
          : req.proposedSlots.length
            ? "Alternatives lapsed"
            : "Expired";
  return (
    <div className="mt-6 rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-surface,transparent)] p-5 text-[15px]">
      <p className="font-medium">
        {heading}
        {when ? ` on ${when}` : ""}
        {req.decidedByLabel ? ` by ${req.decidedByLabel}` : ""}.
      </p>
      {slot ? (
        <p className="mt-2">
          Appointment: {slot}. {confirmLine}
        </p>
      ) : null}
      {calendarLine ? <p className="mt-2 font-medium">{calendarLine}</p> : null}
      {relayed ? <p className="mt-2 text-[color:var(--color-muted)]">{relayed}</p> : null}
      {req.deskNote ? (
        <p className="mt-2 text-[color:var(--color-muted)]">
          Your note: <span className="text-[color:var(--color-fg,inherit)]">{req.deskNote}</span>
        </p>
      ) : null}
      {req.status === "accepted" ? null : (
        <p className="mt-4 text-[color:var(--color-muted)]">
          {direct ? "To change it, use your calendar." : "This request cannot be changed here. Anything further happens by phone."}
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="text-[13px] font-bold tracking-[0.06em] text-[color:var(--color-muted)] uppercase">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function Shell({ clinicName, children }: { clinicName?: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        healdesk{clinicName ? ` · ${clinicName}` : ""}
      </p>
      {children}
    </main>
  );
}
