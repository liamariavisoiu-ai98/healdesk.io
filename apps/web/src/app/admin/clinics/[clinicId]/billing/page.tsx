import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { clinicTabPath, isUuid } from "@/lib/admin/issue-link";
import { requireOperator } from "@/lib/admin/operator";
import {
  closeUnfinishedSetup as closeSetupUpstream,
  commitRefund as commitRefundUpstream,
  disconnectStripeConnect as disconnectUpstream,
  extendSetupDeadline as extendDeadlineUpstream,
  fetchClinicBilling,
  issueStripeConnectLink as connectLinkUpstream,
  liftSuspension as liftSuspensionUpstream,
  previewRefund as previewRefundUpstream,
  replayBillingEvent as replayBillingUpstream,
  replayConnectEvent as replayConnectUpstream,
  retryBillingRequest as retryRequestUpstream,
  retryLocationSetup as retryLocationUpstream,
  retryOverageInvoice as retryOverageUpstream,
  setAutoRenew as autoRenewUpstream,
  setClinicSettings as clinicSettingsUpstream,
  setDepositSettings as depositSettingsUpstream,
  setOverageMode as overageModeUpstream,
  setUsageAlerts as usageAlertsUpstream,
  type DepositSettingsInput,
  type RefundKind,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { BillingPanel } from "./BillingPanel";

/**
 * /admin/clinics/[id]/billing, the Billing tab: what was bought and what
 * Stripe bills, usage against the allowance, the switches (overage, alerts,
 * Pause, the direct line, deposits), Stripe Connect, the first-period refund,
 * and the billing engine's own ledgers with the support actions on them
 * (build spec §7 E, R35). Until the admin redesign (23 October 2026) this was
 * /admin/ops/[id]/billing, which redirects here forever.
 *
 * Nothing on this page is a patient. apps/app sends a hand-written
 * projection: event and notice payloads never cross, parked events arrive
 * as ids, types and codes, money as cents. For a location, the subscription
 * and its ledgers are its billing clinic's; Pause, the direct line, deposits
 * and Connect are the location's own.
 *
 * Every write is a server action that calls ops-client (whose session check
 * is the only door to the ops API) and then revalidates this tab. The
 * refund preview is the one read among them, so it revalidates nothing.
 */

export const metadata: Metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

export default async function BillingPage({ params }: { params: Promise<{ clinicId: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { clinicId } = await params;
  if (!isUuid(clinicId)) notFound();

  const view = await fetchClinicBilling(clinicId);
  if (isHostUnreachable(view)) return <HostStandbyNotice what="Billing" />;
  const path = clinicTabPath(clinicId, "billing");

  async function setOverageMode(mode: "allow" | "hard_cap") {
    "use server";
    const result = await overageModeUpstream(clinicId, mode);
    revalidatePath(path);
    return result;
  }
  async function setUsageAlerts(on: boolean) {
    "use server";
    const result = await usageAlertsUpstream(clinicId, on);
    revalidatePath(path);
    return result;
  }
  async function setClinicSettings(input: {
    directLineE164?: string | null;
    aiPaused?: boolean;
    aiPausedUntil?: string | null;
  }) {
    "use server";
    const result = await clinicSettingsUpstream(clinicId, input);
    revalidatePath(path);
    return result;
  }
  async function setDepositSettings(input: DepositSettingsInput) {
    "use server";
    const result = await depositSettingsUpstream(clinicId, input);
    revalidatePath(path);
    return result;
  }
  async function issueConnectLink() {
    "use server";
    const result = await connectLinkUpstream(clinicId);
    revalidatePath(path);
    return result;
  }
  async function disconnectConnect() {
    "use server";
    const result = await disconnectUpstream(clinicId);
    revalidatePath(path);
    return result;
  }
  async function setAutoRenew(on: boolean) {
    "use server";
    const result = await autoRenewUpstream(clinicId, on);
    revalidatePath(path);
    return result;
  }
  async function previewRefund(kind: RefundKind) {
    "use server";
    return previewRefundUpstream(clinicId, kind);
  }
  async function commitRefund(input: {
    kind: RefundKind;
    confirmAmountCents: number;
    reason: string;
  }) {
    "use server";
    const result = await commitRefundUpstream(clinicId, input);
    revalidatePath(path);
    return result;
  }
  async function liftSuspension(reason: string) {
    "use server";
    const result = await liftSuspensionUpstream(clinicId, reason);
    revalidatePath(path);
    return result;
  }
  async function extendSetupDeadline(input: { days: number; fromDeadline: string }) {
    "use server";
    const result = await extendDeadlineUpstream(clinicId, input);
    revalidatePath(path);
    return result;
  }
  async function closeUnfinishedSetup() {
    "use server";
    const result = await closeSetupUpstream(clinicId);
    revalidatePath(path);
    return result;
  }
  async function retryBillingRequest(requestId: string) {
    "use server";
    const result = await retryRequestUpstream(clinicId, requestId);
    revalidatePath(path);
    return result;
  }
  async function retryLocationSetup() {
    "use server";
    const result = await retryLocationUpstream(clinicId);
    revalidatePath(path);
    return result;
  }
  async function retryOverageInvoice(windowStart: string) {
    "use server";
    const result = await retryOverageUpstream(clinicId, windowStart);
    revalidatePath(path);
    return result;
  }
  async function replayBillingEvent(eventId: string) {
    "use server";
    const result = await replayBillingUpstream(eventId);
    revalidatePath(path);
    return result;
  }
  async function replayConnectEvent(eventId: string) {
    "use server";
    const result = await replayConnectUpstream(eventId);
    revalidatePath(path);
    return result;
  }

  return (
    <BillingPanel
      view={view}
      actions={{
        setOverageMode,
        setUsageAlerts,
        setClinicSettings,
        setDepositSettings,
        issueConnectLink,
        disconnectConnect,
        setAutoRenew,
        previewRefund,
        commitRefund,
        liftSuspension,
        extendSetupDeadline,
        closeUnfinishedSetup,
        retryBillingRequest,
        retryLocationSetup,
        retryOverageInvoice,
        replayBillingEvent,
        replayConnectEvent,
      }}
    />
  );
}
