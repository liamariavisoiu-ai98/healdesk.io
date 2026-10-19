import type { Carrier, Channel, CoverageModeId } from "@healdesk/catalog";

import { formatReplyBy } from "@/lib/reply-by";
import { describeAccountState, type AccountState } from "@/lib/support/account-state";
import {
  describeEscalation,
  topicLabel,
  type EscalationTopic,
  type PhoneSystemId,
} from "@/lib/support/escalation-fields";

import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * I3, a support escalation (Annex X5: "Setup requests, enquiries, reviews,
 * support escalations, access requests", to hello@): what the portal's
 * support chat sends a person at healdesk when it cannot solve something
 * (plan Part H, "Escalation email to hello@").
 *
 * It carries the topic, the fields picked from fixed lists, and the account
 * state the chat read (get_account_state), and NEVER the chat's text: the
 * chat stores nothing and sends no words anywhere but the model (spec, "an
 * escalation emails Healdesk structured fields, never the chat's text"). The
 * payload type has no field a sentence could go in, and the allowlist checks
 * it again at send time. The reply-to is the clinic's address, so answering
 * the email answers the practice.
 *
 * No link: the operator console lives on the marketing site's origin, and an
 * email from apps/app links only to apps/app's public origin (X1.6). The
 * practice's id finds it in the console.
 */

export type SupportEscalationPayload = {
  requestId: string;
  topic: EscalationTopic;
  symptom: string;
  carrier: Carrier | null;
  phoneSystem: PhoneSystemId | null;
  mode: CoverageModeId | null;
  channel: Channel | null;
  /** The day the practice was told to expect a reply (L25). */
  replyByOn: string;
  /** Whether the practice has an address the reply can go to. */
  hasReplyAddress: boolean;
  /** get_account_state's output, as one row. */
  accountRows: [AccountState];
};

/** Why hello@ receives it (X1.9). */
export const SUPPORT_REASON =
  "You're receiving this because this address is healdesk's support inbox.";

export const renderSupportEscalation: EmailTemplate<SupportEscalationPayload> = (payload, ctx) => {
  const [account] = payload.accountRows;
  const replyBy = formatReplyBy(payload.replyByOn);
  return compose(
    {
      subject: `Support request: ${topicLabel(payload.topic)}`,
      preheader: `${account.clinicName} asked for a person. Reply by ${replyBy}.`,
      blocks: [
        {
          type: "paragraph",
          text: payload.hasReplyAddress
            ? `${account.clinicName} asked for a person from the support chat in its portal, and was told we'd reply by ${replyBy}. Replying to this email answers the practice: the reply goes to its address.`
            : `${account.clinicName} asked for a person from the support chat in its portal. Its address can't be found, so it was not told when we'd reply: find it in the console by its id below.`,
        },
        {
          type: "facts",
          rows: [["Request", payload.requestId], ...describeEscalation(payload)],
        },
        {
          type: "paragraph",
          text: "The account, as the chat read it. The chat's words are not included: healdesk doesn't keep them.",
        },
        { type: "facts", rows: describeAccountState(account) },
      ],
    },
    ctx,
  );
};

export const SUPPORT_ESCALATION_FIXTURE: SupportEscalationPayload = {
  requestId: "6f1e2d3c-4b5a-4968-8776-655443322110",
  topic: "forwarding",
  symptom: "calls_not_reaching_aya",
  carrier: "verizon",
  phoneSystem: "landline",
  mode: "overflow_after_hours",
  channel: null,
  replyByOn: "2026-10-07",
  hasReplyAddress: true,
  accountRows: [
    {
      clinicId: "0c1d2e3f-0000-4000-8000-000000000000",
      clinicName: "Radiance Med Spa",
      isClosed: false,
      isSetupFinished: true,
      setupStepsLeftCount: 0,
      setupDeadlineAt: "2026-11-05T14:32:00.000Z",
      stageRows: [
        { code: "agreement", status: "done" },
        { code: "payment", status: "done" },
        { code: "website", status: "done" },
        { code: "answers", status: "done" },
        { code: "calendar", status: "done" },
        { code: "built", status: "not_done" },
        { code: "practice_questions", status: "not_done" },
      ],
      channelRows: [
        {
          channel: "web",
          status: "waiting",
          waitingOn: "snippet",
          isEnabled: true,
          liveAt: null,
        },
        {
          channel: "voice",
          status: "waiting",
          waitingOn: "forwarding",
          isEnabled: true,
          liveAt: null,
        },
      ],
      isPaused: false,
      pausedUntilAt: null,
      mode: "overflow_after_hours",
      carrier: "verizon",
      phoneSystem: "landline",
      publishedPhoneE164: "+15125550100",
      directLineE164: "+15125550101",
      isUrgentHelpSet: true,
      isTransferOn: false,
      isDailySummaryOn: true,
      isDepositsOn: false,
      connectionRows: [
        { resource: "google_calendar", status: "active" },
        { resource: "payment_account", status: "not_connected" },
      ],
      planId: "voice-webchat-500-300",
      interval: "month",
      status: "active",
      isPlanStarted: false,
      planStartedAt: null,
      isAutoRenewOn: true,
      closesOn: null,
      overageMode: "allow",
      isUsageAlertsOn: true,
      hasOpenInvoice: false,
      graceEndsAt: null,
      usageRows: [],
      isAddressUndeliverable: false,
    },
  ],
};

export const SUPPORT_ESCALATION_ENTRY: TemplateEntry<SupportEscalationPayload> = {
  render: renderSupportEscalation,
  fixture: SUPPORT_ESCALATION_FIXTURE,
};
