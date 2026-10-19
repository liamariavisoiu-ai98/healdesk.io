import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { enterClinicEmailChange } from "@/lib/admin/address-change";
import { requireOperator } from "@/lib/admin/operator";
import {
  fetchClinicSignIn,
  setCoveredEntity as setCoveredEntityUpstream,
  stopClinicEmailChange as stopUpstream,
  type ChangeClinicEmailOutcome,
  type CoveredAnswer,
  type OpsResult,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { AccountPanel } from "./AccountPanel";

/**
 * /admin/ops/[clinicId]/account: the clinic's one address and the agreement
 * it is under (plan Part K, D5 and L).
 *
 * The address is the clinic's sign-in, the Stripe customer's email and the
 * agreement's notice address. When a clinic has lost the address itself, the
 * operator calls its published number back, then enters the new one here
 * with a fresh code from the authenticator (changeClinicEmail): it takes
 * effect 72 hours later, with notice to both addresses, and an objection in
 * that time is stopped here. The covered-entity answer is recorded here too;
 * on a practice under a data protection agreement, a "Yes" or "Not sure"
 * stops its client data at the database and starts its move to a business
 * associate agreement.
 *
 * Business contact data only. Every read and write is an operation on the
 * signed ops envelope; this app keeps nothing.
 */

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AccountPage({ params }: { params: Promise<{ clinicId: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { clinicId } = await params;
  if (!UUID.test(clinicId)) notFound();

  const view = await fetchClinicSignIn(clinicId);
  if (isHostUnreachable(view)) {
    return <HostStandbyPage title="Account" back={{ href: "/admin/ops", label: "Back to ops" }} />;
  }
  const path = `/admin/ops/${clinicId}/account`;

  async function changeEmail(input: {
    newEmail: string;
    code: string;
    calledBack: boolean;
  }): Promise<OpsResult<ChangeClinicEmailOutcome>> {
    "use server";
    // The session, the call back and a fresh code, in that order, before
    // anything crosses (lib/admin/address-change.ts).
    const result = await enterClinicEmailChange(clinicId, input);
    revalidatePath(path);
    return result;
  }

  async function stopChange() {
    "use server";
    const result = await stopUpstream(clinicId);
    revalidatePath(path);
    return result;
  }

  async function setCovered(answer: CoveredAnswer) {
    "use server";
    const result = await setCoveredEntityUpstream(clinicId, answer);
    revalidatePath(path);
    revalidatePath("/admin/ops");
    return result;
  }

  return <AccountPanel view={view} actions={{ changeEmail, stopChange, setCovered }} />;
}
