"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

import { claudeCliLink, vscodeLink, type FixPrompt } from "@/lib/admin/fix-with-claude";

/**
 * The "Fix with Claude" panel on an issue view (E7, Tier 1; owner decision
 * D22), drawn by the clinic panel when its address names an alert
 * (`#<event>-<alert id>`; IssuePanel.tsx says when that starts): the prompt
 * read-only, and three ways to carry it to a Claude Code
 * session the owner then drives: Open in Claude Code (`claude-cli://`, a
 * terminal on the machine it is clicked on, the prompt pre-filled and not
 * sent until Enter), Copy prompt (for a phone, pasted into a Remote Control
 * session on the Mac that keeps the AWS rails), Open in VS Code.
 *
 * It renders only under /admin: the console sits behind the password and the
 * authenticator code, and anyone can forge a `claude-cli://` link, so the
 * safeguard is that the button lives nowhere a stranger reaches and that the
 * owner reads the prompt before pressing Enter. A prompt the builder refused
 * is said, with its reason, and no link is drawn for it.
 */
export function FixWithClaude({ built }: { built: FixPrompt }) {
  const pathname = usePathname();
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  if (!pathname || !(pathname === "/admin" || pathname.startsWith("/admin/"))) return null;

  if (!built.ok) {
    return (
      <section aria-label="Fix with Claude" className="border-line mt-6 rounded-md border bg-white p-5">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">Fix with Claude</h2>
        <p role="status" className="text-red-deep mt-2 text-sm font-semibold">
          No prompt for this issue: {built.reason}.
        </p>
      </section>
    );
  }

  const cli = claudeCliLink(built.prompt);
  const code = vscodeLink(built.prompt);
  return (
    <section id="fix" aria-label="Fix with Claude" className="border-line mt-6 scroll-mt-24 rounded-md border bg-white p-5">
      <h2 className="text-sm font-bold tracking-[0.08em] uppercase">Fix with Claude</h2>
      <p className="text-muted mt-2 text-sm">
        Ids only. The prompt opens pre-filled and is not sent until you press Enter; read it first. Runbook:{" "}
        <code className="font-mono">docs/on-call.md#{built.anchor}</code>.
      </p>
      <pre className="border-line bg-paper-2 mt-3 max-h-64 overflow-auto rounded-sm border p-3 text-xs leading-relaxed whitespace-pre-wrap select-all">
        {built.prompt}
      </pre>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {cli ? (
          <a href={cli} className="bg-ink inline-flex min-h-9 items-center rounded-full px-4 text-sm font-bold text-white">
            Open in Claude Code
          </a>
        ) : null}
        <button
          type="button"
          onClick={() => {
            navigator.clipboard
              ?.writeText(built.prompt)
              .then(() => setCopied("copied"))
              .catch(() => setCopied("failed"));
          }}
          className="border-line-strong hover:border-ink inline-flex min-h-9 items-center rounded-full border px-4 text-sm font-bold transition-colors"
        >
          {copied === "copied" ? "Copied" : "Copy prompt"}
        </button>
        {code ? (
          <a href={code} className="border-line-strong hover:border-ink inline-flex min-h-9 items-center rounded-full border px-4 text-sm font-bold transition-colors">
            Open in VS Code
          </a>
        ) : null}
        {copied === "failed" ? (
          <span role="status" className="text-red-deep text-sm font-semibold">
            Could not copy; select the prompt above instead.
          </span>
        ) : null}
      </div>
    </section>
  );
}
