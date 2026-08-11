"use client";

import { useState } from "react";

import { signIn } from "@/lib/auth-client";

export function SignInForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await signIn.email({ email, password });

    if (result.error) {
      // Deliberately generic. Distinguishing "no such account" from "wrong
      // password" tells an attacker which emails are staff accounts.
      setError("That email and password don't match.");
      setPending(false);
      return;
    }

    window.location.href = next;
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <label className="block">
        <span className="text-[13px] font-bold tracking-[0.04em] uppercase">
          Email
        </span>
        <input
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-2 w-full rounded-xl border border-[color:var(--color-line)] bg-white px-4 py-3 text-[16px] outline-none focus:border-[color:var(--color-orange)]"
        />
      </label>

      <label className="block">
        <span className="text-[13px] font-bold tracking-[0.04em] uppercase">
          Password
        </span>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-2 w-full rounded-xl border border-[color:var(--color-line)] bg-white px-4 py-3 text-[16px] outline-none focus:border-[color:var(--color-orange)]"
        />
      </label>

      {error ? (
        <p className="text-sm font-semibold text-[color:var(--color-red)]">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="mt-2 rounded-full bg-[color:var(--color-ink)] px-6 py-3.5 text-base font-bold text-white transition-opacity disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
