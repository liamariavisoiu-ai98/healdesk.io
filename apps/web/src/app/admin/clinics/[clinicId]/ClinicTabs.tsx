"use client";

import { useSelectedLayoutSegment } from "next/navigation";

import { clinicTabPath, ISSUE_TABS, type IssueTab } from "@/lib/admin/issue-link";

/**
 * The clinic panel's five tabs, each owning one concern (E1 §2): Setup,
 * Billing, Deliveries, Care, Account. The current one is read from the
 * client router, which is correct on every navigation; the layout that
 * renders this cannot know which child is below it (app/admin/layout.tsx
 * says why). Plain anchors, as the whole console navigates: every tab is
 * `force-dynamic` and re-reads its clinic on the server.
 */

const LABELS: Record<IssueTab, string> = {
  setup: "Setup",
  billing: "Billing",
  deliveries: "Deliveries",
  care: "Care",
  account: "Account",
};

export function ClinicTabs({ clinicId }: { clinicId: string }) {
  const segment = useSelectedLayoutSegment();
  return (
    <nav aria-label="Clinic tabs" className="border-line mt-5 flex flex-wrap gap-1 border-b">
      {ISSUE_TABS.map((tab) => {
        const current = segment === tab;
        return (
          <a
            key={tab}
            href={clinicTabPath(clinicId, tab)}
            aria-current={current ? "page" : undefined}
            className={`-mb-px inline-flex min-h-11 items-center border-b-2 px-3.5 text-[15.6px] font-semibold transition-colors ${
              current ? "border-ink text-ink" : "text-muted hover:text-ink border-transparent"
            }`}
          >
            {LABELS[tab]}
          </a>
        );
      })}
    </nav>
  );
}
