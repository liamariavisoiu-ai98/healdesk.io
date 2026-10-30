import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { Failure, Section } from "@/components/admin/ui";
import { requireOperator } from "@/lib/admin/operator";
import { fetchSupportRequests, markSupportReplied, type SupportRequestView } from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

/**
 * Queues › Support: the portal support chat's escalations, and the mark that
 * each was replied to (WP5). Until the admin redesign (23 October 2026) this
 * was /admin/support, which redirects here.
 *
 * An escalation emails hello@ (I3) and tells the practice, in L25, that a
 * person will reply by the next business day. The reply is an ordinary email
 * from hello@, so nothing records it unless the operator says so here. A
 * request past its day with no mark raises `support_reply_past_due` to ops,
 * once, and the 07:00 digest counts the ones still owed. The mark is a
 * security event on apps/app, through the ops API, and cannot be undone.
 *
 * Since the support console (lane P7d) a chat escalation opens a case, and
 * the case is the promise: it is on /admin/support, and the list here is only
 * the requests with no case (apps/app's listSupportRequests leaves the cased
 * ones out). The mark below still works for those.
 *
 * What this shows is ids, a topic code and dates, as the ops API sends them:
 * never the chat's words, which nobody keeps, and the clinic only as its id
 * and a link to its panel. Plain forms posting to a server action, which
 * checks the operator itself. The outcome comes back in `?support=`, so it
 * cannot be mistaken for another section's.
 */

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
  if (!UUID.test(clinicId) || !UUID.test(requestId)) redirect("/admin/queues?support=not_found#support");
  const outcome = await markSupportReplied(clinicId, requestId);
  revalidatePath("/admin/queues");
  redirect(`/admin/queues?support=${outcome.ok ? outcome.data.status : "failed"}#support`);
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
        <span className="font-mono text-sm font-semibold">{request.requestId}</span>
        <span className="text-muted text-sm">
          {request.topic} · asked {when(request.askedAt)} · reply by {day(request.replyByOn)}
        </span>
      </div>
      <p className="text-muted mt-1 text-sm">
        Clinic{" "}
        {request.clinicSlug ? (
          <a className="underline" href={`/admin/clinics/${request.clinicId}/care`}>
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

export default async function SupportSection({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { result } = await searchParams;
  const loaded = await fetchSupportRequests();

  const owed = loaded.ok ? loaded.data.requests.filter((r) => !r.repliedAt) : [];
  const replied = loaded.ok ? loaded.data.requests.filter((r) => r.repliedAt) : [];

  return (
    <Section id="support" title={`Support${loaded.ok ? ` (${owed.length} owed)` : ""}`}>
      {result && RESULTS[result] ? (
        <p className="border-line mt-2 rounded-sm border bg-white px-4 py-3 text-sm font-semibold" role="status">
          {RESULTS[result]}
        </p>
      ) : null}

      <p className="text-muted mt-2 text-sm">
        Chat requests that opened a support case are worked on the{" "}
        <a className="underline" href="/admin/support">
          Support page
        </a>
        . Only requests with no case are listed here.
      </p>

      {isHostUnreachable(loaded) ? (
        <HostStandbyNotice what="The support requests" />
      ) : !loaded.ok ? (
        <Failure failure={loaded} what="the support requests" />
      ) : (
        <>
          {loaded.data.unreadClinics > 0 ? (
            <p className="text-red-deep mt-2 text-sm font-semibold">
              {loaded.data.unreadClinics} clinic(s) could not be read, so their requests are missing
              below.
            </p>
          ) : null}
          <h3 className="mt-4 text-base font-bold">Waiting for a reply ({owed.length})</h3>
          {owed.length === 0 ? (
            <p className="text-muted mt-2 text-sm">Nothing is waiting.</p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {owed.map((r) => (
                <Row key={`${r.clinicId}:${r.requestId}`} request={r} />
              ))}
            </ul>
          )}
          <h3 className="mt-6 text-base font-bold">Replied ({replied.length})</h3>
          {replied.length === 0 ? null : (
            <ul className="mt-3 grid gap-3">
              {replied.map((r) => (
                <Row key={`${r.clinicId}:${r.requestId}`} request={r} />
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}
