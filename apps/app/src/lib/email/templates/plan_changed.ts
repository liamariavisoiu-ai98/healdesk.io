import { channelList, getPlan, planStartSentence } from "@healdesk/catalog";

import type { ForwardingFacts, NoticePayloads } from "@/lib/billing/notices";

import {
  cancelOnline,
  CHANNEL_WORDS,
  money,
  person,
  planByName,
  undoForwarding,
  WAITING_CHANNEL_JOINS,
} from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: the clinic changed its plan from Billing (Annex X5). Only our own
 * changePlan enqueues it, never the webhook (BD8).
 *
 * The new plan and how it is billed; before the plan has started, the
 * plan-start sentence from the catalog (the one wording Checkout, Home and the
 * Terms use); after it, the package billed while some channels are not yet in
 * service, and both ways another channel's price joins it: from its first
 * answer, or 30 days after it became ready while it waits on the clinic (BD4).
 * A setup-fee difference is named when one was charged, and never offered
 * back on a move down, because a setup fee is never refunded.
 *
 * "Prorated" only when it was (`isProrated`): a change of the billed price or
 * interval invoices the rest of the period at once (`always_invoice`). When
 * the billed package stays, the invoice is the setup-fee difference alone and
 * the price does not move, and saying otherwise would tell the clinic it had
 * been charged for a plan it is not yet billed for.
 *
 * A change that drops channels lists what the plan now covers. When it drops
 * the phone, the payload carries the clinic's forwarding facts, and the email
 * prints the catalog's steps for undoing call forwarding (R31): calls that
 * still forward to us now pass straight through to the direct line, which the
 * clinic should not have to discover from a caller.
 */

export type PlanChangedPayload = NoticePayloads["plan_changed"];

function forwardingFacts(payload: PlanChangedPayload): ForwardingFacts | null {
  if (payload.phoneSystem === undefined || payload.routing === undefined) return null;
  return {
    carrier: payload.carrier ?? null,
    phoneSystem: payload.phoneSystem,
    routing: payload.routing,
  };
}

export const renderPlanChanged: EmailTemplate<PlanChangedPayload> = (payload, ctx) => {
  const plan = planByName(payload.planName);
  // The allowlist reads billedPlanId as an opaque id, not a catalog plan id,
  // so an unknown one only leaves its sentence out rather than failing the email.
  const billed = payload.billedPlanId ? (getPlan(payload.billedPlanId) ?? null) : null;
  const billing = payload.interval === "year" ? "annually" : "monthly";
  const locations = payload.locations > 1 ? `, for ${payload.locations} locations` : "";

  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `Your healdesk plan is now ${payload.planName}, billed ${billing}${locations}.`,
    },
  ];

  if (payload.isBeforeStart) {
    blocks.push({
      type: "paragraph",
      // The catalog's sentence quotes one location's price, so it is kept for
      // the one-location case and the plain start rule serves the rest.
      text:
        plan && payload.locations === 1
          ? planStartSentence(plan, payload.interval, person(ctx))
          : `It starts the day AYA first answers a ${person(ctx)}.`,
    });
  } else {
    if (billed && billed.id !== plan?.id) {
      blocks.push({
        type: "paragraph",
        text: `Until every channel in it is in service, you're billed for ${billed.name}. Each other channel's price joins from the day it first answers. ${WAITING_CHANNEL_JOINS}`,
      });
    }
    if (payload.isProrated) {
      blocks.push({
        type: "paragraph",
        text: "The change is prorated: the invoice covers the difference for the rest of this billing period.",
      });
    }
  }

  if (payload.setupFeeDeltaCents > 0) {
    blocks.push({
      type: "paragraph",
      text:
        payload.isBeforeStart || payload.isProrated
          ? `The difference in setup fee, ${money(payload.setupFeeDeltaCents)}, was charged with the change.`
          : `The difference in setup fee, ${money(payload.setupFeeDeltaCents)}, was charged with the change, and that's all the invoice covers: the price you're billed hasn't changed.`,
    });
  }

  if (payload.hasDroppedChannels) {
    if (plan) {
      blocks.push(
        { type: "paragraph", text: "Your plan now covers:" },
        { type: "list", items: channelList(plan).map((channel) => CHANNEL_WORDS[channel].title) },
        { type: "paragraph", text: "AYA stops answering on any channel it doesn't cover." },
      );
    } else {
      blocks.push({
        type: "paragraph",
        text: "AYA stops answering on the channels your new plan doesn't cover.",
      });
    }
  }

  const forwarding = forwardingFacts(payload);
  if (forwarding) {
    blocks.push(
      ...undoForwarding(
        forwarding,
        "Phone isn't part of your new plan, so calls that forward to us now pass straight through to your direct line. Undo the forwarding so callers reach you directly.",
      ),
    );
  }

  if (payload.hostedInvoiceUrl) {
    blocks.push(
      { type: "action", label: "View the invoice", url: payload.hostedInvoiceUrl },
      cancelOnline({ beforeStart: payload.isBeforeStart }),
    );
  }

  return compose(
    {
      subject: `Your healdesk plan is now ${payload.planName}`,
      preheader: payload.isBeforeStart
        ? `It starts the day AYA first answers a ${person(ctx)}.`
        : `${payload.planName}, billed ${billing}.`,
      blocks,
    },
    ctx,
  );
};

export const PLAN_CHANGED_ENTRY: TemplateEntry<PlanChangedPayload> = {
  render: renderPlanChanged,
  fixture: {
    planName: "AYA Web Chat + Voice",
    interval: "month",
    locations: 1,
    setupFeeDeltaCents: 50_000,
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_testplatform/test_invoice",
    hasDroppedChannels: false,
    isBeforeStart: false,
    billedPlanId: "chat-web",
    isProrated: false,
  },
};
