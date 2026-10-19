"use server";

import { randomUUID } from "node:crypto";

import { isBillingInterval } from "@healdesk/catalog";

import { setCoveredEntity } from "@/lib/agreements/covered-entity";
import { readOpenResign, resignPath } from "@/lib/agreements/resign";
import { addLocation, changePlan, createPortalSession } from "@/lib/billing/stripe-actions";
import { previewAddLocation, previewChangePlan } from "@/lib/billing/summary";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { isBillingSwitchKey, setBillingSwitch } from "@/lib/portal/billing";
import { stepUpPath, touchStepUp } from "@/lib/portal/step-up";
import { publicUrl } from "@/lib/public-url";

/**
 * Billing's server actions (plan Part F6): this plan's screen over Package
 * C's actions, which carry every rule and every charge. Each calls
 * requirePortal(slug) itself.
 *
 * The three switches, changing the plan and adding a location need a passkey
 * step-up (Part F6); the previews and Stripe's own portal for the card and
 * invoices do not. Without a step-up the action answers with the step-up
 * page's address, so the screen says why before it sends the browser there.
 */

export type BillingActionResult =
  { ok: true; toast: string; href?: string } | { ok: false; message: string; stepUpHref?: string };

const STEP_UP = "This change needs Face ID or your screen lock on a device you've added.";

function billingPath(slug: string): string {
  return `/c/${slug}/billing`;
}

export async function saveBillingSwitchAction(
  slug: string,
  key: string,
  value: unknown,
): Promise<BillingActionResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  if (!isBillingSwitchKey(key))
    return { ok: false, message: "That isn't one of Billing's switches." };
  if (!actor.steppedUp) {
    return {
      ok: false,
      message: STEP_UP,
      stepUpHref: stepUpPath(portal.clinicSlug, billingPath(portal.clinicSlug)),
    };
  }
  await touchStepUp(portal);
  return setBillingSwitch(
    { clinicId: portal.clinicId, userId: portal.userId, actorLabel: actor.label },
    key,
    value,
  );
}

export type PlanPreview = Awaited<ReturnType<typeof previewChangePlan>> & { requestId?: string };

/**
 * What a plan change would cost, before anything is charged: the setup-fee
 * difference first, then the rest. A fresh request id rides back with it,
 * and confirming sends it again, so a retry of the same confirmation is
 * recognised by Stripe and never charged twice.
 */
export async function previewPlanAction(
  slug: string,
  planId: string,
  interval: string,
): Promise<PlanPreview> {
  const portal = await requirePortal(String(slug));
  if (!isBillingInterval(interval)) {
    return { status: "refused", message: "Choose monthly or annual billing." };
  }
  const preview = await previewChangePlan({
    clinicId: portal.clinicId,
    planId: String(planId),
    interval,
  });
  return preview.status === "ok" ? { ...preview, requestId: randomUUID() } : preview;
}

export async function changePlanAction(
  slug: string,
  input: { planId: unknown; interval: unknown; requestId: unknown },
): Promise<BillingActionResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  if (!actor.steppedUp) {
    return {
      ok: false,
      message: STEP_UP,
      stepUpHref: stepUpPath(portal.clinicSlug, billingPath(portal.clinicSlug)),
    };
  }
  if (!isBillingInterval(input.interval) || typeof input.planId !== "string") {
    return { ok: false, message: "Choose a plan and how it's billed." };
  }
  await touchStepUp(portal);
  const result = await changePlan({
    clinicId: portal.clinicId,
    planId: input.planId,
    interval: input.interval,
    requestId: typeof input.requestId === "string" ? input.requestId : "",
    actorLabel: actor.label,
  });
  if (result.status !== "changed") return { ok: false, message: result.message };
  return {
    ok: true,
    toast:
      result.droppedChannels.length > 0
        ? "Your plan is changed. A channel that's answering now isn't in the new plan, so it passes its calls and messages to your team."
        : "Your plan is changed. We've emailed you the details.",
    ...(result.hostedInvoiceUrl ? { href: result.hostedInvoiceUrl } : {}),
  };
}

export async function previewLocationAction(slug: string) {
  const portal = await requirePortal(String(slug));
  const preview = await previewAddLocation(portal.clinicId);
  return preview.status === "ok" ? { ...preview, requestId: randomUUID() } : preview;
}

export async function addLocationAction(
  slug: string,
  input: { requestId: unknown; name: unknown },
): Promise<BillingActionResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  if (!actor.steppedUp) {
    return {
      ok: false,
      message: STEP_UP,
      stepUpHref: stepUpPath(portal.clinicSlug, billingPath(portal.clinicSlug)),
    };
  }
  await touchStepUp(portal);
  const result = await addLocation({
    clinicId: portal.clinicId,
    requestId: typeof input.requestId === "string" ? input.requestId : "",
    actorLabel: actor.label,
    ...(typeof input.name === "string" && input.name.trim() ? { name: input.name } : {}),
  });
  if (result.status === "added") {
    return {
      ok: true,
      toast: "The location is added. Its own setup comes next.",
      href: `/c/${result.slug}/setup`,
    };
  }
  return result.status === "pending_setup"
    ? { ok: true, toast: result.message }
    : { ok: false, message: result.message };
}

/**
 * Stripe's own portal, for the card and the invoices (spec: they "deep-link
 * into Stripe's own portal rather than being rebuilt"). Its address lasts
 * about five minutes, so it is made on the click and never stored or mailed.
 */
export async function openStripePortalAction(
  slug: string,
  flow: "payment_method_update" | null,
): Promise<BillingActionResult> {
  const portal = await requirePortal(String(slug));
  let returnUrl: string;
  try {
    returnUrl = publicUrl(billingPath(portal.clinicSlug));
  } catch {
    return { ok: false, message: "Stripe can't be opened right now. Try again in a minute." };
  }
  const session = await createPortalSession({
    clinicId: portal.clinicId,
    returnUrl,
    ...(flow === "payment_method_update" ? { flow } : {}),
  });
  return "url" in session
    ? { ok: true, toast: "Opening Stripe…", href: session.url }
    : {
        ok: false,
        message:
          "Stripe's billing page isn't available for this account right now. Email hello@healdesk.io and we'll help.",
      };
}

/**
 * "We've started billing insurance electronically" (plan Part L), on a
 * practice under the Data Protection Agreement: the practice's own "Yes",
 * recorded through setCoveredEntity exactly as ops records one. From that
 * write the DPA no longer covers it, AYA pauses, and L22 goes with its link;
 * the browser is sent straight to the agreement to sign. Behind a passkey
 * step-up: it stops AYA answering on every channel until it is signed. Once a
 * re-sign is open, the same button opens it with a fresh link.
 */
export async function startAgreementResignAction(slug: string): Promise<BillingActionResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  if (!actor.steppedUp) {
    return {
      ok: false,
      message: STEP_UP,
      stepUpHref: stepUpPath(portal.clinicSlug, `${billingPath(portal.clinicSlug)}#agreement`),
    };
  }
  await touchStepUp(portal);
  const actorContext = { type: "user" as const, userId: portal.userId, label: actor.label };
  const open = await readOpenResign(portal.clinicId, actorContext);
  if (open) {
    return {
      ok: true,
      toast: "Opening your updated agreement…",
      href: resignPath({ id: open.id, clinicId: portal.clinicId }),
    };
  }
  const outcome = await setCoveredEntity({
    clinicId: portal.clinicId,
    answer: "yes",
    actor: actorContext,
    actorLabel: actor.label,
    source: "portal",
  });
  if (outcome.status === "refused") return { ok: false, message: outcome.message };
  const resignId = outcome.supersede?.resignId;
  if (!resignId) {
    return { ok: true, toast: "Recorded. Your agreement already covers a practice that bills insurance." };
  }
  return {
    ok: true,
    toast: "AYA is paused until it's signed. Opening your updated agreement…",
    href: resignPath({ id: resignId, clinicId: portal.clinicId }),
  };
}
