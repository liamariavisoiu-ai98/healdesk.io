import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "patient-rights" section of docs/on-call.md's alert runbook. The
 * console shows no patient request (the request names a person and is
 * recorded on the host), so every step is a telephone call; the practice's
 * own mark on the request's portal page is what stops the clock
 * (lib/patient-rights/patient-requests.ts). The days are business days, so
 * the due day is the next business day, not always tomorrow. Every clinic
 * takes a Touch log note until its account is closed (lane N3, lib/ops/
 * health.ts touchRefusal); no "done" line depends on one.
 */

/** The one Touch log step, for a clinic whose log may be gone. */
const NOTE_IT =
  "Press Record in the Touch log on the clinic's Care tab to note it. If the clinic's account is already closed, it takes no note: tell the owner what you did instead, with no patient detail.";

export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // L32's clock (lib/patient-rights/patient-requests.ts), once per request
  // each: the clinic's and the request's ids.
  patient_request_due_soon: {
    title: "A patient's request is due next business day: pass it on",
    whatHappened:
      "A patient asked healdesk, not the clinic, for something about their information, and we recorded it for {clinicName}. The agreement has us pass it on within five business days, and the next business day is the last. The practice has had our email and its reminders and has not marked the request received in its portal.",
    whyItMatters:
      "Passing it on is a duty in the agreement, with a day. The practice's own mark on the request's page is what counts, not an email delivered.",
    steps: [
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, today. Tell it a patient's request is waiting on Home in its portal, where it marks it received behind its passkey.",
      "Tell the clinic who asked and how to reach them, by phone only, if the request names no contact on our side. Whoever recorded the request for us, or the patient's own message to us, has that; never email or write down the person's details, and nothing on the clinic's Care tab shows them.",
      `${NOTE_IT} You are done when the practice has marked the request received, which stops the reminders and the alert that follows.`,
    ],
  },
  patient_request_past_due: {
    title: "A patient's request is past its five business days",
    whatHappened:
      "A request a patient made to healdesk about {clinicName} is past the five business days the agreement gives us to pass it on, and nobody at the practice has marked it received in its portal. The practice gets no more reminders; a person passes it on now.",
    whyItMatters:
      "The agreement's day has passed. Passing the request on by telephone today, and having the practice mark it received, is what closes the gap and leaves a record that it reached them.",
    steps: [
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, today, and pass the request on by telephone only: what kind of request it is, and who asked where the request names no contact. Whoever recorded the request for us, or the patient's own message to us, has that.",
      "Ask the clinic to open the request on Home in its portal and mark it received, so the record shows it reached them. Never email the person's details; nothing on the clinic's Care tab shows them.",
      `${NOTE_IT} You are done when the practice has marked the request received.`,
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
