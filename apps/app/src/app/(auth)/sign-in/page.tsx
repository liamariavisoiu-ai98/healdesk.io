import type { Metadata } from "next";

import { SignInForm } from "./SignInForm";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  // Only same-origin paths. An open redirect on a sign-in page is how a
  // convincing phishing link gets built out of your own domain.
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        healdesk ops
      </p>
      <h1 className="mt-2 mb-8 text-3xl font-semibold tracking-tight">
        Sign in
      </h1>

      <SignInForm next={target} />

      <p className="mt-8 text-xs text-[color:var(--color-muted)]">
        Accounts are created by invitation only. This console handles patient
        data — every access is logged.
      </p>
    </main>
  );
}
