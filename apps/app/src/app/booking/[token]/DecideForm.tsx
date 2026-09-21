"use client";

import { useActionState } from "react";

import { decideRequest, type DecideFormState } from "./actions";

/**
 * Two buttons and two optional fields. Progressively enhanced: with
 * JavaScript off the browser POSTs to this URL and the action's redirect
 * lands on the same page showing the outcome.
 */
export function DecideForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<DecideFormState, FormData>(decideRequest, { status: "idle" });
  return (
    <form action={action} className="mt-6 grid gap-4 text-[15px]">
      <input type="hidden" name="token" value={token} />
      <label className="grid gap-1">
        <span className="text-[13px] font-bold tracking-[0.06em] text-[color:var(--color-muted)] uppercase">Your name (optional)</span>
        <input name="name" maxLength={80} autoComplete="name" className="rounded-xl border border-[color:var(--color-line)] px-3 py-2" />
      </label>
      <label className="grid gap-1">
        <span className="text-[13px] font-bold tracking-[0.06em] text-[color:var(--color-muted)] uppercase">Note for yourselves (optional, never sent to the patient)</span>
        <textarea name="note" maxLength={500} rows={2} className="rounded-xl border border-[color:var(--color-line)] px-3 py-2" />
      </label>
      {state.status === "failed" ? (
        <p role="alert" className="rounded-xl border border-[color:var(--color-red)]/30 bg-[color:var(--color-red)]/[0.06] px-4 py-3 font-medium">
          {state.message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          name="decision"
          value="accepted"
          disabled={pending}
          className="rounded-xl bg-[color:var(--color-fg,#111)] px-5 py-2.5 font-semibold text-white disabled:opacity-60"
        >
          {pending ? "Saving…" : "Accept — we'll call to confirm"}
        </button>
        <button
          type="submit"
          name="decision"
          value="declined"
          disabled={pending}
          className="rounded-xl border border-[color:var(--color-line)] px-5 py-2.5 font-semibold disabled:opacity-60"
        >
          Decline — we'll call to find another time
        </button>
      </div>
    </form>
  );
}
