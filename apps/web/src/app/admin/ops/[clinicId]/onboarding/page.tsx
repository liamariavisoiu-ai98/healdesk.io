import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import {
  approveAgentConfig as approveUpstream,
  attachMetaChannel as metaChannelUpstream,
  attestChannelAudit as attestAuditUpstream,
  confirmWebWidget as confirmWidgetUpstream,
  setMetaFrontDoor as metaSwitchUpstream,
  setMetaPlatform as metaPlatformUpstream,
  completeOnboardingStep as completeUpstream,
  disconnectCalendar as disconnectCalendarUpstream,
  fetchOnboarding,
  goLive as goLiveUpstream,
  issueCalendarLink as calendarLinkUpstream,
  issueSetupLink as setupLinkUpstream,
  reopenOnboardingStep as reopenUpstream,
  retryCalendarWrite as retryWriteUpstream,
  setAutoConfirm as autoConfirmUpstream,
  setBookingRequirements as requirementsUpstream,
  setClinicTimezone as timezoneUpstream,
  setPhoneSettings as phoneUpstream,
  startForwardingTest as forwardingTestUpstream,
  updateAgentConfig as agentUpstream,
  type AgentService,
  type ChannelId,
  type DepositPolicy,
  type MetaPlatform,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { OnboardingPanel } from "./OnboardingPanel";

/**
 * /admin/ops/[clinicId]/onboarding — one clinic's road from payment to the
 * first answered call, for the operator running the onboarding call.
 *
 * This IS a per-clinic screen, which the ops console says it deliberately
 * lacks. The distinction it draws still holds: nothing here is patient-level.
 * The page shows the checklist, the phone facts, the forwarding codes, and
 * the words the agent will say — all clinic configuration, the same class
 * the overview function already exposes — and the go-live switch. The
 * operator identity for every write comes from the session cookie inside
 * ops-client, never from this page.
 */

export const metadata: Metadata = { title: "Onboarding" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ clinicId: string }>;
}) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { clinicId } = await params;
  if (!UUID.test(clinicId)) notFound();

  const view = await fetchOnboarding(clinicId);
  if (isHostUnreachable(view)) return <HostStandbyPage title="Onboarding" back={{ href: "/admin/ops", label: "Back to ops" }} />;
  const path = `/admin/ops/${clinicId}/onboarding`;

  async function completeStep(step: string, note?: string) {
    "use server";
    const result = await completeUpstream(clinicId, step, note);
    revalidatePath(path);
    return result;
  }
  async function reopenStep(step: string, note?: string) {
    "use server";
    const result = await reopenUpstream(clinicId, step, note);
    revalidatePath(path);
    return result;
  }
  async function savePhone(settings: Parameters<typeof phoneUpstream>[1]) {
    "use server";
    const result = await phoneUpstream(clinicId, settings);
    revalidatePath(path);
    return result;
  }
  async function saveAgent(input: {
    greeting: string;
    services: AgentService[];
    escalationPhone: string | null;
    escalationHours: string | null;
    notes: string | null;
    depositPolicy: DepositPolicy | null;
  }) {
    "use server";
    const result = await agentUpstream(clinicId, input);
    revalidatePath(path);
    return result;
  }
  async function approveAgent(approvedBy: string) {
    "use server";
    const result = await approveUpstream(clinicId, approvedBy);
    revalidatePath(path);
    return result;
  }
  async function goLive() {
    "use server";
    const result = await goLiveUpstream(clinicId);
    revalidatePath(path);
    revalidatePath("/admin/ops");
    return result;
  }
  async function startForwardingTest() {
    "use server";
    const result = await forwardingTestUpstream(clinicId);
    revalidatePath(path);
    return result;
  }
  async function attachMeta(input: { platform: MetaPlatform; externalId: string; accessToken: string; label?: string }) {
    "use server";
    const result = await metaChannelUpstream(clinicId, input);
    revalidatePath(path);
    return result;
  }
  async function setMeta(enabled: boolean) {
    "use server";
    const result = await metaSwitchUpstream(clinicId, enabled);
    revalidatePath(path);
    return result;
  }
  async function setMetaPlatform(platform: MetaPlatform, enabled: boolean) {
    "use server";
    const result = await metaPlatformUpstream(clinicId, platform, enabled);
    revalidatePath(path);
    return result;
  }
  // Booking hand-off (design of 23 September 2026).
  async function saveRequirements(fields: string[]) {
    "use server";
    const result = await requirementsUpstream(clinicId, fields);
    revalidatePath(path);
    return result;
  }
  async function resendSetupLink(to: string | null) {
    "use server";
    const result = await setupLinkUpstream(clinicId, to);
    revalidatePath(path);
    return result;
  }
  async function confirmTimezone(timezone: string) {
    "use server";
    const result = await timezoneUpstream(clinicId, timezone);
    revalidatePath(path);
    return result;
  }
  async function retryCalendarWrite(appointmentId: string) {
    "use server";
    const result = await retryWriteUpstream(clinicId, appointmentId);
    revalidatePath(path);
    return result;
  }
  // The booking mode and the Google Calendar (plan §10). The mode is derived
  // upstream; Auto-confirm is the only switch here, and the clinic's id is
  // this page's, never one the browser sends.
  async function setAutoConfirm(on: boolean) {
    "use server";
    const result = await autoConfirmUpstream(clinicId, on === true);
    revalidatePath(path);
    return result;
  }
  async function sendCalendarLink() {
    "use server";
    const result = await calendarLinkUpstream(clinicId);
    revalidatePath(path);
    return result;
  }
  async function disconnectCalendar() {
    "use server";
    const result = await disconnectCalendarUpstream(clinicId);
    revalidatePath(path);
    return result;
  }

  // Channel events: the operator says a channel's audit passed, until the
  // practice questions exist. The clinic's id is this page's.
  async function attestAudit(channel: ChannelId) {
    "use server";
    const result = await attestAuditUpstream(clinicId, channel);
    revalidatePath(path);
    return result;
  }

  async function confirmWidget() {
    "use server";
    const result = await confirmWidgetUpstream(clinicId);
    revalidatePath(path);
    return result;
  }

  return (
    <OnboardingPanel
      view={view}
      actions={{
        completeStep, reopenStep, savePhone, saveAgent, approveAgent, goLive, startForwardingTest, attachMeta, setMeta, setMetaPlatform,
        saveRequirements, resendSetupLink, confirmTimezone, retryCalendarWrite, setAutoConfirm, sendCalendarLink,
        disconnectCalendar, attestAudit, confirmWidget,
      }}
    />
  );
}
