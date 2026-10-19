import { audienceSingular } from "@healdesk/catalog";

import type { PatientRequestKind } from "@/db/schema";
import { PATIENT_REQUEST_KIND_LABELS } from "@/lib/patient-rights/request-kinds";
import { publicUrl } from "@/lib/public-url";
import { formatReplyBy } from "@/lib/reply-by";

import { compose, EmailCompositionError, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate, TemplateContext } from "./types";

/**
 * L32, "A request from a patient" (Annex X5 of the funnel and portal plan):
 * a patient asked healdesk itself, rather than the practice, about their
 * information there, and the BAA has us pass it to the practice within five
 * business days (clause 14). Queued when the operator records the request
 * (lib/patient-rights/patient-requests.ts), and again as a reminder on the
 * second and fourth business days while nobody has marked it received.
 *
 * A POINTER (X1.1; plan, "L32: a pointer"): which clinic, what kind of
 * request, the day to mark it received by, and the link to the request's own
 * page, which opens behind sign-in and the passkey step-up. Never who asked,
 * how to reach them or anything they wrote: the payload has no field for
 * any of it. The reply to the patient is written by a person (X0), never
 * from here.
 */

export type PatientRequestPayload = {
  /** The request's id (patient_requests.id). */
  requestId: string;
  /** What was asked, from PATIENT_REQUEST_KINDS: a closed word, never the patient's. */
  kind: PatientRequestKind;
  /** The day to mark it received by: the fifth business day after it reached us (YYYY-MM-DD). */
  replyByOn: string;
  /** A reminder, sent while nobody has marked it received. */
  isReminder: boolean;
  /** The request's page, behind sign-in and step-up. Null only when no public origin is set. */
  portalUrl: string | null;
};

/** "asked healdesk ___ at {clinic}": what each kind of request was for. */
const ASKED: Record<PatientRequestKind, string> = {
  access: "to see or get a copy of their information",
  amendment: "to correct their information",
  accounting: "who their information has been shared with",
  deletion: "to delete their information",
  other: "about their information",
};

function openAction(url: string | null): Block {
  return url
    ? { type: "action", label: "Open the request", url }
    : { type: "paragraph", text: "Sign in to healdesk: Home links to it." };
}

function clinicOf(ctx: TemplateContext): string {
  return ctx.clinicName ?? "your practice";
}

export const renderPatientRequest: EmailTemplate<PatientRequestPayload> = (payload, ctx) => {
  const asked = ASKED[payload.kind];
  if (!asked) {
    throw new EmailCompositionError(`"${String(payload.kind)}" is not a kind of patient request.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.replyByOn)) {
    throw new EmailCompositionError("A patient request needs the day to mark it received by.");
  }
  const one = audienceSingular(ctx.audience);
  const by = formatReplyBy(payload.replyByOn);
  const clinic = clinicOf(ctx);
  return compose(
    {
      subject: payload.isReminder
        ? `Reminder: a request from a ${one} is waiting`
        : `A request from a ${one} for your team`,
      preheader: `Open it in healdesk and mark it received by ${by}.`,
      blocks: [
        {
          type: "paragraph",
          text: payload.isReminder
            ? `A ${one}'s request about their information at ${clinic} is still waiting for your team to mark it received. healdesk doesn't act on a request like this: your team answers it.`
            : `A ${one} asked healdesk ${asked} at ${clinic}. healdesk doesn't act on a request like this: your team answers it, so we're passing it to you.`,
        },
        {
          type: "facts",
          rows: [
            ["Request", PATIENT_REQUEST_KIND_LABELS[payload.kind]],
            ["Mark it received by", by],
          ],
        },
        openAction(payload.portalUrl),
        {
          type: "paragraph",
          text: `Please mark it received by ${by}, so we know it reached you.`,
        },
        {
          type: "paragraph",
          text: `This email carries no ${one} details on purpose: they open in healdesk once you sign in.`,
        },
      ],
    },
    ctx,
  );
};

export const PATIENT_REQUEST_ENTRY: TemplateEntry<PatientRequestPayload> = {
  render: renderPatientRequest,
  get fixture(): PatientRequestPayload {
    const requestId = "8a3f4d5e-6f70-4182-9d9e-0f1a2b3c4d5e";
    return {
      requestId,
      kind: "access",
      replyByOn: "2026-10-27",
      isReminder: false,
      portalUrl: publicUrl(`/c/radiance-med-spa/patient-requests/${requestId}`),
    };
  },
};
