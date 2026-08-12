"use client";

import { useActionState, useState } from "react";

import { inviteTeammate, type InviteState } from "./actions";

export function InviteForm() {
  const [state, action, pending] = useActionState<InviteState, FormData>(
    inviteTeammate,
    { status: "idle" },
  );
  const [copied, setCopied] = useState(false);

  return (
    <div className="rounded-2xl border border-[color:var(--color-line)] bg-white p-5">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="min-w-[240px] flex-1">
          <span className="text-[11px] font-bold tracking-[0.06em] uppercase">
            Work email
          </span>
          <input
            name="email"
            type="email"
            required
            placeholder="colleague@healdesk.io"
            className="mt-1.5 w-full rounded-lg border border-[color:var(--color-line)] bg-white px-3 py-2.5 text-sm outline-none focus:border-[color:var(--color-orange)]"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-[color:var(--color-ink)] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create invitation"}
        </button>
      </form>

      {state.status === "error" ? (
        <p className="mt-3 text-sm font-semibold text-[color:var(--color-red)]">
          {state.message}
        </p>
      ) : null}

      {state.status === "sent" ? (
        <div className="mt-4 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper-2)] p-4">
          <p className="text-sm font-semibold">
            Invitation ready for {state.email}
          </p>
          {/* No email is sent — SES isn't wired up. Handing over the link is
              honest; a "sent!" message would not be. */}
          <p className="mt-1 text-sm text-[color:var(--color-muted)]">
            We can&apos;t email it yet, so send them this link. It expires in 7
            days.
          </p>
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-[color:var(--color-line)] bg-white px-3 py-2">
            <code className="min-w-0 flex-1 truncate text-xs">
              {typeof window !== "undefined"
                ? `${window.location.origin}${state.link}`
                : state.link}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(
                  `${window.location.origin}${state.link}`,
                );
                setCopied(true);
                setTimeout(() => setCopied(false), 1_500);
              }}
              className="shrink-0 rounded-full bg-[color:var(--color-ink)] px-3 py-1.5 text-xs font-bold text-white"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
