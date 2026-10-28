import type { SupportCaseView, SupportDraftView, SupportReplyApprovalItem } from "@/lib/admin/ops-client";

/**
 * Fixed fixtures for the case view's tests (lane P7d): one chat case of a
 * clinic, its drafter's draft with the facts it used and its checks, and the
 * reply waiting in the approval inbox for that draft. Dates are pinned; ids
 * are uuids of the test's own.
 */

export const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
export const CASE = "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
export const MESSAGE = "6c5b4d3e-2f10-4b0c-9d8e-7f6a5b4c3d2e";
export const ESCALATION = "8e7d6f50-4b32-4d2e-9fa0-9b8c7d6e5f40";
export const ITEM = "7d6c5e4f-3a21-4c1d-8e9f-8a7b6c5d4e3f";
export const NOW = "2026-11-02T18:00:00.000Z";

export const DRAFT_TEXT = "Hi, your calls are reaching AYA again: forwarding on your main line is set. If they stop, reply here and we will look the same day.";

export const draft: SupportDraftView = {
  messageId: MESSAGE,
  version: 2,
  text: DRAFT_TEXT,
  checks: [
    { id: "facts", ok: true, rule: "Every date, day, time, amount, percent, count, package name, phone number and link in the reply comes from a fact the tools returned." },
    { id: "screen", ok: true, rule: "The reply carries no stranger's phone number or email address and no treatment name." },
    { id: "names", ok: true, rule: "The reply names no person: every capitalised word is a product, a place in the portal, a day, a month or the practice's own name." },
    { id: "clinical", ok: true, rule: "The reply gives no clinical content or advice." },
    { id: "promises", ok: true, rule: "The reply promises no refund, credit, free service, waiver, guarantee, go-live date or response time that the billing record does not show." },
    // apps/app's own sentence quotes the claims the product may never make; the site copy guard reads this file too, so the fixture paraphrases it.
    { id: "claims", ok: true, rule: "The reply makes none of the claims the product may not make, quotes only prices the catalog has, and names the agreement the practice signed." },
    { id: "shape", ok: true, rule: "The reply is at most six sentences and 900 characters, asks at most one question, has at most one link and only to the portal, and has no markdown, exclamation mark, emoji or banned phrase." },
    { id: "other_clinics", ok: true, rule: "The reply carries no id, case reference or name that belongs to another practice or case." },
  ],
  factsUsed: [{ tool: "get_account_state", field: "Channel: Phone", value: "live, live since 2026-10-20" }],
  questionsForOps: ["Has the practice's carrier changed since setup?"],
  confidence: "high",
  createdAt: "2026-11-02T15:30:00.000Z",
  failure: null,
};

export const view: SupportCaseView = {
  case: {
    id: CASE,
    ref: "HD-7F3KQ",
    clinicId: CLINIC,
    clinicName: "Radiance Med Spa",
    source: "chat",
    category: "forwarding",
    symptom: "calls_ring_out",
    urgency: "now",
    state: "drafted",
    assigneeLabel: null,
    openedAt: "2026-11-02T15:00:00.000Z",
    ageHours: 3,
    replyByOn: "2026-11-03",
    pastDue: false,
    snoozedUntil: null,
    lastInboundAt: "2026-11-02T15:00:00.000Z",
    lastOutboundAt: null,
    closedAt: null,
    closedReason: null,
    phiSuspected: false,
    hidden: { numbers: 0, emails: 0, treatments: 0, clinical: 0 },
    inboundCount: 1,
  },
  messages: [
    {
      id: ESCALATION,
      direction: "in",
      kind: "chat_escalation",
      at: "2026-11-02T15:00:00.000Z",
      fields: { topic: "forwarding", symptom: "calls_ring_out", carrier: "verizon", phoneSystem: "voip", mode: "overflow_after_hours", channel: null },
      hasDraft: false,
      draftVersion: null,
      approvedAt: null,
      sentAt: null,
    },
    { id: MESSAGE, direction: "out", kind: "reply", at: "2026-11-02T15:30:00.000Z", fields: null, hasDraft: true, draftVersion: 2, approvedAt: null, sentAt: null },
  ],
  facts: {
    days: 14,
    account: {
      clinicId: CLINIC,
      isClosed: false,
      isSetupFinished: true,
      setupStepsLeftCount: 0,
      setupDeadlineAt: null,
      stageRows: [{ code: "agreement", status: "done" }],
      channelRows: [{ channel: "voice", status: "live", waitingOn: null, isEnabled: true, liveAt: "2026-10-20T09:00:00.000Z" }],
      isPaused: false,
      pausedUntilAt: null,
      mode: "overflow_after_hours",
      carrier: "verizon",
      phoneSystem: "voip",
      isUrgentHelpSet: true,
      isTransferOn: false,
      isDailySummaryOn: true,
      isDepositsOn: false,
      connectionRows: [
        { resource: "google_calendar", status: "active" },
        { resource: "payment_account", status: "not_connected" },
      ],
      planId: "voice-100",
      interval: "month",
      status: "active",
      isPlanStarted: true,
      planStartedAt: "2026-10-20T09:00:00.000Z",
      isAutoRenewOn: true,
      closesOn: null,
      overageMode: "allow",
      isUsageAlertsOn: true,
      hasOpenInvoice: false,
      graceEndsAt: null,
      usageRows: [{ meter: "voice_minutes", used: 12, included: 100 }],
      isAddressUndeliverable: false,
      isPublishedPhoneSet: true,
      isDirectLineSet: true,
    },
    alerts: [{ event: "voice_direct_line_loops", raisedAt: "2026-11-01T09:00:00.000Z", lastRaisedAt: "2026-11-01T09:00:00.000Z", repeats: 1 }],
    transcripts: { open: 0, pending: 0, sent: 0, bounced: 0, delivered: 3, expired: 0, unconfirmed: 0 },
  },
  draft,
  people: ["The Healdesk Team", "Liam"],
};

export const item: SupportReplyApprovalItem = {
  id: ITEM,
  kind: "support_reply_send",
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  subjectRef: `${MESSAGE}:2`,
  urgency: "routine",
  status: "waiting",
  proposedAt: "2026-11-02T15:31:00.000Z",
  dueAt: "2026-11-02T15:32:00.000Z",
  expiresAt: "2026-11-16T15:31:00.000Z",
  decidedAt: null,
  outcomeCode: null,
  pastDue: false,
  irreversible: true,
  operation: "sendSupportReply",
  hasDraft: true,
  packet: {
    operation: "sendSupportReply",
    irreversible: true,
    stillNeeded: true,
    effect:
      "Sends this reply to the practice's one sign-in address, signed The Healdesk Team, under the subject shown. The checks run again on the text you approve; if one fails, nothing is sent and the rule is named.",
    facts: {
      kind: "support_reply_send",
      ref: "HD-7F3KQ",
      caseId: CASE,
      topic: "forwarding",
      symptom: "calls_ring_out",
      caseUrgency: "now",
      caseState: "drafted",
      replyByOn: "2026-11-03",
      draftVersion: 2,
      currentDraftVersion: 2,
      checks: draft.checks,
      action: null,
    },
    draft: { subject: "Re: Your call forwarding (ref HD-7F3KQ)", body: DRAFT_TEXT },
  },
};
