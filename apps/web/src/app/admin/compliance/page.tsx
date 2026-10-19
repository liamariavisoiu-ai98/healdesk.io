import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import { fetchPlatformCompliance } from "@/lib/admin/ops-client";
import { enterPlatformAttestation, openLaunchPromises } from "@/lib/admin/platform-compliance";
import { LAUNCH_PROMISES } from "@/lib/admin/seo/launch";
import { isHostUnreachable } from "@/lib/host/state";

import { CompliancePanel, type AttestationForm } from "./CompliancePanel";

/**
 * /admin/compliance: the platform's attestations (WP2; plan Part K,
 * "Platform-compliance attestation"; the Gates table). Go-live is automatic:
 * a clinic goes to production by itself once its own part is done and
 * everything here that its channel needs is attested. So this page is
 * where the human half of Gate B is said, and only here: the business
 * associate agreements in the chain (the model provider, the database host,
 * AWS, and Retell for phone) and the readiness flags (each channel's
 * runtime, phone's pass-through test, the launch promises).
 *
 * Each attestation or withdrawal is entered with a fresh code from the
 * operator's authenticator, checked on this app before the signed request
 * goes (lib/admin/platform-compliance.ts). A withdrawal never takes a live
 * channel offline; it holds back what has not gone live yet. What Gate B
 * names but does not ask, because it is not built, is listed beside it.
 *
 * Business data about the platform, never a clinic's or a patient's. Every
 * read and write is an operation on the signed ops envelope; this app keeps
 * nothing.
 */

export const metadata: Metadata = { title: "Compliance" };
export const dynamic = "force-dynamic";

const PATH = "/admin/compliance";

export default async function CompliancePage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const view = await fetchPlatformCompliance();
  if (isHostUnreachable(view)) return <HostStandbyPage title="Compliance" />;

  async function enter(input: AttestationForm) {
    "use server";
    const result = await enterPlatformAttestation(input);
    revalidatePath(PATH);
    return result;
  }

  const open = new Set(openLaunchPromises());
  return (
    <CompliancePanel
      view={view}
      openPromises={LAUNCH_PROMISES.filter((p) => open.has(p.id)).map((p) => ({
        id: p.id,
        promise: p.promise,
      }))}
      actions={{ enter }}
    />
  );
}
