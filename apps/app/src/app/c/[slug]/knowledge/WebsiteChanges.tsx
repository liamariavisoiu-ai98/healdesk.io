"use client";

import { useState } from "react";

import { useAnnounce } from "../feedback";

import { decideWebsiteChangeAction } from "./actions";

/**
 * "Changes on your website" (plan Part F3): what a read of the practice's
 * own website found that Knowledge does not say, each with Confirm, which
 * applies it into Knowledge through the same writers as the forms below, and
 * Ignore, which is remembered. A provider is set up with a calendar, so its
 * line links to Settings instead of confirming. Each decision is announced
 * in the page's one status region; the list then reloads as it now stands.
 */

export type WebsiteChangeItem = {
  id: string;
  sectionName: string;
  text: string;
  detail: string | null;
  canConfirm: boolean;
};

export function WebsiteChangesList(props: {
  slug: string;
  changes: WebsiteChangeItem[];
  /** Settings → Calendar, where providers are set up; null when Settings is not built. */
  providersHref: string | null;
}) {
  const announce = useAnnounce();
  const [working, setWorking] = useState<string | null>(null);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());

  async function decide(id: string, decision: "confirm" | "ignore") {
    setWorking(id);
    try {
      const result = await decideWebsiteChangeAction(props.slug, id, decision);
      if (result.ok) {
        announce({ text: result.toast, tone: "ok" });
        setDone((prev) => new Set(prev).add(id));
        // Knowledge's forms below show what was just written.
        if (decision === "confirm") window.location.reload();
      } else {
        announce({ text: result.message, tone: "problem" });
      }
    } catch {
      announce({
        text: "Something went wrong on our side. Try again in a moment.",
        tone: "problem",
      });
    } finally {
      setWorking(null);
    }
  }

  const left = props.changes.filter((c) => !done.has(c.id));
  if (left.length === 0) {
    return <p className="text-sm">Nothing left to review. AYA answers from Knowledge below.</p>;
  }
  return (
    <ul className="grid gap-3">
      {left.map((change) => (
        <li key={change.id} className="border-line rounded-xl border px-4 py-3">
          <p className="text-muted text-xs font-semibold tracking-wide uppercase">
            {change.sectionName}
          </p>
          <p className="mt-1">{change.text}</p>
          {change.detail ? <p className="text-muted mt-1 text-sm">{change.detail}</p> : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {change.canConfirm ? (
              <button
                type="button"
                disabled={working !== null}
                onClick={() => void decide(change.id, "confirm")}
                className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
              >
                {working === change.id ? "Saving…" : "Confirm"}
              </button>
            ) : props.providersHref ? (
              <a
                href={props.providersHref}
                className="bg-ink inline-flex min-h-11 items-center rounded-full px-5 text-sm font-bold text-white"
              >
                Edit providers
              </a>
            ) : null}
            <button
              type="button"
              disabled={working !== null}
              onClick={() => void decide(change.id, "ignore")}
              className="border-line min-h-11 rounded-full border px-5 text-sm font-semibold disabled:opacity-50"
            >
              Ignore
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
