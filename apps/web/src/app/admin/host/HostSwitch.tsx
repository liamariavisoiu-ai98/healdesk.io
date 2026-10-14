"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The two buttons on /admin/host. Each posts to /api/admin/host, which checks
 * the session, the origin and (for standby) apps/app's counts before it
 * dispatches host.yml; this component only asks, shows the answer and
 * refreshes the page so the new run appears.
 *
 * Standby takes a second click on a button that says what it does: it deletes
 * the database after a snapshot and stops everything, and while it lasts this
 * console cannot read anything from the host.
 */
export function HostSwitch({ configured, switching }: { configured: boolean; switching: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<"active" | "standby" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [answer, setAnswer] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(mode: "active" | "standby") {
    setPending(mode);
    setAnswer(null);
    try {
      const response = await fetch("/api/admin/host", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "standby" ? { mode, confirm: "standby" } : { mode }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
      if (response.ok) {
        setAnswer({ ok: true, text: body.message ?? "Started." });
        router.refresh();
      } else {
        setAnswer({ ok: false, text: body.error ?? `The switch answered ${response.status}.` });
      }
    } catch {
      setAnswer({ ok: false, text: "This page could not reach its own switch. Try again." });
    } finally {
      setPending(null);
      setConfirming(false);
    }
  }

  const disabled = !configured || switching || pending !== null;

  return (
    <div className="mt-6">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => send("active")}
          className="inline-flex min-h-11 items-center rounded-full bg-black px-5 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          {pending === "active" ? "Starting…" : "Turn on (apply, set up the database, deploy)"}
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              disabled={disabled}
              onClick={() => send("standby")}
              className="border-red-deep text-red-deep inline-flex min-h-11 items-center rounded-full border px-5 py-2 text-sm font-bold disabled:opacity-50"
            >
              {pending === "standby" ? "Starting…" : "Yes: snapshot and remove the database, stop everything"}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => setConfirming(false)}
              className="border-line-strong inline-flex min-h-11 items-center rounded-full border px-5 py-2 text-sm font-bold"
            >
              Keep it on
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setConfirming(true)}
            className="border-line-strong hover:border-ink inline-flex min-h-11 items-center rounded-full border px-5 py-2 text-sm font-bold transition-colors disabled:opacity-50"
          >
            Standby
          </button>
        )}
      </div>
      {confirming ? (
        <p className="mt-3 max-w-[68ch] text-sm">
          Standby asks the host first and refuses if any clinic is in production, any agreement is in effect or any
          transcript has not been sent. Then the database is snapshotted and deleted, and the load balancer, the NAT and
          the services go. Nothing on the other admin pages can be read until it is on again.
        </p>
      ) : null}
      {switching ? <p className="text-muted mt-3 text-sm">A switch is running: wait for it to finish.</p> : null}
      {answer ? (
        <p role="status" className={`mt-3 max-w-[68ch] text-sm font-semibold ${answer.ok ? "" : "text-red-deep"}`}>
          {answer.text}
        </p>
      ) : null}
    </div>
  );
}
