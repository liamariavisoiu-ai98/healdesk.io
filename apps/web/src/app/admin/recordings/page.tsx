import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import {
  deleteRecordedCall,
  fetchRecordingAlerts,
  type RecordingAlertView,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

/**
 * /admin/recordings: calls whose data Retell still held after the deletion
 * window, the manual backstop to an automatic delete.
 *
 * Retell keeps each call's transcript, and with it the recording, until the
 * call has ended (the owner's decision of 21 October 2026). Once apps/app
 * has recorded the call, its transcript sealed in the outbox, the backstop
 * job deletes the call at Retell. A recording at Retell before that is
 * expected. Only a call Retell still holds 30 minutes after it ended, with
 * the automatic delete failing, becomes an alert here: the clinic, Retell's
 * call id and when. The button has apps/app, which alone holds the Retell
 * key, delete the call at Retell (its recording, transcript and logs), and
 * the alert resolves when Retell says it is gone; so does a later automatic
 * delete that goes through.
 *
 * What this page shows is ids, counts and times, as the ops API sends them:
 * never the recording or its address, which apps/app does not keep, and
 * never anything said on the call. Plain forms posting to a server action,
 * which checks the operator itself.
 */

export const metadata: Metadata = {
  title: "Retell deletions",
};

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESULTS: Record<string, string> = {
  deleted: "Deleted at Retell. The alert is resolved.",
  already: "That call was already deleted at Retell.",
  too_soon:
    "Not yet: the call is not recorded on our side, and the backstop may still read it. Try again after the time shown.",
  failed: "Retell did not delete it. The reason is on the alert; try again later.",
  not_found: "That alert is not one this clinic has.",
  error: "The delete could not be sent. Reload and check before trying again.",
};

async function deleteCall(formData: FormData): Promise<void> {
  "use server";
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const clinicId = String(formData.get("clinicId") ?? "");
  const alertId = String(formData.get("alertId") ?? "");
  if (!UUID.test(clinicId) || !UUID.test(alertId)) redirect("/admin/recordings?result=not_found");
  const outcome = await deleteRecordedCall(clinicId, alertId);
  revalidatePath("/admin/recordings");
  redirect(`/admin/recordings?result=${outcome.ok ? outcome.data.status : "error"}`);
}

/** "6 Oct, 14:07", New York time. */
function when(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function Row({ alert }: { alert: RecordingAlertView }) {
  return (
    <li className="border-line rounded-md border bg-white p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[15px] font-semibold">{alert.callId}</span>
        <span className="text-muted text-sm">still at Retell {when(alert.detectedAt)}</span>
      </div>
      <p className="text-muted mt-1 text-sm">
        Clinic{" "}
        <a className="underline" href={`/admin/ops/${alert.clinicId}/care`}>
          {alert.clinicSlug}
        </a>
        {alert.attempts > 0 ? ` · ${alert.attempts} delete attempt(s)` : null}
      </p>
      {alert.resolvedAt ? (
        <p className="mt-2 text-sm font-semibold">Deleted at Retell {when(alert.resolvedAt)}</p>
      ) : (
        <form action={deleteCall} className="mt-3 flex flex-wrap items-center gap-3">
          <input type="hidden" name="clinicId" value={alert.clinicId} />
          <input type="hidden" name="alertId" value={alert.alertId} />
          {alert.lastError ? (
            <span className="text-red-deep text-sm font-semibold">Last try: {alert.lastError}</span>
          ) : null}
          <button
            type="submit"
            className="border-line rounded-sm border px-3 py-1.5 text-sm font-semibold"
          >
            Delete at Retell
          </button>
        </form>
      )}
    </li>
  );
}

export default async function RecordingsPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string }>;
}) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { result } = await searchParams;
  const loaded = await fetchRecordingAlerts();
  if (!loaded.ok && isHostUnreachable(loaded)) return <HostStandbyPage title="Retell deletions" />;

  const open = loaded.ok ? loaded.data.alerts.filter((a) => !a.resolvedAt) : [];
  const resolved = loaded.ok ? loaded.data.alerts.filter((a) => a.resolvedAt) : [];

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">
        Retell deletions
      </h1>
      <p className="text-muted mt-3 max-w-[70ch] text-[15.6px]">
        Retell keeps a call&apos;s transcript and recording only until the call has been
        processed here; then the call is deleted at Retell automatically. These are calls
        Retell still held 30 minutes after they ended because that delete did not go
        through: delete each at Retell. Retell removes anything left after a day on its
        own.
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
              {loaded.data.unreadClinics} clinic(s) could not be read, so their alerts are missing
              below.
            </p>
          ) : null}
          <h2 className="mt-8 text-[19.2px] font-bold">To delete ({open.length})</h2>
          {open.length === 0 ? (
            <p className="text-muted mt-3 text-[15.6px]">No call is waiting to be deleted.</p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {open.map((a) => (
                <Row key={a.alertId} alert={a} />
              ))}
            </ul>
          )}
          <h2 className="mt-8 text-[19.2px] font-bold">Deleted ({resolved.length})</h2>
          {resolved.length === 0 ? null : (
            <ul className="mt-3 grid gap-3">
              {resolved.map((a) => (
                <Row key={a.alertId} alert={a} />
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
