import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { requireOperator } from "@/lib/admin/operator";
import {
  approveAgentConfig as approveUpstream,
  completeOnboardingStep as completeUpstream,
  fetchOnboarding,
  goLive as goLiveUpstream,
  reopenOnboardingStep as reopenUpstream,
  setPhoneSettings as phoneUpstream,
  updateAgentConfig as agentUpstream,
  type AgentService,
} from "@/lib/admin/ops-client";

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

  return (
    <OnboardingPanel
      view={view}
      actions={{ completeStep, reopenStep, savePhone, saveAgent, approveAgent, goLive }}
    />
  );
}
