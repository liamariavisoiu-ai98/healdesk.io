import { isPlanId, plans } from "@healdesk/catalog";
import type { Metadata } from "next";

import { CheckoutFlow } from "@/components/checkout/CheckoutFlow";
import { Brand } from "@/components/Nav";

export const metadata: Metadata = {
  title: "Get started",
  description:
    "Set up your AI front desk in a few minutes. No booking software required.",
  // A checkout funnel has no business in search results.
  robots: { index: false, follow: false },
};

export default async function GetStartedPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const { plan } = await searchParams;
  const initialPlan = isPlanId(plan) ? plan : plans[0]!.id;

  return (
    <div className="min-h-screen">
      <header className="border-line/60 border-b">
        <div className="mx-auto flex max-w-[1240px] items-center px-5 py-4 sm:px-8 lg:px-14">
          <Brand />
          <a
            href="/"
            className="text-muted hover:text-ink ml-auto text-sm font-semibold transition-colors"
          >
            Back to site
          </a>
        </div>
      </header>

      <main className="px-5 py-12 sm:px-8 sm:py-16">
        <CheckoutFlow initialPlan={initialPlan} />
      </main>
    </div>
  );
}
