import { Empty, Failure, Section } from "@/components/admin/ui";
import type { CareView, ClinicBillingView, OpsResult } from "@/lib/admin/ops-client";

import { SETUP_REMINDER_KIND } from "./Reminders";

/**
 * The Deliveries tab's ledgers other than the transcripts (E1 step 7): what
 * was emailed to the clinic and whether it arrived, which until the admin
 * redesign (23 October 2026) was spread over three pages as "What was sent"
 * (Care), "Billing emails" and "Status history" (Billing), beside the
 * transcript receipts. One tab, one kind filter.
 *
 * Receipts without words, everywhere: a kind, a period, a status, a time, an
 * attempt count, and for the clinic's own reports the staff address the
 * clinic gave us (business contact data, as the Care tab already showed it).
 * No email body, no patient, no conversation text.
 *
 * The reminders are the lifecycle watch's ledger (Reminders.tsx, from
 * `listLifecycleWaves`): the clinic's six setup reminders and every wave to
 * ops, with delivered or bounced per wave. The `setup_reminder` notices the
 * outbox holds for the same sends are kept out of "Billing emails" so a
 * reminder is listed once. Status history is not an email, but it is the
 * billing engine's own ledger of what changed, and it belongs beside the
 * mail each change sent.
 */

export const DELIVERY_KINDS = [
  { id: "all", label: "All" },
  { id: "transcripts", label: "Transcripts" },
  { id: "reports", label: "Reports and alerts" },
  { id: "billing", label: "Billing emails" },
  { id: "reminders", label: "Reminders" },
  { id: "status", label: "Status history" },
] as const;

export type DeliveryKind = (typeof DELIVERY_KINDS)[number]["id"];

export function deliveryKind(raw: string | string[] | undefined): DeliveryKind {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return DELIVERY_KINDS.some((k) => k.id === value) ? (value as DeliveryKind) : "all";
}

export function shows(filter: DeliveryKind, kind: Exclude<DeliveryKind, "all">): boolean {
  return filter === "all" || filter === kind;
}

export function DeliveryFilters({ clinicId, current, days }: { clinicId: string; current: DeliveryKind; days: number }) {
  return (
    <nav aria-label="Delivery kinds" className="mt-4 flex flex-wrap gap-2">
      {DELIVERY_KINDS.map((k) => {
        const on = k.id === current;
        const query = new URLSearchParams();
        if (k.id !== "all") query.set("kind", k.id);
        if (days !== 30) query.set("days", String(days));
        const qs = query.toString();
        return (
          <a
            key={k.id}
            href={`/admin/clinics/${clinicId}/deliveries${qs ? `?${qs}` : ""}`}
            aria-current={on ? "page" : undefined}
            className={`inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm font-semibold transition-colors ${
              on ? "border-ink bg-ink text-white" : "border-line-strong hover:border-ink"
            }`}
          >
            {k.label}
          </a>
        );
      })}
    </nav>
  );
}

const TH = "py-1 pr-3";

function Reports({ deliveries }: { deliveries: CareView["deliveries"] }) {
  if (deliveries.length === 0) return <Empty>No reports or alerts sent yet. The first weekly recap goes seven days after go-live.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Reports and alerts sent to the clinic, newest first</caption>
        <thead className="text-muted text-left text-xs uppercase">
          <tr>
            <th scope="col" className={TH}>When (UTC)</th>
            <th scope="col" className={TH}>Kind</th>
            <th scope="col" className={TH}>Period</th>
            <th scope="col" className={TH}>To</th>
            <th scope="col" className={TH}>Status</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d, i) => (
            <tr key={i} className="border-line border-t">
              <td className="py-1 pr-3 whitespace-nowrap">{d.attemptedAt}</td>
              <td className="py-1 pr-3">{d.kind}</td>
              <td className="py-1 pr-3">{d.periodKey}</td>
              <td className="py-1 pr-3">{d.recipient}</td>
              <td className={`py-1 pr-3 ${d.status === "sent" ? "text-done" : d.status === "failed" ? "text-red-deep" : "text-muted"}`}>
                {d.status}
                {d.reason && d.status !== "sent" ? <span className="text-muted block text-xs">{d.reason}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Notices({ notices, empty }: { notices: ClinicBillingView["notices"]; empty: string }) {
  if (notices.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Emails queued by the billing engine, newest first</caption>
        <thead className="text-muted text-left text-xs uppercase">
          <tr>
            <th scope="col" className={TH}>Queued (UTC)</th>
            <th scope="col" className={TH}>Kind</th>
            <th scope="col" className={TH}>Sent</th>
            <th scope="col" className={TH}>Attempts</th>
          </tr>
        </thead>
        <tbody>
          {notices.map((n, i) => (
            <tr key={i} className="border-line border-t">
              <td className="py-1 pr-3 whitespace-nowrap">{n.createdAt}</td>
              <td className="py-1 pr-3">{n.kind}</td>
              <td className={`py-1 pr-3 ${n.sentAt ? "text-done" : "text-muted"}`}>
                {n.sentAt ? `${n.sentAt}${n.recipientsCount !== null ? ` (${n.recipientsCount})` : ""}` : `due ${n.sendAfter}`}
                {n.lastError ? <span className="text-muted block text-xs">{n.lastError}</span> : null}
              </td>
              <td className="py-1 pr-3">{n.attempts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Transitions({ transitions }: { transitions: ClinicBillingView["transitions"] }) {
  if (transitions.length === 0) return <Empty>No status change recorded.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Billing status changes, newest first</caption>
        <thead className="text-muted text-left text-xs uppercase">
          <tr>
            <th scope="col" className={TH}>When (UTC)</th>
            <th scope="col" className={TH}>Change</th>
            <th scope="col" className={TH}>By</th>
            <th scope="col" className={TH}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {transitions.map((t, i) => (
            <tr key={i} className="border-line border-t">
              <td className="py-1 pr-3 whitespace-nowrap">{t.at}</td>
              <td className="py-1 pr-3">{t.fromStatus === t.toStatus ? "note" : `${t.fromStatus ?? "—"} → ${t.toStatus}`}</td>
              <td className="py-1 pr-3">{t.actor}</td>
              <td className="py-1 pr-3">{t.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


/** The three non-transcript ledgers, each shown under the filter and each saying its own failure. */
export function DeliveriesLedger({
  filter,
  care,
  billing,
}: {
  filter: DeliveryKind;
  care: OpsResult<CareView>;
  billing: OpsResult<ClinicBillingView>;
}) {
  const other = billing.ok ? billing.data.notices.filter((n) => n.kind !== SETUP_REMINDER_KIND) : [];
  return (
    <>
      {shows(filter, "reports") ? (
        <Section id="reports" title={`Reports and alerts${care.ok ? ` — last ${care.data.deliveries.length}` : ""}`}>
          {care.ok ? <Reports deliveries={care.data.deliveries} /> : <Failure failure={care} what="the reports sent" />}
        </Section>
      ) : null}
      {shows(filter, "billing") ? (
        <Section id="billing-emails" title={`Billing emails${billing.ok ? ` — last ${other.length}` : ""}`}>
          {billing.ok ? <Notices notices={other} empty="No billing email queued yet." /> : <Failure failure={billing} what="the billing emails" />}
        </Section>
      ) : null}
      {shows(filter, "status") ? (
        <Section id="status-history" title={`Status history${billing.ok ? ` — last ${billing.data.transitions.length}` : ""}`}>
          {billing.ok ? <Transitions transitions={billing.data.transitions} /> : <Failure failure={billing} what="the status history" />}
        </Section>
      ) : null}
    </>
  );
}
