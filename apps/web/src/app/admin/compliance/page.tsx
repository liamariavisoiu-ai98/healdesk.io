import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { Failure } from "@/components/admin/ui";
import { requireOperator } from "@/lib/admin/operator";
import { fetchAgreementReviews, fetchPlatformCompliance } from "@/lib/admin/ops-client";
import { enterPlatformAttestation, openLaunchPromises } from "@/lib/admin/platform-compliance";
import { LAUNCH_PROMISES } from "@/lib/admin/seo/launch";
import { isHostUnreachable } from "@/lib/host/state";

import { CompliancePanel, type AttestationForm } from "./CompliancePanel";
import { LaunchPromises } from "./LaunchPromises";

/**
 * /admin/compliance: everything the owner attests or decides under an
 * agreement, on one page with three registers beneath it (E1 §2, step 6):
 * the platform's attestations (WP2; plan Part K, the Gates table), the human
 * half of Gate B and what the code holds, their history, the launch promises
 * (their one home), and links to the agreements register, the incidents
 * register and the notices. The agreement checks a person decides are a
 * queue, under Queues, and counted here.
 *
 * Go-live is automatic: a clinic goes to production by itself once its own
 * part is done and everything here that its channel needs is attested. Each
 * attestation or withdrawal is entered with a fresh code from the operator's
 * authenticator, checked on this app before the signed request goes
 * (lib/admin/platform-compliance.ts). A withdrawal never takes a live channel
 * offline; it holds back what has not gone live yet. A vendor's agreement
 * withdrawn or past its expiry also stops AYA answering where that vendor
 * serves, until a renewal is recorded (apps/app's answer gate,
 * lib/compliance/vendor-coverage.ts).
 *
 * Business data about the platform, never a clinic's or a patient's. Every
 * read and write is an operation on the signed ops envelope; this app keeps
 * nothing.
 */

export const metadata: Metadata = { title: "Compliance" };
export const dynamic = "force-dynamic";

const PATH = "/admin/compliance";

const REGISTERS = [
  { href: "/admin/compliance/agreements", label: "Agreements register" },
  { href: "/admin/compliance/incidents", label: "Incidents" },
  { href: "/admin/compliance/notices", label: "Notices" },
  { href: "/admin/rights", label: "Patient rights" },
  { href: "/admin/compliance/pack", label: "Compliance packs" },
  { href: "#launch", label: "Launch" },
] as const;

export default async function CompliancePage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const [view, checks] = await Promise.all([fetchPlatformCompliance(), fetchAgreementReviews()]);
  const standby = isHostUnreachable(view);

  async function enter(input: AttestationForm) {
    "use server";
    const result = await enterPlatformAttestation(input);
    revalidatePath(PATH);
    return result;
  }

  const open = new Set(openLaunchPromises());
  const checksOpen = checks.ok ? checks.data.filter((r) => r.status === "open").length : null;

  return (
    <main className="mx-auto w-full max-w-page px-4 py-10 sm:px-8 lg:px-14">
      <h1 className="font-display text-2xl leading-tight font-semibold tracking-[-0.02em]">Compliance</h1>
      <nav aria-label="Compliance" className="mt-4 flex flex-wrap gap-2">
        {REGISTERS.map((r) => (
          <a key={r.href} href={r.href} className="border-line-strong hover:border-ink inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm font-semibold transition-colors">
            {r.label}
          </a>
        ))}
        <a href="/admin/queues#agreement-checks" className="border-line-strong hover:border-ink inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors">
          Agreement checks
          {checksOpen !== null ? <span className="text-muted">{checksOpen}</span> : null}
        </a>
      </nav>

      {/* The count is on the chip above; a read that failed is said here, never a chip with no number. */}
      {!standby && !checks.ok ? <Failure failure={checks} what="the agreement checks" /> : null}

      {standby ? (
        <HostStandbyNotice what="The attestations" />
      ) : (
        <CompliancePanel
          view={view}
          openPromises={LAUNCH_PROMISES.filter((p) => open.has(p.id)).map((p) => ({
            id: p.id,
            promise: p.promise,
          }))}
          actions={{ enter }}
        />
      )}

      <LaunchPromises />
    </main>
  );
}
