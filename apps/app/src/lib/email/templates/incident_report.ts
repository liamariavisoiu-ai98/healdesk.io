import {
  INCIDENT_INFORMATION_TYPES,
  INCIDENT_MITIGATIONS,
  INCIDENT_REPORT_EVENTS,
  isIncidentInformationType,
  isIncidentMitigation,
  isIncidentReportEvent,
  SENDER_IDENTITY,
  type IncidentInformationType,
  type IncidentMitigation,
  type IncidentReportEvent,
} from "@healdesk/catalog";

import type { ReportableClass } from "@/lib/incidents/reporting-rules";

import { counted, dayLong } from "./billing-copy";
import { compose, EmailCompositionError, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L29, the second of its two emails: an incident report (Annex X5). It goes
 * only when ops sends it, from the /admin incidents page, and is critical
 * once queued: sent in-process right after commit, late after ten minutes,
 * and a dead letter raises notifyOps for a person to phone the practice.
 *
 * Built from fixed fields only, which are what the agreements' Reporting
 * clause asks a report to give (45 CFR 164.410(c)) as far as an email may
 * carry them:
 *
 *   - what happened, from the catalog's closed list, with the date of the
 *     event (or that it is not yet known) and of its discovery;
 *   - the types of information involved, each with a count;
 *   - what was done about it, from a closed list;
 *   - a contact: a reply to this email reaches healdesk's notice address.
 *
 * The identification of each person affected is never emailed (X5): Resend
 * carries this email and signs no business associate agreement. A breach
 * report points to the incident's page in the portal instead (`listUrl`,
 * wave 2 R11), where the practice reads the list behind its passkey step-up
 * (lib/portal/incidents.ts): the secure transfer the agreement's Safeguards
 * clause provides. A report queued before that page existed carries no
 * link and says the list comes by secure transfer, as it did. Nor does the email state any deadline: the
 * agreements' is "without unreasonable delay and in no case later than 60
 * calendar days", and healdesk's own 24-hour target is internal (owner,
 * 12 October 2026). A report is as complete as healdesk can make it when it
 * goes, and an update follows as more is learned; `isUpdate` says which this
 * is.
 */

export type IncidentReportPayload = {
  /** The class the agreement's clause names: (a), (b) or (c). */
  kind: ReportableClass;
  /** What happened, from INCIDENT_REPORT_EVENTS. */
  event: IncidentReportEvent;
  /** The day it happened (YYYY-MM-DD), or null while that is not known. */
  occurredOn: string | null;
  /** The day healdesk discovered it (YYYY-MM-DD). */
  discoveredOn: string;
  /** Each type of information involved, counted. Empty while that is not yet known. */
  infoRows: readonly { type: IncidentInformationType; count: number }[];
  /** What was done, from INCIDENT_MITIGATIONS. Empty while nothing is yet. */
  mitigationRows: readonly { code: IncidentMitigation }[];
  /** An update to an earlier report about the same incident. */
  isUpdate: boolean;
  /**
   * A breach's: the incident's page in the portal, where the list of who it
   * affected is read behind the passkey step-up. publicUrl of
   * /c/<slug>/incidents/<id>; absent on a report queued before the page.
   */
  listUrl?: string;
};

const WHAT: Record<ReportableClass, { subject: string; noun: string }> = {
  breach: {
    subject: "a breach",
    noun: "a breach of information your agreement with healdesk protects",
  },
  security_incident: {
    subject: "a security incident",
    noun: "a security incident affecting information your agreement with healdesk protects",
  },
  improper_use_or_disclosure: {
    subject: "a use your agreement doesn't permit",
    noun: "a use or disclosure of information that your agreement with healdesk does not permit",
  },
};

export const renderIncidentReport: EmailTemplate<IncidentReportPayload> = (payload, ctx) => {
  const what = WHAT[payload.kind];
  if (!what) throw new EmailCompositionError(`Unknown incident class "${String(payload.kind)}".`);
  if (!isIncidentReportEvent(payload.event)) {
    throw new EmailCompositionError(`Unknown incident event "${String(payload.event)}".`);
  }
  const info = payload.infoRows.map((row) => {
    if (!isIncidentInformationType(row.type)) {
      throw new EmailCompositionError(`Unknown information type "${String(row.type)}".`);
    }
    const words = INCIDENT_INFORMATION_TYPES[row.type];
    return counted(row.count, words.one, words.many);
  });
  const done = payload.mitigationRows.map((row) => {
    if (!isIncidentMitigation(row.code)) {
      throw new EmailCompositionError(`Unknown mitigation "${String(row.code)}".`);
    }
    return INCIDENT_MITIGATIONS[row.code];
  });
  const clinic = ctx.clinicName ?? "your practice";

  const blocks: Block[] = [
    {
      type: "paragraph",
      text: payload.isUpdate
        ? `This updates our report to ${clinic} of ${what.noun}.`
        : `We're reporting ${what.noun}, as that agreement requires. It involves information healdesk handles for ${clinic}.`,
    },
    { type: "paragraph", text: `What happened: ${INCIDENT_REPORT_EVENTS[payload.event].sentence}` },
    {
      type: "facts",
      rows: [
        [
          "When it happened",
          payload.occurredOn
            ? dayLong(payload.occurredOn, ctx)
            : "Not yet known. We'll tell you in an update.",
        ],
        ["When we discovered it", dayLong(payload.discoveredOn, ctx)],
      ],
    },
    ...(info.length > 0
      ? ([
          { type: "paragraph", text: "The information involved:" },
          { type: "list", items: info },
        ] as const)
      : ([
          {
            type: "paragraph",
            text: "We're still establishing what information was involved, and we'll tell you in an update.",
          },
        ] as const)),
    ...(done.length > 0
      ? ([
          { type: "paragraph", text: "What we've done:" },
          { type: "list", items: done },
        ] as const)
      : ([
          {
            type: "paragraph",
            text: "We'll tell you what we've done about it in an update.",
          },
        ] as const)),
    ...(payload.kind === "breach" && payload.listUrl
      ? ([
          {
            type: "paragraph",
            text: `This email names no one. The identification of each ${ctx.audience === "clients" ? "client" : "patient"} affected is on this incident's page in healdesk, behind your passkey, as your agreement provides: it's never emailed. We'll tell you in an update if it isn't complete yet.`,
          },
          { type: "action", label: "See who was affected", url: payload.listUrl },
        ] as const)
      : payload.kind === "breach"
        ? ([
            {
              type: "paragraph",
              text: "This email names no one. We'll give you the identification of each person affected separately, by secure transfer, as your agreement provides, along with anything else you need for notices of your own.",
            },
          ] as const)
        : []),
    {
      type: "paragraph",
      text: "This report is as complete as we can make it today, and we'll add to it as we learn more.",
    },
    {
      type: "paragraph",
      text: `Your contact at healdesk: reply to this email, or write to ${SENDER_IDENTITY.replyTo}.`,
    },
  ];

  return compose(
    {
      subject: `${payload.isUpdate ? "Update: " : ""}healdesk incident report: ${what.subject}`,
      preheader: payload.isUpdate
        ? "What we've learned since our last report."
        : "What happened, when, what was involved and what we've done.",
      blocks,
    },
    ctx,
  );
};

export const INCIDENT_REPORT_ENTRY: TemplateEntry<IncidentReportPayload> = {
  render: renderIncidentReport,
  fixture: {
    kind: "breach",
    event: "misdirected_email",
    occurredOn: "2026-10-04",
    discoveredOn: "2026-10-05",
    infoRows: [
      { type: "first_name", count: 3 },
      { type: "phone_number", count: 3 },
      { type: "conversation_transcript", count: 1 },
    ],
    mitigationRows: [{ code: "recipient_confirmed_deletion" }, { code: "fault_fixed" }],
    isUpdate: false,
  },
};

