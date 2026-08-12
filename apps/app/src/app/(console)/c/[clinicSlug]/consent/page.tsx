import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { consentRecords, contactAttempts, suppressions } from "@/db/schema";
import { resolveTenantContext } from "@/lib/session";
import { TenantAccessError, withTenant } from "@/lib/tenant";

import { ClinicNav } from "../ClinicNav";

/**
 * The consent and suppression ledger.
 *
 * This is the page you open when a TCPA letter arrives. It has to answer three
 * questions in one screen: do we hold consent for this number, what exactly did
 * they agree to, and has anyone asked us to stop.
 *
 * Phone numbers are shown in full and deliberately so — a redacted ledger
 * cannot answer the question it exists for. That is why this page is inside the
 * tenant boundary, behind auth, and audited on every view.
 */

export const dynamic = "force-dynamic";

export default async function ConsentPage({
  params,
}: {
  params: Promise<{ clinicSlug: string }>;
}) {
  const { clinicSlug } = await params;

  let context;
  try {
    context = await resolveTenantContext(clinicSlug);
  } catch (error) {
    if (error instanceof TenantAccessError) {
      redirect(`/sign-in?next=/c/${clinicSlug}/consent`);
    }
    throw error;
  }

  const data = await withTenant(context, async (tx) => {
    const consents = await tx.db
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.clinicId, context.clinicId))
      .orderBy(desc(consentRecords.grantedAt))
      .limit(100);

    const stops = await tx.db
      .select()
      .from(suppressions)
      .where(eq(suppressions.clinicId, context.clinicId))
      .orderBy(desc(suppressions.requestedAt))
      .limit(100);

    const attempts = await tx.db
      .select()
      .from(contactAttempts)
      .where(eq(contactAttempts.clinicId, context.clinicId))
      .orderBy(desc(contactAttempts.attemptedAt))
      .limit(50);

    tx.audit.record({
      action: "read",
      resourceType: "consent_record",
      resultCount: consents.length,
      metadata: { view: "consent-ledger" },
    });

    return { consents, stops, attempts };
  });

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <a href="/" className="text-sm font-semibold text-[color:var(--color-muted)]">
        ← All clinics
      </a>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        Consent &amp; suppression
      </h1>
      <ClinicNav slug={clinicSlug} active="consent" />

      <p className="mt-6 max-w-[62ch] text-sm text-[color:var(--color-muted)]">
        The consent ledger is the artifact that decides a TCPA case — damages run
        $500–1,500 per call with no cap. What matters is not that consent exists
        but that we can produce it, its source, and the exact words agreed to.
      </p>

      {/* ---------------- Suppression ---------------- */}
      <section className="mt-10">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Do not contact ({data.stops.length})
        </h2>
        <p className="mt-2 text-sm text-[color:var(--color-muted)]">
          Outranks every consent record. A blank channel means all channels.
        </p>

        {data.stops.length === 0 ? (
          <p className="mt-4 text-sm text-[color:var(--color-muted)]">
            Nobody has asked to stop.
          </p>
        ) : (
          <Table
            head={["Number", "Channel", "Reason", "When"]}
            rows={data.stops.map((s) => [
              s.phone,
              s.channel ?? "all channels",
              s.reason,
              s.requestedAt.toISOString().slice(0, 10),
            ])}
          />
        )}
      </section>

      {/* ---------------- Consent ---------------- */}
      <section className="mt-12">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Consent on file ({data.consents.length})
        </h2>

        {data.consents.length === 0 ? (
          <p className="mt-4 text-sm text-[color:var(--color-muted)]">
            No consent recorded. Nothing outbound can be sent.
          </p>
        ) : (
          <div className="mt-4 grid gap-3">
            {data.consents.map((c) => (
              <div
                key={c.id}
                className="rounded-2xl border border-[color:var(--color-line)] bg-white p-5"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold">{c.phone}</span>
                  <span className="rounded-full bg-[color:var(--color-paper-2)] px-2.5 py-1 text-[11px] font-bold uppercase">
                    {c.channel}
                  </span>
                  <span
                    className={[
                      "rounded-full px-2.5 py-1 text-[11px] font-bold uppercase",
                      c.consentType === "express_written"
                        ? "bg-[color:var(--color-ink)]/[0.06]"
                        : "bg-[color:var(--color-paper-2)] text-[color:var(--color-muted)]",
                    ].join(" ")}
                  >
                    {c.consentType.replace("_", " ")}
                  </span>
                  {c.revokedAt ? (
                    <span className="rounded-full bg-[color:var(--color-red)]/10 px-2.5 py-1 text-[11px] font-bold text-[color:var(--color-red)] uppercase">
                      revoked
                    </span>
                  ) : null}
                  <span className="ml-auto text-[color:var(--color-muted)]">
                    {c.source} · {c.grantedAt.toISOString().slice(0, 10)}
                  </span>
                </div>

                {/* The exact wording is the whole point. "They ticked a box"
                    is not a defence; the text they saw is. */}
                <blockquote className="mt-3 border-l-2 border-[color:var(--color-line-strong)] pl-3 text-sm text-[color:var(--color-muted)] italic">
                  {c.exactWording}
                </blockquote>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---------------- Attempts ---------------- */}
      <section className="mt-12">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Recent outbound attempts
        </h2>
        <p className="mt-2 text-sm text-[color:var(--color-muted)]">
          What proves the frequency caps were respected: at most 1 per day and 3
          per week per patient, which are conditions of the healthcare exemption
          rather than guidance.
        </p>

        {data.attempts.length === 0 ? (
          <p className="mt-4 text-sm text-[color:var(--color-muted)]">
            Nothing sent yet.
          </p>
        ) : (
          <Table
            head={["Number", "Channel", "Purpose", "When"]}
            rows={data.attempts.map((a) => [
              a.phone,
              a.channel,
              a.purpose,
              a.attemptedAt.toISOString().replace("T", " ").slice(0, 16),
            ])}
          />
        )}
      </section>
    </main>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-2xl border border-[color:var(--color-line)] bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[color:var(--color-line)]">
            {head.map((h) => (
              <th
                key={h}
                className="px-5 py-3 text-left text-[11px] font-bold tracking-[0.06em] text-[color:var(--color-muted)] uppercase"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className="border-b border-[color:var(--color-line)] last:border-0"
            >
              {row.map((cell, j) => (
                <td key={j} className="px-5 py-3 whitespace-nowrap">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
