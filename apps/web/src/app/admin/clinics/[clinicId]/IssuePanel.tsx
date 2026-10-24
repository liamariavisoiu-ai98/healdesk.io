"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { FixWithClaude } from "@/components/admin/FixWithClaude";
import { buildFixPrompt, type FixPrompt } from "@/lib/admin/fix-with-claude";
import { cardAnchorFor, parseIssueHash, type CardAnchor } from "@/lib/admin/issue-link";

/**
 * The issue a link landed on, `#<event>-<alert id>` (lib/admin/issue-link.ts),
 * as the clinic panel sees it: this draws the "Fix with Claude" panel for it
 * (E7 step 3) and, for an event with a card of its own on this panel (an
 * availability change, a lifecycle alert), scrolls to that card. A fragment
 * never reaches the server, so this reads it after mount, again on every
 * change of the hash, and again on a client navigation inside this clinic's
 * layout (the pathname moves, the layout and this panel stay mounted). The
 * prompt is built from the two ids in the fragment, which the parser
 * accepted only as an event from the closed list and a uuid; the alert's own
 * row, with its time and repeats, is what the session reads next.
 *
 * The scroll runs after the prompt has committed, not before: the Fix panel
 * is inserted above the cards and pushes them down, so a scroll made first
 * would land short of the card.
 *
 * Alerts sent before the notification rewrite arrive as
 * `/admin/ops/<id>/care|onboarding` and redirect here with no fragment, so
 * this draws nothing for them.
 */
export function IssuePanel({ clinicId }: { clinicId: string }) {
  const pathname = usePathname();
  const [issue, setIssue] = useState<{ built: FixPrompt; card: CardAnchor | null } | null>(null);

  useEffect(() => {
    const read = () => {
      const parsed = parseIssueHash(window.location.hash);
      setIssue(parsed ? { built: buildFixPrompt({ event: parsed.event, alertId: parsed.id, clinicId }), card: cardAnchorFor(parsed.event) } : null);
    };
    read();
    window.addEventListener("hashchange", read);
    window.addEventListener("popstate", read);
    return () => {
      window.removeEventListener("hashchange", read);
      window.removeEventListener("popstate", read);
    };
  }, [clinicId, pathname]);

  useEffect(() => {
    if (!issue?.card) return;
    document.getElementById(issue.card)?.scrollIntoView({ block: "start" });
  }, [issue]);

  return issue ? <FixWithClaude built={issue.built} /> : null;
}
