import { redirect } from "next/navigation";

import { requireSession } from "@/lib/session";
import { TenantAccessError } from "@/lib/tenant";

import { SignOutButton } from "./SignOutButton";

/**
 * Console chrome.
 *
 * ⚠️ The session check here is for RENDERING, not protection. Layouts do not
 * re-run on client-side navigation and never run for route handlers or server
 * actions, so a layout-only guard protects nothing. Every page and every action
 * re-resolves the session itself — see the redirect in each page.tsx and the
 * requireSession() call at the top of each action.
 *
 * It exists here so the nav can show who is signed in, and so an expired
 * session lands on sign-in rather than a half-rendered page.
 */
export default async function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let session;
  try {
    session = await requireSession();
  } catch (error) {
    if (error instanceof TenantAccessError) redirect("/sign-in");
    throw error;
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-[color:var(--color-line)] bg-[color:var(--color-paper)]/90 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-6 px-6 py-3.5">
          <a href="/" className="text-[15px] font-bold tracking-[-0.01em]">
            <span className="text-[color:var(--color-red)]">heal</span>
            <span className="text-[color:var(--color-orange)]">desk</span>
            <span className="ml-1.5 text-[11px] font-bold tracking-[0.1em] text-[color:var(--color-muted)] uppercase">
              ops
            </span>
          </a>

          <nav className="flex items-center gap-5 text-sm font-semibold">
            <a
              href="/"
              className="text-[color:var(--color-muted)] transition-colors hover:text-[color:var(--color-ink)]"
            >
              Clinics
            </a>
            <a
              href="/team"
              className="text-[color:var(--color-muted)] transition-colors hover:text-[color:var(--color-ink)]"
            >
              Team
            </a>
          </nav>

          <div className="ml-auto">
            <SignOutButton email={session.email} />
          </div>
        </div>
      </header>

      {children}
    </div>
  );
}
