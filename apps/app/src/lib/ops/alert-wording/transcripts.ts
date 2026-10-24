import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "transcripts" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  transcript_undelivered: legacy(
    "A transcript could not be emailed",
    "The transcript of the conversation below did not reach the clinic, and healdesk keeps no copy, so it is gone. The reason says why: SES refused the address, the clinic's mail server would not accept it over TLS, or SES is not set up on apps/app (HEALDESK_SES_CONFIGURATION_SET). Fix the cause so the next one arrives, and tell the clinic that one conversation's transcript was lost; its time and outcome are still on the conversation. Never ask the clinic to read the transcript to you.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "transcript_undelivered",
]);
