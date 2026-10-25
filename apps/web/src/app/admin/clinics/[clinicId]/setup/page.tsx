import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { clinicTabPath, isUuid } from "@/lib/admin/issue-link";
import { requireOperator } from "@/lib/admin/operator";
import {
  acknowledgeClinicChange as acknowledgeChangeUpstream,
  attachMetaChannel as metaChannelUpstream,
  confirmWebWidget as confirmWidgetUpstream,
  decideLifecycle as decideLifecycleUpstream,
  extendSetupDeadline as extendDeadlineUpstream,
  fetchClinicAudits,
  fetchClinicCards,
  fetchClinicBilling,
  fetchClinicChanges,
  fetchLifecycle,
  fetchLifecycleIgnored,
  fetchStuckCalendarWrites,
  fetchVoiceAgentReport,
  fetchVoiceAgentStatus,
  runClinicAudit as runAuditUpstream,
  setLifecycleIgnored as setIgnoredUpstream,
  snoozeLifecycle as snoozeLifecycleUpstream,
  setMetaFrontDoor as metaSwitchUpstream,
  setMetaPlatform as metaPlatformUpstream,
  completeOnboardingStep as completeUpstream,
  disconnectCalendar as disconnectCalendarUpstream,
  fetchOnboarding,
  goLive as goLiveUpstream,
  issueCalendarLink as calendarLinkUpstream,
  issueConnectLink as issueConnectLinkUpstream,
  proposeLifecycleNotice as proposeNoticeUpstream,
  pullReminderForward as pullReminderUpstream,
  reopenOnboardingStep as reopenUpstream,
  rerunPracticeQuestions as rerunPracticeUpstream,
  retryCalendarWrite as retryWriteUpstream,
  setAutoConfirm as autoConfirmUpstream,
  setBookingRequirements as requirementsUpstream,
  setClinicTimezone as timezoneUpstream,
  setPhoneSettings as phoneUpstream,
  startForwardingTest as forwardingTestUpstream,
  syncDemoVoiceAgent as demoAgentUpstream,
  updateAgentConfig as agentUpstream,
  type AgentService,
  type ContactPhrase,
  type DepositPolicy,
  type LifecycleNoticeKind,
  type MetaPlatform,
} from "@/lib/admin/ops-client";
import { clearVoiceDriftFlagWithCode as enterVoiceDriftClear, retryVoiceAgentWithCode as enterVoiceRetry } from "@/lib/admin/voice-drift";
import { PHRASE_WORDS } from "@/components/admin/approval-words";
import { isHostUnreachable } from "@/lib/host/state";

import { AvailabilityChanges } from "./AvailabilityChanges";
import { CalendarWrites } from "./CalendarWrites";
import { ConnectLink } from "./ConnectLink";
import { DemoVoiceAgent } from "./DemoVoiceAgent";
import { OnboardingPanel } from "./OnboardingPanel";
import { SetupSummary } from "./SetupSummary";
import { SetupWatchStub, SetupWindow, type SnoozeDays, type WindowDeadline } from "./SetupWindow";
import { VoiceAgentCard } from "./VoiceAgentCard";

/**
 * /admin/clinics/[id]/setup, the Setup tab: one clinic's road from payment to
 * the first answered call, for the operator running the onboarding call.
 * Until the admin redesign (23 October 2026) this was /admin/ops/[id]/onboarding,
 * which redirects here forever.
 *
 * Nothing here is patient-level: the checklist, the phone facts, the
 * forwarding codes, the words the agent will say, all clinic configuration,
 * where go-live stands, the Retell set-up (never its number) and the calendar
 * writes that have not settled (ids, codes and counts; never the person or
 * the service). No control here approves the agent's words or
 * passes a channel's audit: the practice questions do both, and a run they
 * flag waits in Queues › Reviews. The operator identity for every write comes
 * from the session cookie inside ops-client, never from this page.
 */

export const metadata: Metadata = { title: "Setup" };
export const dynamic = "force-dynamic";

export default async function SetupPage({ params }: { params: Promise<{ clinicId: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { clinicId } = await params;
  if (!isUuid(clinicId)) notFound();

  // Nine reads, settled independently: the onboarding view, the clinic cards
  // (the agreement, channels and build line; not the whole Clinics strip),
  // the availability changes, this clinic's audits (no history: the page
  // does not show it), its lifecycle row alone, the billing view, whose
  // setup deadline is the live one the extension names, this clinic's voice
  // set-up, this clinic's stuck calendar writes (its tenant alone is read,
  // demo or not, so the demo clinic's own tab shows its own), and the watch's ignore list for this clinic alone, read apart
  // from the lifecycle row so a mark set before the watch's first tick is
  // drawn. One that fails costs its card.
  const [view, cards, changes, audits, lifecycle, billing, voice, stuckWrites, ignoreList] = await Promise.all([
    fetchOnboarding(clinicId),
    fetchClinicCards(),
    fetchClinicChanges({ clinicId }),
    fetchClinicAudits(clinicId, { history: false }),
    fetchLifecycle(clinicId),
    fetchClinicBilling(clinicId),
    fetchVoiceAgentStatus(clinicId),
    fetchStuckCalendarWrites({ clinicId }),
    fetchLifecycleIgnored(clinicId),
  ]);
  if (isHostUnreachable(view)) return <HostStandbyNotice what="Setup" />;
  const path = clinicTabPath(clinicId, "setup");
  const now = new Date().toISOString();
  // The read-back link's connection state is not read here: the only read
  // that has it is every clinic's list (the whole Clinics strip, ten
  // statements a clinic), and that list skipped the per-clinic lookup anyway,
  // so it was always "not checked". The disclosure is phase two.
  const connection = null;
  const watched = lifecycle.ok ? (lifecycle.data.find((r) => r.clinicId === clinicId.toLowerCase()) ?? null) : null;
  // The Billing tab's own rule for its extension control, kept identical here.
  const entitlements = billing.ok ? billing.data.entitlements : null;
  const deadline: WindowDeadline | null =
    entitlements?.setupDeadlineIso ? { at: entitlements.setupDeadlineAt ?? entitlements.setupDeadlineIso, iso: entitlements.setupDeadlineIso } : null;
  const canExtend = entitlements !== null && !entitlements.isPlanStarted && entitlements.status !== "canceled" && entitlements.status !== "purged";
  // The voice card is for a clinic whose package has phone: the cards read
  // says which channels were bought. A clinic the cards did not cover (a
  // failed read, or one past the read's limit) keeps the card, since nothing
  // says it has no phone.
  const card = cards.ok ? (cards.data.cards.find((c) => c.id === clinicId.toLowerCase()) ?? null) : null;
  const hasPhone = card === null || card.channels.some((c) => c.channel === "voice");
  const onIgnoreList = ignoreList.ok && ignoreList.data.some((r) => r.clinicId === clinicId.toLowerCase());

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
  async function goLive() {
    "use server";
    const result = await goLiveUpstream(clinicId);
    revalidatePath(path);
    revalidatePath("/admin/clinics");
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

  // Channel events. No audit is passed here: only the practice questions
  // pass one, by themselves or through a decision in Queues › Reviews. What
  // the console can do is ask them again, for every channel at once.
  async function rerunPractice() {
    "use server";
    const result = await rerunPracticeUpstream(clinicId);
    revalidatePath(path);
    return result;
  }
  async function confirmWidget() {
    "use server";
    const result = await confirmWidgetUpstream(clinicId);
    revalidatePath(path);
    return result;
  }
  // Phase two: the read-back credential's one-time link (E1 §2 keeps the op
  // and moves the form here, behind a disclosure). The clinic's id is this
  // page's, never one the browser sends.
  async function issueConnectLink(_clinicId: string, recipientEmail: string | null) {
    "use server";
    const result = await issueConnectLinkUpstream(clinicId, recipientEmail);
    revalidatePath(path);
    return result;
  }
  // The availability changes card (wave 2): one run of every pack, once a
  // minute per clinic; a change marked as looked at. The clinic's id is this
  // page's.
  async function runAudit() {
    "use server";
    const result = await runAuditUpstream(clinicId);
    revalidatePath(path);
    return result;
  }
  async function acknowledgeChange(changeId: string) {
    "use server";
    const result = await acknowledgeChangeUpstream(changeId, clinicId);
    revalidatePath(path);
    return result;
  }
  // The setup window card: the extension names the deadline the page showed
  // (apps/app refuses once it has moved, so a replay cannot add days twice),
  // the decision and the snooze are the lifecycle watch's.
  async function extendWindow(input: { days: number; fromDeadline: string }) {
    "use server";
    // The deadline the page showed, from the billing view, exactly as it
    // arrived: apps/app refuses once it has moved. Whole days, 1 to 30, as
    // the form and apps/app allow.
    const days = Number(input.days);
    const fromDeadline = input.fromDeadline;
    if (!Number.isInteger(days) || days < 1 || days > 30 || typeof fromDeadline !== "string" || Number.isNaN(Date.parse(fromDeadline))) {
      return { ok: true as const, data: { status: "refused" as const, message: "Days must be a whole number from 1 to 30, from the deadline shown." } };
    }
    const result = await extendDeadlineUpstream(clinicId, { days, fromDeadline });
    revalidatePath(path);
    revalidatePath(clinicTabPath(clinicId, "billing"));
    return result;
  }
  async function decideWindow(decision: "extension_offered" | "let_close") {
    "use server";
    const result = await decideLifecycleUpstream(clinicId, decision);
    revalidatePath(path);
    return result;
  }
  async function snoozeWindow(days: SnoozeDays) {
    "use server";
    const result = await snoozeLifecycleUpstream(clinicId, days === 3 || days === 14 ? days : 7);
    revalidatePath(path);
    return result;
  }
  // The Setup window card's four proposals (lane P6j; the operations are lane
  // P6f's): each puts an email to the clinic in Approvals for the owner's
  // yes and sends nothing. The kind, the days and the phrase are checked
  // here against apps/app's own list and range; a note is never sent from
  // this card (the owner adds one under Approvals, from the approved list).
  const NOTICE_KINDS: readonly LifecycleNoticeKind[] = ["setup_extended", "setup_waiting_on_us", "setup_help_offer"];
  async function proposeNotice(input: { kind: LifecycleNoticeKind; days?: number; phrase?: ContactPhrase }) {
    "use server";
    const refused = (message: string) => ({ ok: true as const, data: { status: "refused" as const, message } });
    if (!NOTICE_KINDS.includes(input.kind)) return refused("Pick one of the three notices.");
    if (input.days !== undefined && (!Number.isInteger(input.days) || input.days < 1 || input.days > 30)) {
      return refused("Days must be a whole number from 1 to 30.");
    }
    if (input.phrase !== undefined && !Object.hasOwn(PHRASE_WORDS, input.phrase)) return refused("What the email names must be one of the listed parts of setup.");
    const result = await proposeNoticeUpstream({
      clinicId,
      kind: input.kind,
      ...(input.kind === "setup_extended" && input.days !== undefined ? { days: input.days } : {}),
      ...(input.kind !== "setup_extended" && input.phrase !== undefined ? { phrase: input.phrase } : {}),
    });
    revalidatePath(path);
    return result;
  }
  async function pullReminder() {
    "use server";
    const result = await pullReminderUpstream(clinicId);
    revalidatePath(path);
    return result;
  }
  // The lifecycle watch's ignore list (lane P5d): one of healdesk's own test
  // accounts off the watch, or back on it, with the closed reason word (apps/
  // app clears the note itself when the mark is lifted). The clinic's id is
  // this page's.
  async function setIgnored(ignored: boolean) {
    "use server";
    const result = await setIgnoredUpstream(clinicId, ignored === true, "internal_test_account");
    revalidatePath(path);
    revalidatePath("/admin/clinics");
    return result;
  }
  // The voice agent card (Phase 5, lane P5a's operations): one more
  // provisioning run, which can buy a number, and the drift flag's clear,
  // both entering through lib/admin/voice-drift.ts (the session, then the
  // fresh code, then the signed request), never the raw ops client; and the
  // read-back against Retell.
  async function retryVoice(code: string) {
    "use server";
    const result = await enterVoiceRetry(clinicId, code);
    revalidatePath(path);
    return result;
  }
  async function checkVoice() {
    "use server";
    return fetchVoiceAgentReport(clinicId);
  }
  async function clearDriftFlag(code: string) {
    "use server";
    const result = await enterVoiceDriftClear(clinicId, code);
    revalidatePath(path);
    return result;
  }
  // The demo clinic's hand-made Retell agent (24 October 2026). The clinic's
  // id is this page's; apps/app checks the agent id and refuses a clinic
  // that is not the demo one.
  async function syncDemoAgent(agentId: string) {
    "use server";
    return demoAgentUpstream(clinicId, String(agentId).trim());
  }
  // The booking view is the one read that says demo; a page without it (an older apps/app) shows no card.
  const booking = view.ok ? view.data.booking : null;
  const demo = typeof booking === "object" && booking?.demo === true;

  return (
    <>
      <SetupSummary cards={cards} clinicId={clinicId} />
      {/* Only a clinic the lifecycle watch covers has a window card; a read that failed is said once. */}
      {watched ? (
        <SetupWindow
          // Keyed on the deadline: a page re-rendered after an extension shows the new one and the days input starts over.
          key={deadline?.iso ?? "none"}
          row={watched}
          deadline={deadline}
          canExtend={canExtend}
          now={now}
          onExtend={extendWindow}
          onDecide={decideWindow}
          onSnooze={snoozeWindow}
          onSetIgnored={setIgnored}
          onProposeNotice={proposeNotice}
          onPullReminder={pullReminder}
        />
      ) : null}
      {/* A clinic still in setup (the Billing tab's rule) that the watch has not seen yet, and is not the demo: the one line and the ignore control. */}
      {!watched && lifecycle.ok && !demo && canExtend ? <SetupWatchStub ignored={onIgnoreList} onSetIgnored={setIgnored} /> : null}
      {!lifecycle.ok && !isHostUnreachable(lifecycle) ? <p role="status" className="text-red-deep mt-4 text-sm font-semibold">Could not read the setup window: {lifecycle.message}</p> : null}
      {hasPhone ? <VoiceAgentCard read={voice} actions={{ retry: retryVoice, check: checkVoice, clearFlag: clearDriftFlag }} /> : null}
      <CalendarWrites clinicId={clinicId} writes={stuckWrites} now={now} onRetry={retryCalendarWrite} />
      <AvailabilityChanges clinicId={clinicId} changes={changes} audits={audits} now={now} onRunAudit={runAudit} onAcknowledge={acknowledgeChange} />
      <OnboardingPanel
        view={view}
        actions={{
          completeStep, reopenStep, savePhone, saveAgent, goLive, startForwardingTest, attachMeta, setMeta, setMetaPlatform,
          saveRequirements, confirmTimezone, retryCalendarWrite, setAutoConfirm, sendCalendarLink,
          disconnectCalendar, rerunPractice, confirmWidget,
        }}
      />
      {demo ? <DemoVoiceAgent onSync={syncDemoAgent} /> : null}
      <ConnectLink clinicId={clinicId} connection={connection} onIssue={issueConnectLink} />
    </>
  );
}
