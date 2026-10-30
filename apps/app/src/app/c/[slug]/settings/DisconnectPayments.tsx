"use client";

import { useState } from "react";

import { disconnectPaymentsAction } from "./actions";
import { useAnnounce } from "../feedback";

/**
 * Settings → Payments' Disconnect, behind a passkey step-up (plan Part D4).
 * Asks once before acting, because deposits switch off at once and open
 * payment links are closed; then reloads, so the card shows what is true.
 */
export function DisconnectPayments({ slug }: { slug: string }) {
  const announce = useAnnounce();
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  async function disconnect() {
    setWorking(true);
    try {
      const result = await disconnectPaymentsAction(slug);
      if (result.ok) {
        announce({ text: result.toast, tone: "ok" });
        window.location.reload();
        return;
      }
      announce({ text: result.message, tone: "problem", stepUpHref: result.stepUpHref });
    } catch {
      announce({
        text: "Something went wrong on our side. Try again in a moment.",
        tone: "problem",
      });
    }
    setWorking(false);
    setConfirming(false);
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="border-line mt-3 min-h-11 rounded-full border px-5 text-sm font-semibold"
      >
        Disconnect
      </button>
    );
  }
  return (
    <div className="border-line mt-3 rounded-md border px-4 py-3 text-sm">
      <p>
        Deposits switch off at once and open payment links stop working. AYA books without asking
        for a deposit until you connect an account again.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={working}
          onClick={() => void disconnect()}
          className="bg-ink min-h-11 rounded-full px-5 font-bold text-white disabled:opacity-50"
        >
          {working ? "Disconnecting…" : "Disconnect Stripe"}
        </button>
        <button
          type="button"
          disabled={working}
          onClick={() => setConfirming(false)}
          className="border-line min-h-11 rounded-full border px-5 font-semibold disabled:opacity-50"
        >
          Keep it connected
        </button>
      </div>
    </div>
  );
}
