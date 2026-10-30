import { audienceSingular } from "@healdesk/catalog";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  PATIENT_REQUEST_KIND_LABELS,
  patientRequestPath,
} from "@/lib/patient-rights/request-kinds";
import { phoneText } from "@/lib/portal/conversation-words";
import { portalDay, portalMoment } from "@/lib/portal/format";
import { loadPortalPage, shellProps } from "@/lib/portal/page";
import { patientGuardProps, requirePatientPage } from "@/lib/portal/patient-page";
import { readPatientRequest } from "@/lib/portal/patient-requests";

import { PatientPageGuard } from "../../PatientPageGuard";
import { PortalShell } from "../../PortalShell";
import { markReceived } from "../actions";

export const metadata: Metadata = { title: "A request · healdesk", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * A patient's request to healdesk, passed to the practice (L32; BAA 1.5.1
 * clause 14): what they asked, who it is about as the contact it names
 * reads, when it reached healdesk, and the day to mark it received by, with
 * "Mark as received". Reached from Home's pointer and from L32's link. A
 * patient page: requirePatientPage first, and the open writes its access row
 * in the transaction that reads it. An id this clinic does not hold is "not
 * found". Nothing the person wrote is here: healdesk keeps none of it.
 */
export default async function PatientRequestPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const page = await requirePatientPage(slug, { returnTo: patientRequestPath(slug, id) });
  const now = new Date();
  const portalPage = await loadPortalPage(page.portal, now);
  if (!portalPage) notFound();
  const shell = shellProps(page.portal, portalPage, "home");
  const request = await readPatientRequest(page, id);
  if (!request) notFound();

  const zone = shell.timeZone;
  const one = audienceSingular(shell.audience);
  const by = portalDay(request.replyBy, zone, now);
  const clinicSlug = page.portal.clinicSlug;
  const person = request.person;

  return (
    <PortalShell {...shell}>
      <p>
        <a
          href={`/c/${clinicSlug}`}
          className="inline-flex min-h-11 items-center text-sm font-semibold underline"
        >
          Home
        </a>
      </p>
      <PatientPageGuard {...patientGuardProps(page)}>
        <h1 className="text-2xl font-semibold">A request from a {one}</h1>
        <p className="text-muted mt-2">
          They asked healdesk rather than your practice. healdesk doesn&rsquo;t act on a request
          like this: your team answers it, and healdesk tells them it has passed it to you.
        </p>

        <dl className="border-line mt-6 grid gap-3 rounded-md border bg-white px-4 py-4">
          <div>
            <dt className="text-muted text-sm">What they asked</dt>
            <dd className="mt-1">{PATIENT_REQUEST_KIND_LABELS[request.kind]}</dd>
          </div>
          <div>
            <dt className="text-muted text-sm">Who</dt>
            <dd className="mt-1">
              {person === "none" ? (
                <span className="text-muted">
                  healdesk holds no record of them. We&rsquo;ll telephone you by {by} with who asked
                  and how to reach them.
                </span>
              ) : person === "gone" ? (
                <span className="text-muted">
                  Their details have since been deleted from healdesk.
                </span>
              ) : (
                [person.name, person.phone ? phoneText(person.phone) : null, person.email]
                  .filter(Boolean)
                  .join(" · ") || <span className="text-muted">No name, number or address</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted text-sm">Reached healdesk</dt>
            <dd className="mt-1">{portalMoment(new Date(request.receivedAt), zone, now)}</dd>
          </div>
          <div>
            <dt className="text-muted text-sm">Mark it received by</dt>
            <dd className="mt-1">{by}</dd>
          </div>
        </dl>

        <section aria-labelledby="received-heading" className="mt-10">
          <h2 id="received-heading" className="text-lg font-semibold">
            Received
          </h2>
          {request.acknowledgedAt ? (
            <p className="mt-2">
              Marked received {portalMoment(new Date(request.acknowledgedAt), zone, now)}, from{" "}
              {request.acknowledgedBy}.
            </p>
          ) : (
            <form action={markReceived.bind(null, clinicSlug, request.id)} className="mt-3">
              <p id="mark-received-note" className="text-muted text-sm">
                Marking it tells healdesk the request reached your team, and stops the reminders.
              </p>
              <button
                type="submit"
                aria-describedby="mark-received-note"
                className="bg-ink mt-3 inline-flex min-h-11 items-center rounded-full px-6 text-sm font-bold text-white"
              >
                Mark as received
              </button>
            </form>
          )}
        </section>
      </PatientPageGuard>
    </PortalShell>
  );
}
