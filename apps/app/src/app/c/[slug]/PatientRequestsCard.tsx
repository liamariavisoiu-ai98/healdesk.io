import { audienceSingular } from "@healdesk/catalog";

import { patientRequestPath } from "@/lib/patient-rights/request-kinds";
import { portalDay } from "@/lib/portal/format";
import type { OpenPatientRequest } from "@/lib/portal/patient-requests";

/**
 * Home's pointer to each patient's request passed to the practice (L32)
 * that nobody has marked received: one line each, with the day to mark it
 * received by and one tap to its page, which opens behind the passkey
 * step-up. Nothing about the person, nor what they asked: the request itself
 * is on its page. A plain link, which never prefetches the page (an open
 * writes an access row).
 */
export function PatientRequestsCard(props: {
  slug: string;
  requests: readonly OpenPatientRequest[];
  audience: "patients" | "clients";
  timeZone: string;
  now: Date;
}) {
  if (props.requests.length === 0) return null;
  const one = audienceSingular(props.audience);
  return (
    <section aria-labelledby="patient-requests-heading" className="mt-6">
      <h2 id="patient-requests-heading" className="text-lg font-semibold">
        {props.requests.length === 1
          ? `A request from a ${one}`
          : `${props.requests.length} requests from ${props.audience}`}
      </h2>
      <ul className="mt-3 grid gap-2">
        {props.requests.map((request) => (
          <li
            key={request.id}
            className="border-line flex flex-wrap items-center justify-between gap-3 rounded-md border bg-white px-4 py-3"
          >
            <span>
              A {one} asked healdesk about their information here. Please mark it received by{" "}
              {portalDay(request.replyBy, props.timeZone, props.now)}.
            </span>
            <a
              href={patientRequestPath(props.slug, request.id)}
              className="bg-ink inline-flex min-h-11 items-center rounded-full px-5 text-sm font-bold text-white"
            >
              Open it
            </a>
          </li>
        ))}
      </ul>
      <p className="text-muted mt-2 text-sm">Each opens behind your passkey.</p>
    </section>
  );
}
