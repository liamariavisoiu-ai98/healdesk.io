import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "patient-rights-tracker" section of docs/on-call.md's alert runbook
 * (ops automation lane P6c; design E6 item 16; owner decision D19). Raised
 * by the daily rights-watch job (lib/scheduler/rights-watch.ts), once per
 * request each, with the clinic's id and the request's.
 *
 * The steps name the Patient rights page (/admin/rights) and its controls
 * "Copy command" and "Mark done", which lane P6d builds; until then each
 * step also names a place that exists today (the Home page, the clinic's
 * Care tab, its Touch log), which tests/alert-wording.test.ts proves in
 * apps/web's source. The tracker never runs anything: the owner runs every
 * prepared command himself, in AWS CloudShell. Nothing here names a person.
 */

const FIND_IT =
  "Open the Patient rights page from the Home page and find the request by the clinic's name and the day due.";

const NOTE_IT =
  "Record what you did in the Touch log on the clinic's Care tab, with no patient detail.";

export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  rights_request_blocked: {
    title: "A patient-rights request has no route on the host yet",
    headline: "{clinicName} has a patient-rights request that cannot run on the host yet",
    whatHappened:
      "{clinicName} has a patient-rights request that cannot run on the host yet. It is an erasure, an amendment, a correction or an export. Each needs the person's record id, and nothing on the host can find one from a name, a number or an address. The Patient rights page shows it as blocked, and its clock keeps running.",
    whyItMatters:
      "The agreement gives us ten business days for it, and they count while it waits. The portal route that would let it run is not built yet, so a person must agree with the practice how it is handled in time.",
    steps: [
      FIND_IT,
      "Tell the owner today, by the clinic's name and the day due only, that the request needs the portal route. Then phone the clinic on its published number, shown under Phone line on its Setup tab, and agree how it is handled before the day due.",
      `${NOTE_IT} Press Mark done on the Patient rights page once the practice confirms it was handled. You are done when the request no longer shows as blocked.`,
    ],
  },
  rights_request_due_soon: {
    title: "Patient-rights request due in two business days",
    headline: "{clinicName} has a patient-rights request due within two business days",
    whatHappened:
      "{clinicName} has a patient-rights request due within two business days. It is an erasure, an amendment, a correction, an export or a patient's own request still to pass on. Nothing on our side has marked it done.",
    whyItMatters:
      "The agreement sets the day: ten business days for an erasure, an amendment, a correction or an export, and five to pass a patient's own request on. Missing it breaks a promise to the practice.",
    steps: [
      `${FIND_IT} Press Copy command where it has one, and run it yourself in AWS CloudShell. Where it shows as blocked, follow the steps of its blocked alert instead.`,
      "Check the clinic's Care tab afterwards: a deletion shows under its deletion requests, and its Retell step stays outstanding until it is recorded there.",
      `${NOTE_IT} Press Mark done on the Patient rights page when the work is finished. You are done when the request shows as done.`,
    ],
  },
  rights_request_overdue: {
    title: "A patient-rights request is past its due day",
    headline: "{clinicName} has a patient-rights request past its due day",
    whatHappened:
      "{clinicName} has a patient-rights request past its due day. It is an erasure, an amendment, a correction, an export or a patient's own request still to pass on. Nothing on our side has marked it done.",
    whyItMatters:
      "The agreement's day has passed. Finishing it today, and telling the practice when it was done, is what closes the gap and leaves a record of it.",
    steps: [
      `${FIND_IT} Press Copy command where it has one, and run it yourself in AWS CloudShell today. Where it shows as blocked, tell the owner today.`,
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, and tell it the request is late and when it will be done. Never email the person's details.",
      `${NOTE_IT} Press Mark done on the Patient rights page when the work is finished. You are done when the request shows as done.`,
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts): none. */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
