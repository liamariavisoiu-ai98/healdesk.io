"use client";

import { useState, useTransition } from "react";

import type { OpsResult, ResendTranscriptOutcome, TranscriptDeliveriesView } from "@/lib/admin/ops-client";
import { TRANSCRIPT_RESENDABLE, TRANSCRIPT_WINDOWS, type TranscriptStatus } from "@/lib/admin/transcript-status";

/** What each status means for the operator, in the words the owner would tell a clinic. */
export const LABELS: Record<TranscriptStatus, { name: string; note: string; tone: "ok" | "bad" | "plain" }> = {
  delivered: { name: "Delivered", note: "SES reported it delivered; our copy is deleted.", tone: "ok" },
  bounced: { name: "Bounced", note: "SES reported a bounce, rejection or complaint. We keep the copy and retry hourly; Send again brings the retry forward.", tone: "bad" },
  pending: { name: "Waiting to send", note: "Queued. A failed send is retried after growing waits, up to an hour apart, until SES accepts it.", tone: "plain" },
  sent: { name: "Sent, not confirmed", note: "Handed to SES; waiting for its delivery report.", tone: "plain" },
  open: { name: "Chat still going", note: "A web chat's transcript is emailed when it ends.", tone: "plain" },
  unconfirmed: { name: "Deleted unanswered", note: "SES accepted it but gave no delivery report for 72 hours, so the copy was deleted. The clinic may still have it.", tone: "bad" },
  expired: { name: "Deleted after 30 days", note: "Not delivered within 30 days, so the copy was deleted. Nothing is left to send.", tone: "bad" },
};

const ORDER: TranscriptStatus[] = ["bounced", "unconfirmed", "expired", "pending", "sent", "open", "delivered"];

const BUTTON = "border-line-strong rounded-full border px-3 py-1 text-xs font-bold disabled:opacity-50";

type Note = { tone: "ok" | "bad"; text: string } | null;

function when(iso: string | null): string {
  return iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "—";
}

function toneClass(tone: "ok" | "bad" | "plain"): string {
  return tone === "ok" ? "text-done" : tone === "bad" ? "text-red-deep" : "text-muted";
}

export function TranscriptsPanel({
  clinicId,
  days,
  view,
  resend,
}: {
  clinicId: string;
  days: number;
  view: OpsResult<TranscriptDeliveriesView>;
  resend: (conversationId: string) => Promise<OpsResult<ResendTranscriptOutcome>>;
}) {
  if (!view.ok) {
    return (
      <div className="py-6">
        <p role="alert" className="text-red-deep font-semibold">
          {view.code === "outdated"
            ? "The engine is older than this page and cannot report transcript receipts yet. Deploy the app, then reload."
            : view.message}
        </p>
        {view.code === "unauthenticated" ? (
          <a href="/admin/sign-in" className="mt-4 inline-block underline">
            Sign in
          </a>
        ) : null}
      </div>
    );
  }
  const v = view.data;
  const attention = v.counts.bounced + v.counts.unconfirmed + v.counts.expired;

  return (
    <div>
      <p className="text-muted mt-6 text-sm">
        Each finished call or chat is emailed to the clinic and our copy is deleted once SES reports it delivered. This
        is the receipt: no words, no address.
      </p>

      <nav aria-label="Time window" className="mt-4 flex gap-3 text-sm">
        {TRANSCRIPT_WINDOWS.map((w) => (
          <a
            key={w}
            href={`/admin/clinics/${clinicId}/deliveries?days=${w}`}
            aria-current={w === days ? "page" : undefined}
            className={w === days ? "font-bold underline" : "underline"}
          >
            {w} days
          </a>
        ))}
      </nav>

      <section className="border-line mt-6 rounded-md border bg-white p-5" aria-labelledby="receipts-counts">
        <h2 id="receipts-counts" className="text-[13.2px] font-bold tracking-[0.06em] uppercase">
          Last {v.sinceDays} days
        </h2>
        <p className={`mt-2 text-sm font-semibold ${attention > 0 ? "text-red-deep" : "text-done"}`}>
          {attention > 0
            ? `${attention} transcript${attention === 1 ? "" : "s"} bounced, went unconfirmed or expired.`
            : "Nothing bounced or went unconfirmed."}
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {ORDER.map((status) => (
            <div key={status}>
              <dt className={`text-xs ${toneClass(LABELS[status].tone)}`}>{LABELS[status].name}</dt>
              <dd className="text-lg font-semibold">{v.counts[status]}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="border-line mt-6 rounded-md border bg-white p-5" aria-labelledby="receipts-list">
        <h2 id="receipts-list" className="text-[13.2px] font-bold tracking-[0.06em] uppercase">
          Newest receipts
        </h2>
        {v.receipts.length === 0 ? (
          <p className="text-muted mt-3 text-sm">No transcripts were queued in this window.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Transcript receipts, newest first</caption>
              <thead className="text-muted text-left text-xs uppercase">
                <tr>
                  <th scope="col" className="py-1 pr-3">Conversation</th>
                  <th scope="col" className="py-1 pr-3">Status</th>
                  <th scope="col" className="py-1 pr-3">Sent</th>
                  <th scope="col" className="py-1 pr-3">Delivered</th>
                  <th scope="col" className="py-1 pr-3">Attempts</th>
                  <th scope="col" className="py-1 pr-3">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {v.receipts.map((r) => (
                  <ReceiptRow key={r.conversationId} receipt={r} resend={resend} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {v.receipts.length >= 50 ? (
          <p className="text-muted mt-3 text-xs">Only the newest 50 are listed; the counts above cover the whole window.</p>
        ) : null}
      </section>
    </div>
  );
}

function ReceiptRow({
  receipt,
  resend,
}: {
  receipt: TranscriptDeliveriesView["receipts"][number];
  resend: (conversationId: string) => Promise<OpsResult<ResendTranscriptOutcome>>;
}) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const label = LABELS[receipt.status];
  const canResend = TRANSCRIPT_RESENDABLE.includes(receipt.status);

  function onResend() {
    if (!window.confirm("Send this transcript to the clinic's address again?")) return;
    start(async () => {
      setNote(null);
      const result = await resend(receipt.conversationId);
      if (!result.ok) return setNote({ tone: "bad", text: result.message });
      const data = result.data;
      if (data.status === "refused") return setNote({ tone: "bad", text: data.message });
      if (data.status === "gone") {
        return setNote({ tone: "bad", text: "The copy is already deleted, so there is nothing left to send." });
      }
      setNote({
        tone: "ok",
        text: data.auditRecorded
          ? "Queued; it goes out within a minute."
          : "Queued, but the audit row could not be written. Note it down.",
      });
    });
  }

  return (
    <tr className="border-line border-t align-top">
      <td className="py-2 pr-3">
        <code className="text-xs break-all">{receipt.conversationId}</code>
      </td>
      <td className={`py-2 pr-3 ${toneClass(label.tone)}`}>
        <span className="font-semibold">{label.name}</span>
        <span className="text-muted block text-xs">{label.note}</span>
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">{when(receipt.sentAt)}</td>
      <td className="py-2 pr-3 whitespace-nowrap">{when(receipt.deliveredAt)}</td>
      <td className="py-2 pr-3">{receipt.attempts}</td>
      <td className="py-2 pr-3">
        {canResend ? (
          <button type="button" className={BUTTON} disabled={pending} onClick={onResend}>
            {pending ? "Working…" : "Send again"}
          </button>
        ) : null}
        {note ? (
          <p role="status" className={`mt-1 text-xs ${note.tone === "ok" ? "text-done" : "text-red-deep font-semibold"}`}>
            {note.text}
          </p>
        ) : null}
      </td>
    </tr>
  );
}
