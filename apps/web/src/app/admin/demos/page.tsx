import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DemoPipelineRow } from "@/components/admin/DemoPipelineRow";
import { requireOperator } from "@/lib/admin/operator";
import { isEmailConfigured } from "@/lib/email";
import { AUDIT_THRESHOLDS, auditReportOf, type AuditIssue } from "@/lib/demo/audit";
import { handoffBlocker } from "@/lib/demo/build";
import { demoPipeline } from "@/lib/demo/pipeline";
import { closeFunnel, type CloseFunnelRow, listDemoEvents } from "@/lib/demo/events";
import {
  demoUrl,
  displayName,
  isDemoBuildStalled,
  isDemoExpired,
  listDemoSessions,
  profileOf,
  type DemoSession,
} from "@/lib/demo/sessions";
import { isMarketingStoreConfigured } from "@/lib/sheets/client";

import { emailDemoAction, releaseDemoAction, retryDemoAction, retryStalledDemosAction } from "./actions";
import { CopyLink, CopyValue, DemoBuilder, RefreshWhileAnyBuilding } from "./DemoBuilder";

/**
 * /admin/demos, the personalised demo builder.
 *
 * The step after a prospect replies "yes, send it over": paste their website,
 * get a private link to a demo that answers as their clinic, with the voice
 * agent and the website chat side by side (app/demo/[slug]). The same build
 * can be triggered by automation through POST /api/demo-sessions.
 *
 * The list below the form is the `demo_sessions` tab of the marketing Sheet,
 * newest first: what is building, what is live and until when, what failed
 * and why, whether the link was emailed, and which demos turned into a sale.
 * Above it, one strip counts the same tab over the last 7 and 30 days
 * (lib/demo/pipeline.ts): requested, built, claimed and the conversion by
 * where the request came from. The page reads the tab once for both; the
 * strip counts every row, as the stall sweep reads every row, and the list
 * shows the newest 50.
 *
 * Every demo passes the handoff audit (lib/demo/audit.ts) before it goes
 * live. A held one shows the audit's blockers here, and "Release anyway"
 * ships it on the operator's own judgement, recorded on the row.
 */

export const metadata: Metadata = { title: "Demos" };
export const dynamic = "force-dynamic";
/** Server actions on this page start builds that run after they return; this bounds them. */
export const maxDuration = 300;

function when(date: Date | null): string {
  if (!date) return "—";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

function statusOf(session: DemoSession): { label: string; tone: string } {
  if (session.claimed) return { label: `Claimed${session.claimedPlan ? ` · ${session.claimedPlan}` : ""}`, tone: "bg-tint-mint" };
  if (isDemoBuildStalled(session)) return { label: "Stalled", tone: "bg-tint-peach" };
  if (session.status === "building") return { label: "Building…", tone: "bg-tint-butter" };
  if (session.status === "auditing") return { label: "Auditing…", tone: "bg-tint-butter" };
  if (session.status === "held") return { label: "Held for review", tone: "bg-tint-peach" };
  if (session.status === "failed") return { label: "Failed", tone: "bg-tint-peach" };
  if (isDemoExpired(session)) return { label: "Expired", tone: "bg-paper-2" };
  if (session.auditVerdict === "flagged") return { label: "Live · flagged", tone: "bg-tint-sky" };
  if (session.auditVerdict === "released") return { label: "Live · released", tone: "bg-tint-sky" };
  return { label: "Live", tone: "bg-tint-sky" };
}

function isRunning(session: DemoSession): boolean {
  return (session.status === "building" || session.status === "auditing") && !isDemoBuildStalled(session);
}

function Issue({ issue }: { issue: AuditIssue }) {
  return (
    <li>
      <span className="font-semibold">{issue.where}:</span> {issue.problem}
      {issue.evidence ? <span className="text-muted"> &ldquo;{issue.evidence.slice(0, 220)}&rdquo;</span> : null}
    </li>
  );
}

/** The audit's verdict on one demo: the score, what blocks it, what to fix. */
function AuditSummary({ session }: { session: DemoSession }) {
  const report = auditReportOf(session.auditReport);
  if (!report) return null;
  const fixes = report.findings.filter((f) => f.severity === "fix");
  return (
    <details className="mt-2 text-xs" open={session.status === "held"}>
      <summary className="cursor-pointer font-semibold">
        Audit {report.overall}/100
        {report.blockers.length > 0 ? ` · ${report.blockers.length} blocker${report.blockers.length === 1 ? "" : "s"}` : ""}
        {fixes.length > 0 ? ` · ${fixes.length} to fix` : ""}
        {report.previous ? ` · repaired from ${report.previous.overall}` : ""}
      </summary>
      {report.summary ? <p className="mt-1.5">{report.summary}</p> : null}
      <p className="text-muted mt-1.5">
        {Object.entries(report.scores)
          .map(([d, n]) => `${d} ${n}`)
          .join(" · ")}
      </p>
      {report.blockers.length > 0 ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-5">
          {report.blockers.slice(0, 6).map((b, i) => (
            <Issue key={i} issue={b} />
          ))}
        </ul>
      ) : null}
      {fixes.length > 0 ? (
        <ul className="text-muted mt-1.5 list-disc space-y-1 pl-5">
          {fixes.slice(0, 6).map((f, i) => (
            <Issue key={i} issue={f} />
          ))}
        </ul>
      ) : null}
    </details>
  );
}

export default async function DemosPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");

  const configured = isMarketingStoreConfigured();
  let sessions: DemoSession[] = [];
  let loadError: string | null = null;
  // Null until the register has been read: an unconfigured Sheet or a failed
  // read leaves the strip at em-dashes, never at zeros.
  let pipeline: ReturnType<typeof demoPipeline> | null = null;
  if (configured) {
    try {
      // The whole tab, which is what one read costs anyway (lib/demo/sessions.ts).
      const all = await listDemoSessions(Number.POSITIVE_INFINITY);
      pipeline = demoPipeline(all);
      sessions = all.slice(0, 50);
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  }

  // The two closes side by side (lib/demo/close.ts), over every demo the Sheet
  // still holds, not only the fifty listed below.
  let funnel: CloseFunnelRow[] | null = null;
  if (configured && !loadError) {
    try {
      const [all, events] = await Promise.all([listDemoSessions(1_000), listDemoEvents()]);
      funnel = closeFunnel(all, events);
    } catch {
      funnel = null;
    }
  }

  const missing = [
    !process.env.ANTHROPIC_API_KEY && "ANTHROPIC_API_KEY (reads the site into a profile)",
    !process.env.RETELL_API_KEY && "RETELL_API_KEY",
    !process.env.RETELL_CLINIC_DEMO_AGENT_ID && "RETELL_CLINIC_DEMO_AGENT_ID (npm run retell:clinic-demo -w @healdesk/web)",
    !process.env.RETELL_DEMO_FROM_NUMBER && "RETELL_DEMO_FROM_NUMBER (for “call me”)",
    !process.env.APIFY_TOKEN && "APIFY_TOKEN (optional: renders JavaScript-built sites)",
    !isEmailConfigured() && "RESEND_API_KEY / HEALDESK_EMAIL_FROM (to email the link)",
  ].filter(Boolean) as string[];

  return (
    <main className="mx-auto w-full max-w-page px-4 py-10 sm:px-8 lg:px-14">
      <RefreshWhileAnyBuilding active={sessions.some(isRunning)} />
      <h1 className="font-display text-2xl leading-tight font-semibold tracking-[-0.02em]">Demos</h1>
      <p className="text-muted mt-2 max-w-[70ch] text-sm">
        When a prospect asks for the AI demo, paste their website here. You get a private link to a page where their clinic&rsquo;s voice
        agent and website chat sit side by side, built from their own site, live for seven days.
      </p>
      <p className="text-muted mt-2 max-w-[70ch] text-xs">
        Claude Opus 5.5 audits every demo against the clinic&rsquo;s site before the link opens or is emailed. It ships at{" "}
        {AUDIT_THRESHOLDS.ship}/100 with no blockers, gets one repair round from {AUDIT_THRESHOLDS.repairFrom}, ships with a Slack flag from{" "}
        {AUDIT_THRESHOLDS.floor}, and is held for you below that or with any blocker.
      </p>

      <DemoPipelineRow pipeline={pipeline} retryStalled={retryStalledDemosAction} />
      {funnel ? <CloseReport rows={funnel} /> : null}

      {!configured ? (
        <p className="bg-tint-peach mt-6 rounded-md px-4 py-3 text-sm font-medium">
          The marketing Sheet is not configured, so demos have nowhere to live. Set <code className="font-mono">MARKETING_SHEET_ID</code> and{" "}
          <code className="font-mono">GOOGLE_SERVICE_ACCOUNT_JSON</code>.
        </p>
      ) : null}
      {missing.length > 0 ? (
        <div className="bg-tint-butter mt-6 rounded-md px-4 py-3 text-xs font-medium">
          <p className="font-semibold">Not set on this deployment:</p>
          <ul className="mt-1 list-disc pl-5">
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-6">
        <DemoBuilder />
      </div>

      <h2 className="font-display mt-10 text-xl font-semibold tracking-[-0.01em]">Recent demos</h2>
      {loadError ? <p className="text-red-deep mt-2 text-sm font-semibold">Couldn&rsquo;t read the register: {loadError}</p> : null}
      {configured && !loadError && sessions.length === 0 ? <p className="text-muted mt-2 text-sm">None yet.</p> : null}

      <ul className="mt-3 space-y-3">
        {sessions.map((session) => {
          const status = statusOf(session);
          const profile = profileOf(session);
          return (
            <li key={session.id} className="border-line rounded-md border bg-white px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-base font-semibold">{displayName(session)}</span>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${status.tone}`}>{status.label}</span>
                <a href={session.websiteUrl} target="_blank" rel="noreferrer" className="text-muted truncate text-xs underline-offset-2 hover:underline">
                  {session.websiteUrl.replace(/^https?:\/\//, "")}
                </a>
              </div>
              <p className="text-muted mt-1 text-xs">
                {session.leadEmail ?? "no email"} · created {when(session.createdAt)} by {session.createdBy ?? "?"} · expires {when(session.expiresAt)}
                {session.emailSentAt ? ` · emailed ${when(session.emailSentAt)}` : ""}
                {profile ? ` · ${profile.services.length} services, ${profile.faqs.length} FAQs` : ""}
                {session.scrapeSource ? ` · via ${session.scrapeSource}` : ""}
              </p>
              {/* A demo is not a clinic: it has no clinic id until someone buys and is provisioned, and this site has no database to look one up in. Its own id is what to quote here; the clinic's id is on its row under Clinics. */}
              {session.id ? (
                <p className="text-muted mt-1 text-xs">
                  <CopyValue label="Demo id" value={session.id} />
                  {session.claimed ? (
                    <>
                      {" "}
                      · bought: the clinic and its id are on{" "}
                      <a href="/admin/clinics" className="text-red-deep hover:text-red font-semibold underline underline-offset-2">
                        Clinics
                      </a>
                    </>
                  ) : null}
                </p>
              ) : null}
              {session.buildNote ? <p className="mt-1.5 text-xs font-medium">{session.buildNote}</p> : null}
              <AuditSummary session={session} />
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                <a href={demoUrl(session.slug)} target="_blank" rel="noreferrer" className="text-red-deep hover:text-red text-xs font-bold">
                  Open
                </a>
                <CopyLink url={demoUrl(session.slug)} />
                {handoffBlocker(session) === null && session.leadEmail && !isDemoExpired(session) ? (
                  <form action={emailDemoAction}>
                    <input type="hidden" name="slug" value={session.slug} />
                    <button type="submit" className="text-red-deep hover:text-red text-xs font-bold">
                      {session.emailSentAt ? "Email again" : "Email the link"}
                    </button>
                  </form>
                ) : null}
                {session.status === "held" && profile && !isDemoExpired(session) ? (
                  <form action={releaseDemoAction}>
                    <input type="hidden" name="slug" value={session.slug} />
                    <button type="submit" className="text-red-deep hover:text-red text-xs font-bold">
                      Release anyway
                    </button>
                  </form>
                ) : null}
                {!isRunning(session) ? (
                  <form action={retryDemoAction}>
                    <input type="hidden" name="slug" value={session.slug} />
                    <button type="submit" className="text-muted hover:text-ink text-xs font-bold">
                      {session.status === "failed" || isDemoBuildStalled(session) ? "Retry build" : "Rebuild and re-audit"}
                    </button>
                  </form>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

/**
 * Demo opened → "Activate my AYA" pressed → paid, for each close, counted by
 * demo (lib/demo/events.ts `closeFunnel`). Small numbers: read the paid
 * column as a count, not a rate, until there are dozens of demos in each.
 */
function CloseReport({ rows }: { rows: CloseFunnelRow[] }) {
  const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "—");
  return (
    <section className="border-line mt-6 rounded-md border bg-white p-5" aria-labelledby="close-report">
      <h2 id="close-report" className="text-base font-bold">
        Demo close: redesign against the old page
      </h2>
      <p className="text-muted mt-1 text-xs">
        Each demo shows one close, by its slug. Counted per demo, from the first time it was opened after 26 October 2026.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-xs tabular-nums">
          <thead className="text-muted text-xs font-bold tracking-[0.06em] uppercase">
            <tr>
              <th className="py-2 pr-4">Close</th>
              <th className="py-2 pr-4">Opened</th>
              <th className="py-2 pr-4">Pressed Activate</th>
              <th className="py-2 pr-4">Paid</th>
              <th className="py-2">First press from</th>
            </tr>
          </thead>
          <tbody className="divide-line divide-y">
            {rows.map((row) => (
              <tr key={row.variant}>
                <td className="py-2 pr-4 font-semibold">{row.variant === "close" ? "Redesign" : "Old page"}</td>
                <td className="py-2 pr-4">{row.viewed}</td>
                <td className="py-2 pr-4">
                  {row.clicked} <span className="text-muted">({pct(row.clicked, row.viewed)})</span>
                </td>
                <td className="py-2 pr-4">
                  {row.paid} <span className="text-muted">({pct(row.paid, row.viewed)})</span>
                </td>
                <td className="text-muted py-2">
                  {Object.entries(row.firstClickFrom)
                    .sort((a, b) => b[1] - a[1])
                    .map(([from, n]) => `${from} ${n}`)
                    .join(" · ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
