import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { Failure, Section } from "@/components/admin/ui";
import { requireOperator } from "@/lib/admin/operator";
import { deleteRecordedCall, fetchRecordingAlerts, type RecordingAlertView } from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

/**
 * Queues › Retell deletions: calls whose data Retell still held after the
 * deletion window, the manual backstop to an automatic delete. Until the
 * admin redesign (23 October 2026) this was /admin/recordings, which
 * redirects here.
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
 * What this shows is ids, counts and times, as the ops API sends them: never
 * the recording or its address, which apps/app does not keep, and never
 * anything said on the call. Plain forms posting to a server action, which
 * checks the operator itself. The outcome comes back in `?retell=`.
 */

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
  if (!UUID.test(clinicId) || !UUID.test(alertId)) redirect("/admin/queues?retell=not_found#retell-deletions");
  const outcome = await deleteRecordedCall(clinicId, alertId);
  revalidatePath("/admin/queues");
  redirect(`/admin/queues?retell=${outcome.ok ? outcome.data.status : "error"}#retell-deletions`);
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
        <span className="font-mono text-sm font-semibold">{alert.callId}</span>
        <span className="text-muted text-sm">still at Retell {when(alert.detectedAt)}</span>
      </div>
      <p className="text-muted mt-1 text-sm">
        Clinic{" "}
        <a className="underline" href={`/admin/clinics/${alert.clinicId}/care`}>
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

export default async function RecordingsSection({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { result } = await searchParams;
  const loaded = await fetchRecordingAlerts();

  const open = loaded.ok ? loaded.data.alerts.filter((a) => !a.resolvedAt) : [];
  const resolved = loaded.ok ? loaded.data.alerts.filter((a) => a.resolvedAt) : [];

  return (
    <Section id="retell-deletions" title={`Retell deletions${loaded.ok ? ` (${open.length} to delete)` : ""}`}>
      <p className="text-muted text-sm">
        Retell keeps a call&apos;s transcript and recording until the call has been processed here; then the call is
        deleted at Retell automatically. These are the calls still held 30 minutes after they ended: delete each at Retell.
      </p>

      {result && RESULTS[result] ? (
        <p className="border-line mt-3 rounded-sm border bg-white px-4 py-3 text-sm font-semibold" role="status">
          {RESULTS[result]}
        </p>
      ) : null}

      {isHostUnreachable(loaded) ? (
        <HostStandbyNotice what="The Retell deletions" />
      ) : !loaded.ok ? (
        <Failure failure={loaded} what="the Retell deletions" />
      ) : (
        <>
          {loaded.data.unreadClinics > 0 ? (
            <p className="text-red-deep mt-2 text-sm font-semibold">
              {loaded.data.unreadClinics} clinic(s) could not be read, so their alerts are missing
              below.
            </p>
          ) : null}
          <h3 className="mt-4 text-base font-bold">To delete ({open.length})</h3>
          {open.length === 0 ? (
            <p className="text-muted mt-2 text-sm">No call is waiting to be deleted.</p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {open.map((a) => (
                <Row key={a.alertId} alert={a} />
              ))}
            </ul>
          )}
          <h3 className="mt-6 text-base font-bold">Deleted ({resolved.length})</h3>
          {resolved.length === 0 ? null : (
            <ul className="mt-3 grid gap-3">
              {resolved.map((a) => (
                <Row key={a.alertId} alert={a} />
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}
