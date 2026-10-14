"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useAnnounce } from "../../feedback";
import { exportPersonAction, sendAgainAction } from "../actions";
import { downloadJson } from "../download";

/**
 * The open conversation's two actions (plan Part F4): "Send again", while
 * the transcript's delivery is not confirmed, and the export of the person's
 * records. Both run behind the step-up on the server and write the access
 * log; this only asks, says what happened in the portal's status region, and
 * reads the page again so the receipt shows where things now stand.
 */

export function SendAgain(props: { slug: string; conversationId: string }) {
  const announce = useAnnounce();
  const router = useRouter();
  const [working, setWorking] = useState(false);

  async function send(): Promise<void> {
    setWorking(true);
    try {
      const result = await sendAgainAction(props.slug, props.conversationId);
      announce({ text: result.message, tone: result.ok ? "ok" : "problem" });
      router.refresh();
    } catch {
      announce({ text: "That didn't reach us. Try again.", tone: "problem" });
    } finally {
      setWorking(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void send()}
      disabled={working}
      aria-describedby="send-again-note"
      className="bg-ink mt-3 min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
    >
      {working ? "Sending…" : "Send again"}
    </button>
  );
}

export function PersonExport(props: {
  slug: string;
  conversationId: string;
  audience: "patients" | "clients";
  requesters: { value: string; label: string }[];
}) {
  const announce = useAnnounce();
  const [requestedBy, setRequestedBy] = useState(props.requesters[0]?.value ?? "practice");
  const [working, setWorking] = useState(false);
  const person = props.audience === "clients" ? "client" : "patient";

  async function download(): Promise<void> {
    setWorking(true);
    try {
      const result = await exportPersonAction(props.slug, props.conversationId, requestedBy);
      if (result.ok) {
        downloadJson(result.filename, result.body);
        announce({ text: result.message, tone: "ok" });
      } else {
        announce({ text: result.message, tone: "problem" });
      }
    } catch {
      announce({ text: "The export didn't reach you. Try again.", tone: "problem" });
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="mt-3">
      <p className="text-muted text-sm" id="person-export-note">
        Everything healdesk holds about this {person}, found by their number and address, with any
        amendments and the log of who opened it: what you need to answer their request to see their
        records.
      </p>
      <label htmlFor="person-export-who" className="mt-3 block text-sm font-semibold">
        Who asked
      </label>
      <select
        id="person-export-who"
        value={requestedBy}
        onChange={(e) => setRequestedBy(e.target.value)}
        className="border-line mt-1 min-h-11 w-full rounded-xl border bg-white px-3"
      >
        {props.requesters.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => void download()}
        disabled={working}
        aria-describedby="person-export-note"
        className="border-ink mt-3 min-h-11 rounded-full border bg-white px-5 text-sm font-bold disabled:opacity-50"
      >
        {working ? "Preparing the export…" : `Download this ${person}'s records`}
      </button>
    </div>
  );
}
