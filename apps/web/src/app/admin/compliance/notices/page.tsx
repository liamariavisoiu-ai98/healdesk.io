import type {
  GuaranteeFailure,
  GuaranteeOutcome,
  PhiSubcontractor,
  ProductUpdateCode,
  SuspensionCause,
  TermsChangeTopic,
} from "@healdesk/catalog";
import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import {
  fetchClinics,
  fetchOperatorNotices,
  recordGuaranteeClaim as claimUpstream,
  sendGuaranteeFinding as findingUpstream,
  sendProductUpdate as productUpdateUpstream,
  sendSubprocessorNotice as subprocessorUpstream,
  sendTermsNotice as termsUpstream,
  startBaaVersionResigns as baaResignsUpstream,
  suspendForCause as suspendUpstream,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { NoticesBoard } from "./NoticesBoard";

/**
 * /admin/compliance/notices (until 23 October 2026 /admin/notices): the emails an operator sends a practice, and the record of
 * what went (WP7; plan Part K; Annex X5):
 *
 *   - L28, a change to the terms or to prices, to every practice with an
 *     agreement in effect, at least 30 days ahead;
 *   - L29, a new subcontractor that will handle protected information, to
 *     the same practices, as far ahead as each one's agreement promises;
 *   - L33, a product update, to every practice still with us, behind its
 *     switch and one-click stop link;
 *   - L22, the updated business associate agreement to sign, to every
 *     account on an older version of it, each one's re-sign opened (wave 2
 *     R11; the hourly job opens one by itself once a release's floor has
 *     passed the version);
 *   - L30, a guarantee claim received and then our finding, to one practice;
 *   - L31, a suspension for a legal or security reason, to one practice:
 *     it suspends the service and emails why.
 *
 * Every form sends the catalog's codes, dates and ids through the ops
 * envelope; apps/app renders each email from them. Nothing typed here
 * reaches a practice, and none of it is a patient's.
 */

export const metadata: Metadata = { title: "Notices" };
export const dynamic = "force-dynamic";

const PATH = "/admin/compliance/notices";

export default async function NoticesPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const [record, clinics] = await Promise.all([fetchOperatorNotices(), fetchClinics({ connectionState: false })]);
  if (isHostUnreachable(record)) return <HostStandbyPage title="Notices" />;

  async function sendTermsNotice(input: {
    version: string;
    effectiveOn: string;
    topics: TermsChangeTopic[];
    isPublished: boolean;
  }) {
    "use server";
    const result = await termsUpstream(input);
    revalidatePath(PATH);
    return result;
  }
  async function sendSubprocessorNotice(input: { provider: PhiSubcontractor; startsAt: string }) {
    "use server";
    const result = await subprocessorUpstream(input);
    revalidatePath(PATH);
    return result;
  }
  async function sendProductUpdate(code: ProductUpdateCode) {
    "use server";
    const result = await productUpdateUpstream(code);
    revalidatePath(PATH);
    return result;
  }
  async function startBaaVersionResigns() {
    "use server";
    const result = await baaResignsUpstream();
    revalidatePath(PATH);
    return result;
  }
  async function recordGuaranteeClaim(clinicId: string, claimReceivedOn: string) {
    "use server";
    const result = await claimUpstream(clinicId, claimReceivedOn);
    revalidatePath(PATH);
    return result;
  }
  async function sendGuaranteeFinding(
    clinicId: string,
    input: {
      claimReceivedOn: string;
      outcome: GuaranteeOutcome;
      refundByOn?: string;
      failure?: GuaranteeFailure;
    },
  ) {
    "use server";
    const result = await findingUpstream(clinicId, input);
    revalidatePath(PATH);
    return result;
  }
  async function suspendForCause(clinicId: string, cause: SuspensionCause) {
    "use server";
    const result = await suspendUpstream(clinicId, cause);
    revalidatePath(PATH);
    revalidatePath("/admin/clinics");
    return result;
  }

  return (
    <NoticesBoard
      record={record}
      clinics={clinics.ok ? clinics.data.clinics.map((c) => ({ id: c.id, name: c.name })) : []}
      today={new Date().toISOString().slice(0, 10)}
      actions={{
        sendTermsNotice,
        sendSubprocessorNotice,
        sendProductUpdate,
        startBaaVersionResigns,
        recordGuaranteeClaim,
        sendGuaranteeFinding,
        suspendForCause,
      }}
    />
  );
}
