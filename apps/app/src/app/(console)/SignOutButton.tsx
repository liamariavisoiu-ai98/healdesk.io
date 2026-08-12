"use client";

import { signOut } from "@/lib/auth-client";

export function SignOutButton({ email }: { email: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="hidden text-sm text-[color:var(--color-muted)] sm:inline">
        {email}
      </span>
      <button
        type="button"
        onClick={async () => {
          await signOut();
          window.location.href = "/sign-in";
        }}
        className="text-sm font-semibold text-[color:var(--color-muted)] transition-colors hover:text-[color:var(--color-ink)]"
      >
        Sign out
      </button>
    </div>
  );
}
