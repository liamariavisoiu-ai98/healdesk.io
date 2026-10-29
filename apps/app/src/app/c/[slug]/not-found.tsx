"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { EmptyState, STATE_ACTION_CLASS } from "./states";

/**
 * A portal address that opens nothing: no clinic name, no detail about what
 * exists. It renders without PortalShell, so it carries its own way home.
 */
export default function PortalNotFound() {
  const params = useParams<{ slug?: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : null;
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <div className="mt-4">
        <EmptyState
          action={
            slug ? (
              <Link href={`/c/${encodeURIComponent(slug)}`} className={STATE_ACTION_CLASS}>
                Back to Home
              </Link>
            ) : undefined
          }
        >
          This page doesn&rsquo;t exist, or you don&rsquo;t have access to it.
        </EmptyState>
      </div>
    </main>
  );
}
