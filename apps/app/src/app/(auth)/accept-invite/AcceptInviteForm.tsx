"use client";

import { useState } from "react";

import { authClient, signIn } from "@/lib/auth-client";

/**
 * Setting a password from an invitation.
 *
 * Sign-up is closed — the Better Auth create hook refuses any account without a
 * matching pending invitation — so this form calls the ordinary sign-up
 * endpoint and relies on that hook to decide. There is no separate
 * "accept invite" endpoint to protect: the invitation IS the authorisation.
 */
export function AcceptInviteForm({ email }: { email: string }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    if (password.length < 12) {
      setError("Please use at least 12 characters.");
      return;
    }

    setPending(true);

    const result = await authClient.signUp.email({ email, password, name });

    if (result.error) {
      // The create hook says "Registration is by invitation only" when there's
      // no valid pending invitation — which is also what an expired one looks
      // like, and the more likely case here.
      setError(
        result.error.message?.includes("invitation")
          ? "This invitation has expired or has already been used. Reply to your setup email and we'll send a new one."
          : "We couldn't create your account. Please try again.",
      );
      setPending(false);
      return;
    }

    await signIn.email({ email, password });
    window.location.href = "/";
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <div>
        <span className="text-[13px] font-bold tracking-[0.04em] uppercase">
          Email
        </span>
        <p className="mt-2 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper-2)] px-4 py-3 text-[16px]">
          {email}
        </p>
        <span className="mt-1.5 block text-xs text-[color:var(--color-muted)]">
          The invitation is tied to this address.
        </span>
      </div>

      <label className="block">
        <span className="text-[13px] font-bold tracking-[0.04em] uppercase">
          Your name
        </span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          className="mt-2 w-full rounded-xl border border-[color:var(--color-line)] bg-white px-4 py-3 text-[16px] outline-none focus:border-[color:var(--color-orange)]"
        />
      </label>

      <label className="block">
        <span className="text-[13px] font-bold tracking-[0.04em] uppercase">
          Choose a password
        </span>
        <input
          type="password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          className="mt-2 w-full rounded-xl border border-[color:var(--color-line)] bg-white px-4 py-3 text-[16px] outline-none focus:border-[color:var(--color-orange)]"
        />
        <span className="mt-1.5 block text-xs text-[color:var(--color-muted)]">
          At least 12 characters. This account can reach patient data.
        </span>
      </label>

      <label className="block">
        <span className="text-[13px] font-bold tracking-[0.04em] uppercase">
          Confirm password
        </span>
        <input
          type="password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
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
        className="mt-2 rounded-full bg-[color:var(--color-ink)] px-6 py-3.5 text-base font-bold text-white disabled:opacity-50"
      >
        {pending ? "Setting up…" : "Create account"}
      </button>
    </form>
  );
}
