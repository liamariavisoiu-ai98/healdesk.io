import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { connectRequestContext } from "@/app/connect/[token]/request-context";
import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { PLATFORM_LABEL, resolveBookingRequest, type ResolvedBookingRequest } from "@/lib/meta/booking-requests";

import { DecideForm } from "./DecideForm";

/**
 * The desk's view of one booking request, and the one place it is decided.
 *
 * A practice never logs into anything. When the Meta assistant has collected
 * a first name, a number and a preferred window, the desk is emailed a link
 * to this page; the token in the path is the whole of the authentication,
 * exactly as it is for /connect/[token]. Expired, unknown and malformed
 * tokens are one redirect to /booking/invalid, so a stale URL confirms
 * nothing about which requests exist.
 *
 * This page does show patient details — a name, a number, a preferred day —
 * because that is what the desk needs in order to call. It lives in
 * apps/app, the PHI side, is served over the BAA-covered host, and is never
 * indexed. The email that carried the link named none of it.
 *
 * A decided request still renders, read-only, with its outcome: a second
 * click on the same email should show what happened, not a dead end.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Booking request",
  description: "A booking request from a patient, for the front desk to accept or decline.",
  robots: { index: false, follow: false },
};

export default async function BookingRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ followup?: string }>;
}) {
  const { token } = await params;
  const { followup } = await searchParams;
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

  const when = req.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  return (
    <Shell clinicName={req.clinicName}>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight sm:text-3xl">
        {req.status === "requested" ? "A patient would like to book" : `Request ${req.status}`}
      </h1>
      <p className="mt-4 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
        Sent from {PLATFORM_LABEL[req.platform]} on {when}. The assistant took these three things and nothing else; it did not
        ask why they are visiting. Nothing is booked until you call them.
      </p>

      <dl className="mt-6 grid gap-3 rounded-2xl border border-[color:var(--color-line)] p-5 text-[15px]">
        <Row label="First name" value={req.firstName ?? "—"} />
        <Row label="Phone" value={req.phone ?? "—"} />
        <Row label="Preferred day or time" value={req.preferredWindow} />
      </dl>

      {req.status === "requested" ? (
        <>
          <p className="mt-6 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
            Accept if you can see them around that time and will call to confirm. Decline if you can&apos;t offer that window
            — they&apos;ll be told you will call to find another. Either way, the message they get names no time and no
            provider; you do that on the phone.
          </p>
          <DecideForm token={token} />
        </>
      ) : (
        <Decided req={req} followup={followup ?? null} />
      )}
    </Shell>
  );
}

function Decided({ req, followup }: { req: ResolvedBookingRequest; followup: string | null }) {
  const when = req.decidedAt?.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const relayed =
    followup === "sent"
      ? "They have been told you will call."
      : followup === "failed"
        ? "We could not reach them on the channel just now — please call them directly."
        : followup === "no-channel"
          ? "The channel this came from is no longer connected, so please call them directly."
          : null;
  return (
    <div className="mt-6 rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-surface,transparent)] p-5 text-[15px]">
      <p className="font-medium">
        {req.status === "accepted" ? "Accepted" : req.status === "declined" ? "Declined" : "Expired"}
        {when ? ` on ${when}` : ""}
        {req.decidedByLabel ? ` by ${req.decidedByLabel}` : ""}.
      </p>
      {relayed ? <p className="mt-2 text-[color:var(--color-muted)]">{relayed}</p> : null}
      {req.deskNote ? (
        <p className="mt-2 text-[color:var(--color-muted)]">
          Your note: <span className="text-[color:var(--color-fg,inherit)]">{req.deskNote}</span>
        </p>
      ) : null}
      <p className="mt-4 text-[color:var(--color-muted)]">This request cannot be changed here. Anything further happens by phone.</p>
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
