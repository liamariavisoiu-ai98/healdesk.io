import type { OpsEvent } from "@/lib/ops/notify";

import * as account from "./account";
import * as agreements from "./agreements";
import * as approvals from "./approvals";
import * as incidentAssistant from "./incident-assistant";
import * as availability from "./availability";
import * as billing from "./billing";
import * as calendar from "./calendar";
import * as compliancePack from "./compliance-pack";
import * as emailDelivery from "./email-delivery";
import * as goLive from "./go-live";
import * as incidents from "./incidents";
import * as meta from "./meta";
import * as morningDigest from "./morning-digest";
import * as offboarding from "./offboarding";
import * as patientRights from "./patient-rights";
import * as provisioning from "./provisioning";
import * as retention from "./retention";
import * as rights from "./rights";
import * as setupAndSupport from "./setup-and-support";
import * as setupProgress from "./setup-progress";
import * as transcripts from "./transcripts";
import type { AlertWording } from "./types";
import * as usage from "./usage";
import * as vendors from "./vendors";
import * as voice from "./voice";

export type { AlertWording } from "./types";

/**
 * Every ops alert's wording, one file per section of docs/on-call.md's
 * "Alert runbook, by event" (the sections apps/web's RUNBOOK_ANCHOR places
 * each event in). tests/alert-wording.test.ts holds the merged map to
 * OPS_EVENTS: every event has exactly one wording, and every event not in
 * LEGACY_WORDING passes the plain-English rules.
 */
export const SECTIONS = {
  provisioning,
  billing,
  usage,
  "email-delivery": emailDelivery,
  "setup-and-support": setupAndSupport,
  agreements,
  voice,
  calendar,
  transcripts,
  "go-live": goLive,
  account,
  offboarding,
  "patient-rights": patientRights,
  "patient-rights-tracker": rights,
  incidents,
  vendors,
  meta,
  retention,
  availability,
  "setup-progress": setupProgress,
  "morning-digest": morningDigest,
  approvals,
  "compliance-pack": compliancePack,
  "incident-assistant": incidentAssistant,
} as const;

export const ALERT_WORDING: Partial<Record<OpsEvent, AlertWording>> = Object.assign(
  {},
  ...Object.values(SECTIONS).map((section) => section.WORDING),
);

/**
 * The events still in the wording they had before the plain-English rewrite
 * (one paragraph, no steps). Lane N2 rewrites them section by section and
 * takes each off its section's LEGACY set; the goal is an empty set.
 */
export const LEGACY_WORDING: ReadonlySet<OpsEvent> = new Set<OpsEvent>(
  Object.values(SECTIONS).flatMap((section) => [...section.LEGACY]),
);

/**
 * The wording for one alert. A dead letter is raised under
 * critical_notice_undelivered with `status: "dead"` and reads differently:
 * nothing is still trying.
 */
export function alertWording(event: OpsEvent, fields: Readonly<Record<string, unknown>>): AlertWording {
  if (event === "critical_notice_undelivered" && fields.status === "dead") {
    return { ...emailDelivery.DEAD_LETTER, event };
  }
  const wording = ALERT_WORDING[event] ?? { title: event, whatHappened: "Look it up in the console.", whyItMatters: "", steps: [] };
  return { ...wording, event };
}
