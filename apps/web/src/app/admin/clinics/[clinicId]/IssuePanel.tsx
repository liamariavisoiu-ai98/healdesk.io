"use client";

import { useEffect, useState } from "react";

import { FixWithClaude } from "@/components/admin/FixWithClaude";
import { buildFixPrompt, type FixPrompt } from "@/lib/admin/fix-with-claude";
import { cardAnchorFor, parseIssueHash } from "@/lib/admin/issue-link";

/**
 * The issue a link landed on, `#<event>-<alert id>` (lib/admin/issue-link.ts),
 * as the clinic panel sees it: this draws the "Fix with Claude" panel for it
 * (E7 step 3). A fragment never reaches the server, so this reads it after
 * mount; with no issue in the address, nothing is drawn. The prompt is built
 * from the two ids in the fragment, which the parser accepted only as an
 * event from the closed list and a uuid; the alert's own row, with its time
 * and repeats, is what the session reads next.
 *
 * An event with a card of its own on this panel (an availability change,
 * a lifecycle alert) is scrolled to that card as well, since the fragment
 * names the alert, not the card, and the browser can scroll to nothing on
 * its own. Alerts sent before the notification rewrite arrive as
 * `/admin/ops/<id>/care|onboarding` and redirect here with no fragment, so
 * this draws nothing for them.
 */
export function IssuePanel({ clinicId }: { clinicId: string }) {
  const [built, setBuilt] = useState<FixPrompt | null>(null);

  useEffect(() => {
    const read = () => {
      const issue = parseIssueHash(window.location.hash);
      setBuilt(issue ? buildFixPrompt({ event: issue.event, alertId: issue.id, clinicId }) : null);
      const card = issue ? cardAnchorFor(issue.event) : null;
      if (card) document.getElementById(card)?.scrollIntoView({ block: "start" });
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [clinicId]);

  return built ? <FixWithClaude built={built} /> : null;
}
