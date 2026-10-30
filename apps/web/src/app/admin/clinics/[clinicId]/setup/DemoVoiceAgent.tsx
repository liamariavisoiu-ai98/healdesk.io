"use client";

import { useState, useTransition } from "react";

import type { DemoVoiceAgentOutcome, OpsResult } from "@/lib/admin/ops-client";

/**
 * The demo clinic's Retell agent, made by hand on Retell's dashboard, brought
 * to the settings every agent healdesk writes has (owner, 24 October 2026):
 * backchannel, turn-taking, voice speed, the pronunciation dictionary, the
 * clinic's language and its words boosted for the transcriber. Its voice
 * stays the one chosen on the dashboard. Shown on the demo clinic only, and
 * apps/app refuses any other clinic anyway: a real clinic's agent is set up
 * and kept in step by provisioning.
 */

export type SyncDemoAgent = (agentId: string) => Promise<OpsResult<DemoVoiceAgentOutcome>>;

export function DemoVoiceAgent({ onSync }: { onSync: SyncDemoAgent }) {
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <section className="border-line mt-8 rounded-md border bg-white p-5">
      <h2 className="text-sm font-bold tracking-[0.08em] uppercase">Demo voice agent</h2>
      <p className="text-muted mt-3 text-sm">
        Apply AYA&apos;s call settings to the demo agent on Retell, with this clinic&apos;s language and words. The voice is left as it is.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          const agentId = String(new FormData(event.currentTarget).get("agentId") ?? "").trim();
          setSaid(null);
          startTransition(async () => {
            const result = await onSync(agentId);
            if (!result.ok) setSaid({ ok: false, text: result.message });
            else setSaid({ ok: result.data.outcome === "applied", text: result.data.message });
          });
        }}
        className="mt-4 flex flex-wrap items-end gap-3"
      >
        <label className="min-w-[260px] flex-1">
          <span className="text-muted text-xs font-bold tracking-[0.06em] uppercase">Retell agent id</span>
          <input
            name="agentId"
            required
            autoComplete="off"
            pattern="agent_[A-Za-z0-9]{6,64}"
            placeholder="agent_…"
            className="border-line focus:border-orange mt-1.5 w-full rounded-sm border bg-white px-3 py-2.5 font-mono text-sm"
          />
        </label>
        <button type="submit" disabled={pending} className="bg-ink rounded-full px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">
          {pending ? "Applying…" : "Apply AYA's call settings to the demo agent"}
        </button>
        {said ? (
          <p role="status" className={`w-full text-sm font-semibold ${said.ok ? "text-ink" : "text-red-deep"}`}>
            {said.text}
          </p>
        ) : null}
      </form>
    </section>
  );
}
