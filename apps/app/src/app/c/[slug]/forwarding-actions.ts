"use server";

import { refresh } from "next/cache";

import type { ActorContext } from "@/lib/audit";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { savePhoneLine, type PhoneLineResult } from "@/lib/setup/phone-line";
import {
  clinicStartForwardingTest,
  readForwardingTest,
  type ForwardingTestView,
  type StartForwardingTestResult,
} from "@/lib/setup/forwarding-test-view";
import { withTenant } from "@/lib/tenant";

/**
 * The forwarding screen's actions, from the wizard's step 4 and Settings →
 * Channels alike: "Test it now" and the result it waits for
 * (lib/setup/forwarding-test-view.ts), and the phone-system and carrier
 * pickers, which save what the clinic picked so the steps emailed on (O11)
 * are the ones on its screen.
 *
 * Each calls requirePortal(slug) itself. None needs a step-up: a test call
 * and the kind of line move no calls and no money (plan Part D4). Business
 * data only: whether a call arrived and whether its number came through.
 */

async function contextFor(slug: string): Promise<{ clinicId: string; actor: ActorContext }> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  return {
    clinicId: portal.clinicId,
    actor: { type: "user", userId: portal.userId, label: actor.label },
  };
}

/** "Test it now": open the clinic's own forwarding-test window. */
export async function startForwardingTestAction(slug: string): Promise<StartForwardingTestResult> {
  const { clinicId, actor } = await contextFor(slug);
  const result = await withTenant({ clinicId, actor }, (tx) => clinicStartForwardingTest(tx));
  if (result.ok) refresh();
  return result;
}

/**
 * Where the test stands now, for the screen waiting on it; null when the
 * phone row shows no test. Refreshes the page once the test has a result,
 * so the status word reads what the result moved.
 */
export async function forwardingTestStatusAction(slug: string): Promise<ForwardingTestView | null> {
  const { clinicId, actor } = await contextFor(slug);
  const view = await withTenant({ clinicId, actor }, (tx) => readForwardingTest(tx));
  if (!view || view.state.kind === "passed") refresh();
  return view;
}

/** The phone-system and carrier pickers: what runs the main line, and who provides it. */
export async function savePhoneLineAction(
  slug: string,
  input: { phoneSystem: unknown; carrier: unknown },
): Promise<PhoneLineResult> {
  const { clinicId, actor } = await contextFor(slug);
  return withTenant({ clinicId, actor }, (tx) => savePhoneLine(tx, input));
}

/**
 * Settings' "Which calls reach AYA" was saved: read the page again, so
 * Safety net's undo steps follow the new mode as the steps shown beside the
 * choice already do (settings/CoverageSetting.tsx).
 */
export async function coverageSavedAction(slug: string): Promise<void> {
  await requirePortal(String(slug));
  refresh();
}
