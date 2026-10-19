import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import {
  fetchSupportRequests,
  markSupportReplied,
  type SupportRequestView,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

/**
 * /admin/support: the portal support chat's escalations, and the mark that
 * each was replied to (WP5).
 *
 * An escalation emails hello@ (I3) and tells the practice, in L25, that a
 * person will reply by the next business day. The reply is an ordinary email
 * from hello@, so nothing records it unless the operator says so here. A
 * request past its day with no mark raises `support_reply_past_due` to ops,
 * once, and the 07:00 digest counts the ones still owed. The mark is a
 * security event on apps/app, through the ops API, and cannot be undone.
 *
 * What this page shows is ids, a topic code and dates, as the ops API sends
 * them: never the chat's words, which nobody keeps, and the clinic only as
 * its id and a link to its page in the console. Plain forms posting to a
 * server action, which checks the operator itself.
 */

export const metadata: Metadata = {
  title: "Support requests",
};

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESULTS: Record<string, string> = {
  marked: "Marked replied.",
  already: "That request was already marked replied.",
  not_found: "That request is not one the clinic made.",
  failed: "The mark could not be recorded. Reload and check before trying again.",
};

async function markReplied(formData: FormData): Promise<void> {
  "use server";
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const clinicId = String(formData.get("clinicId") ?? "");
  const requestId = String(formData.get("requestId") ?? "");
  if (!UUID.test(clinicId) || !UUID.test(requestId)) redirect("/admin/support?result=not_found");
  const outcome = await markSupportReplied(clinicId, requestId);
  revalidatePath("/admin/support");
  redirect(`/admin/support?result=${outcome.ok ? outcome.data.status : "failed"}`);
}

/** "7 Oct", the reply day as L25 named it. */
function day(isoDay: string): string {
  const [year, month, date] = isoDay.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(Date.UTC(year, month - 1, date, 12)));
}

/** "6 Oct, 14:07", New York time, where the reply day is counted. */
function when(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function Row({ request }: { request: SupportRequestView }) {
  return (
    <li className="border-line rounded-md border bg-white p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[15px] font-semibold">{request.requestId}</span>
        <span className="text-muted text-sm">
          {request.topic} · asked {when(request.askedAt)} · reply by {day(request.replyByOn)}
        </span>
      </div>
      <p className="text-muted mt-1 text-sm">
        Clinic{" "}
        {request.clinicSlug ? (
          <a className="underline" href={`/admin/ops/${request.clinicId}/care`}>
            {request.clinicId}
          </a>
        ) : (
          <span className="font-mono">{request.clinicId}</span>
        )}
      </p>
      {request.repliedAt ? (
        <p className="mt-2 text-sm font-semibold">Replied, marked {when(request.repliedAt)}</p>
      ) : (
        <form action={markReplied} className="mt-3 flex flex-wrap items-center gap-3">
          <input type="hidden" name="clinicId" value={request.clinicId} />
          <input type="hidden" name="requestId" value={request.requestId} />
          {request.pastDue ? (
            <span className="text-red-deep text-sm font-semibold">Past its reply day</span>
          ) : null}
          <button
            type="submit"
            className="border-line rounded-sm border px-3 py-1.5 text-sm font-semibold"
          >
            Mark replied
          </button>
        </form>
      )}
    </li>
  );
}

export default async function SupportRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string }>;
}) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { result } = await searchParams;
  const loaded = await fetchSupportRequests();
  if (!loaded.ok && isHostUnreachable(loaded)) return <HostStandbyPage title="Support requests" />;

  const owed = loaded.ok ? loaded.data.requests.filter((r) => !r.repliedAt) : [];
  const replied = loaded.ok ? loaded.data.requests.filter((r) => r.repliedAt) : [];

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">
        Support requests
      </h1>
      <p className="text-muted mt-3 max-w-[70ch] text-[15.6px]">
        Escalations from the portal&apos;s support chat in the last 30 days. Each practice was told
        a person would reply by the day shown. Reply from hello@, then mark it here: one still
        unmarked after its day alerts ops.
      </p>

      {result && RESULTS[result] ? (
        <p
          className="border-line mt-6 rounded-sm border bg-white px-4 py-3 text-[15.6px] font-semibold"
          role="status"
        >
          {RESULTS[result]}
        </p>
      ) : null}

      {!loaded.ok ? (
        <p className="text-red-deep mt-6 text-[15.6px] font-semibold">{loaded.message}</p>
      ) : (
        <>
          {loaded.data.unreadClinics > 0 ? (
            <p className="text-red-deep mt-6 text-[15.6px] font-semibold">
              {loaded.data.unreadClinics} clinic(s) could not be read, so their requests are missing
              below.
            </p>
          ) : null}
          <h2 className="mt-8 text-[19.2px] font-bold">Waiting for a reply ({owed.length})</h2>
          {owed.length === 0 ? (
            <p className="text-muted mt-3 text-[15.6px]">Nothing is waiting.</p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {owed.map((r) => (
                <Row key={`${r.clinicId}:${r.requestId}`} request={r} />
              ))}
            </ul>
          )}
          <h2 className="mt-8 text-[19.2px] font-bold">Replied ({replied.length})</h2>
          {replied.length === 0 ? null : (
            <ul className="mt-3 grid gap-3">
              {replied.map((r) => (
                <Row key={`${r.clinicId}:${r.requestId}`} request={r} />
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
