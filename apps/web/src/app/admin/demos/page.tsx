import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireOperator } from "@/lib/admin/operator";
import { isEmailConfigured } from "@/lib/email";
import { demoUrl, displayName, isDemoExpired, listDemoSessions, profileOf, type DemoSession } from "@/lib/demo/sessions";
import { isMarketingStoreConfigured } from "@/lib/sheets/client";

import { emailDemoAction, retryDemoAction } from "./actions";
import { CopyLink, DemoBuilder, RefreshWhileAnyBuilding } from "./DemoBuilder";

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
  if (session.status === "building") return { label: "Building…", tone: "bg-tint-butter" };
  if (session.status === "failed") return { label: "Failed", tone: "bg-tint-peach" };
  if (isDemoExpired(session)) return { label: "Expired", tone: "bg-paper-2" };
  return { label: "Live", tone: "bg-tint-sky" };
}

export default async function DemosPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");

  const configured = isMarketingStoreConfigured();
  let sessions: DemoSession[] = [];
  let loadError: string | null = null;
  if (configured) {
    try {
      sessions = await listDemoSessions(50);
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
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
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
      <RefreshWhileAnyBuilding active={sessions.some((s) => s.status === "building")} />
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">Demos</h1>
      <p className="text-muted mt-2 max-w-[70ch] text-[15.6px]">
        When a prospect asks for the AI demo, paste their website here. You get a private link to a page where their clinic&rsquo;s voice
        agent and website chat sit side by side, built from their own site, live for seven days.
      </p>

      {!configured ? (
        <p className="bg-tint-peach mt-6 rounded-2xl px-4 py-3 text-[15px] font-medium">
          The marketing Sheet is not configured, so demos have nowhere to live. Set <code className="font-mono">MARKETING_SHEET_ID</code> and{" "}
          <code className="font-mono">GOOGLE_SERVICE_ACCOUNT_JSON</code>.
        </p>
      ) : null}
      {missing.length > 0 ? (
        <div className="bg-tint-butter mt-6 rounded-2xl px-4 py-3 text-[14.4px] font-medium">
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

      <h2 className="font-display mt-10 text-[22px] font-semibold tracking-[-0.01em]">Recent demos</h2>
      {loadError ? <p className="text-red-deep mt-2 text-[15px] font-semibold">Couldn&rsquo;t read the register: {loadError}</p> : null}
      {configured && !loadError && sessions.length === 0 ? <p className="text-muted mt-2 text-[15px]">None yet.</p> : null}

      <ul className="mt-3 space-y-3">
        {sessions.map((session) => {
          const status = statusOf(session);
          const profile = profileOf(session);
          return (
            <li key={session.id} className="border-line rounded-2xl border bg-white px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[16.8px] font-semibold">{displayName(session)}</span>
                <span className={`rounded-full px-2.5 py-0.5 text-[12.6px] font-bold ${status.tone}`}>{status.label}</span>
                <a href={session.websiteUrl} target="_blank" rel="noreferrer" className="text-muted truncate text-[14.4px] underline-offset-2 hover:underline">
                  {session.websiteUrl.replace(/^https?:\/\//, "")}
                </a>
              </div>
              <p className="text-muted mt-1 text-[13.8px]">
                {session.leadEmail ?? "no email"} · created {when(session.createdAt)} by {session.createdBy ?? "?"} · expires {when(session.expiresAt)}
                {session.emailSentAt ? ` · emailed ${when(session.emailSentAt)}` : ""}
                {profile ? ` · ${profile.services.length} services, ${profile.faqs.length} FAQs` : ""}
                {session.scrapeSource ? ` · via ${session.scrapeSource}` : ""}
              </p>
              {session.buildNote ? <p className="mt-1.5 text-[14.4px] font-medium">{session.buildNote}</p> : null}
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                <a href={demoUrl(session.slug)} target="_blank" rel="noreferrer" className="text-red-deep hover:text-red text-[14.4px] font-bold">
                  Open
                </a>
                <CopyLink url={demoUrl(session.slug)} />
                {session.status === "ready" && session.leadEmail && !isDemoExpired(session) ? (
                  <form action={emailDemoAction}>
                    <input type="hidden" name="slug" value={session.slug} />
                    <button type="submit" className="text-red-deep hover:text-red text-[14.4px] font-bold">
                      {session.emailSentAt ? "Email again" : "Email the link"}
                    </button>
                  </form>
                ) : null}
                {session.status !== "building" ? (
                  <form action={retryDemoAction}>
                    <input type="hidden" name="slug" value={session.slug} />
                    <button type="submit" className="text-muted hover:text-ink text-[14.4px] font-bold">
                      {session.status === "failed" ? "Retry build" : "Rebuild from the site"}
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
