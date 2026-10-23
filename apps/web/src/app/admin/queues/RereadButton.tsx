"use client";

import { useState } from "react";

import type { OpsResult } from "@/lib/admin/ops-client";

export type Reread = (
  clinicId: string,
) => Promise<
  OpsResult<
    | { status: "queued"; rereadId: string; auditRecorded: boolean }
    | { status: "refused"; message: string }
  >
>;

/**
 * "Read it again" on a failed site read: asks apps/app (ops requestSiteReread)
 * to queue a signed re-read, which its site-reads job sends back to this
 * app's /api/clinic-site. Nothing about the website crosses back; the answer
 * is that it was asked for, or why not.
 */
export function RereadButton({ clinicId, reread }: { clinicId: string; reread: Reread }) {
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<{ ok: boolean; text: string } | null>(null);

  async function ask() {
    setPending(true);
    setAnswer(null);
    try {
      const result = await reread(clinicId);
      if (!result.ok) setAnswer({ ok: false, text: result.message });
      else if (result.data.status !== "queued") setAnswer({ ok: false, text: result.data.message });
      else {
        const done = "Asked for: the site-reads job reads it within a minute or so.";
        setAnswer({
          ok: true,
          text: result.data.auditRecorded ? done : `${done} It is not in the security log.`,
        });
      }
    } catch {
      setAnswer({ ok: false, text: "This page could not reach its own action. Try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => void ask()}
        className="border-line-strong inline-flex min-h-11 items-center rounded-full border px-5 py-2 text-sm font-bold disabled:opacity-50"
      >
        Read it again
      </button>
      {answer ? (
        <p
          role="status"
          className={answer.ok ? "mt-2 text-sm" : "text-red-deep mt-2 text-sm font-semibold"}
        >
          {answer.text}
        </p>
      ) : null}
    </div>
  );
}
