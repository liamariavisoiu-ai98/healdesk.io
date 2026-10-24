"use client";

import { useState, useTransition } from "react";

import type { ConnectionState, ConnectLinkDelivery, IssueLinkOutcome, OpsResult } from "@/lib/admin/ops-client";

/**
 * The one-time connection link for the phase-two read-back credential,
 * behind a disclosure on the Setup tab (E1 §2, "Delete: the connect-link form
 * from the clinic card; keep the op; move it to Setup behind Phase two").
 * v1 reads nothing back from a booking system and reports no revenue, so
 * this matters to nobody until attribution is switched on, and it is one
 * click away rather than on every clinic's row.
 *
 * ## Why the token is never round-tripped
 *
 * The obvious implementations all persist it somewhere: a redirect with the
 * token in the query string (browser history, `Referer`, every access log in
 * the path), a flash cookie (a live credential at rest in the operator's cookie
 * jar, re-sent on every subsequent request to this origin), or a "show me that
 * link again" lookup, which requires having stored the token, which is the one
 * thing the issuing library exists not to do.
 *
 * So it lives in this component's state and nowhere else. Closing the panel
 * drops it, and it is then unrecoverable by anyone including us, which is why
 * the panel says so before the operator can close it.
 *
 * ## Why it never says "sent"
 *
 * The panel reports exactly what the mailer came back with. An operator who is
 * told the mail went out, and finds later that it did not, has already closed
 * the only copy of the link.
 */

export type IssueConnectLink = (clinicId: string, recipientEmail: string | null) => Promise<OpsResult<IssueLinkOutcome>>;

const STATE_WORDS: Record<ConnectionState, string> = {
  connected: "a credential is stored",
  outstanding: "a link is out, unused",
  none: "no credential and no link",
  unknown: "not checked on this read",
};

export function ConnectLink({ clinicId, connection, onIssue }: { clinicId: string; connection: ConnectionState | null; onIssue: IssueConnectLink }) {
  return (
    <details className="border-line mt-8 rounded-md border bg-white p-5">
      <summary className="cursor-pointer text-sm font-bold tracking-[0.08em] uppercase">Phase two: read-back connect link</summary>
      <p className="text-muted mt-3 text-sm">
        One page, once, for the clinic to hand over a read-only credential to its booking system. Not used in v1.
        {connection ? ` Today: ${STATE_WORDS[connection]}.` : ""}
      </p>
      <ConnectLinkControl clinicId={clinicId} connection={connection} onIssue={onIssue} />
    </details>
  );
}

function ConnectLinkControl({ clinicId, connection, onIssue }: { clinicId: string; connection: ConnectionState | null; onIssue: IssueConnectLink }) {
  const [issued, setIssued] = useState<Extract<IssueLinkOutcome, { status: "issued" }> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (issued) {
    return <IssuedPanel issued={issued} onDismiss={() => setIssued(null)} />;
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const to = String(new FormData(event.currentTarget).get("to") ?? "").trim();
        setProblem(null);
        startTransition(async () => {
          const result = await onIssue(clinicId, to === "" ? null : to);
          if (!result.ok) {
            setProblem(result.message);
            return;
          }
          if (result.data.status === "refused") {
            setProblem(result.data.message);
            return;
          }
          setIssued(result.data);
        });
      }}
      className="mt-4 flex flex-wrap items-end gap-3"
    >
      <label className="min-w-[220px] flex-1">
        <span className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">Email it to (optional)</span>
        <input
          name="to"
          type="email"
          autoComplete="off"
          placeholder="frontdesk@clinic.com"
          className="border-line focus:border-orange mt-1.5 w-full rounded-sm border bg-white px-3 py-2.5 text-sm"
        />
      </label>

      <button type="submit" disabled={pending} className="bg-ink rounded-full px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">
        {pending ? "Issuing…" : connection === "connected" || connection === "outstanding" ? "Issue another link" : "Issue connect link"}
      </button>

      {connection === "outstanding" ? (
        /* The issuing library leaves existing unused links alone on purpose:
           superseding one would kill a link a clinic may have open mid-wizard.
           Which means issuing again really does leave two live credentials, and
           saying so is the only thing this control can honestly do about it. */
        <p className="text-muted w-full text-xs">This clinic already has an unused link. Issuing another leaves both live until they are used or expire.</p>
      ) : null}

      {problem ? (
        <p role="status" className="text-red-deep w-full text-sm font-semibold">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

function IssuedPanel({ issued, onDismiss }: { issued: Extract<IssueLinkOutcome, { status: "issued" }>; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="border-orange/40 bg-orange/[0.06] mt-4 rounded-sm border p-4">
      <p className="text-sm font-bold">Copy this now, it cannot be shown again.</p>
      <p className="text-muted mt-1 text-sm">
        We store a hash of this link, not the link. Nobody, us included, can retrieve it once this panel is closed. If it
        is lost, issue another.
      </p>

      <div className="border-line mt-3 flex items-start gap-2 rounded-sm border bg-white px-3 py-2">
        {/* Selectable and wrapped rather than truncated: the clipboard API is
            absent on insecure origins, and this is the last chance to read it. */}
        <code className="min-w-0 flex-1 text-xs break-all select-all">{issued.url}</code>
        <button
          type="button"
          onClick={() => {
            // Only claim "Copied" if it actually copied. A button that lies
            // here leaves an operator pasting whatever they had before.
            navigator.clipboard
              ?.writeText(issued.url)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1_500);
              })
              .catch(() => undefined);
          }}
          className="bg-ink shrink-0 rounded-full px-3 py-1.5 text-xs font-bold text-white"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <p className="mt-3 text-sm">
        Works once. Expires <span className="font-semibold">{issued.expiresAt}</span>.
      </p>

      <p className="text-muted mt-1 text-sm">
        <DeliveryNote delivery={issued.delivery} />
      </p>

      {!issued.auditRecorded ? (
        <p className="text-red-deep mt-1 text-sm font-semibold">
          This issuance could not be written to the security log. The link is live regardless. Tell whoever keeps that
          log.
        </p>
      ) : null}

      <button type="button" onClick={onDismiss} className="border-line-strong hover:border-ink mt-3 rounded-full border px-4 py-2 text-sm font-bold transition-colors">
        I&rsquo;ve copied it. Discard.
      </button>
    </div>
  );
}

function DeliveryNote({ delivery }: { delivery: ConnectLinkDelivery }) {
  if (!delivery.attempted) return <>No email address given, so nothing was sent. Send it yourself.</>;
  if (delivery.status === "sent") return <>Emailed to the address you gave.</>;
  return (
    <>
      Not emailed ({delivery.status}): {delivery.reason} Send it yourself.
    </>
  );
}
