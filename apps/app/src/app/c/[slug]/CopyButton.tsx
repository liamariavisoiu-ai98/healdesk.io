"use client";

import { useState } from "react";

/**
 * Copy to the clipboard, saying so politely; selecting the text in the field
 * named `targetId` is the fallback where the clipboard is refused. The
 * wizard's channel screen and Settings → Channels share it: the website line
 * (WebsiteLinePanel) and AYA's number on the forwarding screen.
 */
export function CopyButton({
  text,
  label,
  targetId,
}: {
  text: string;
  label: string;
  targetId: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          } catch {
            const field = document.getElementById(targetId);
            if (field instanceof HTMLTextAreaElement) field.select();
            setCopied(false);
          }
        }}
        className="border-line min-h-11 rounded-full border px-5 text-sm font-semibold"
      >
        {label}
      </button>
      <span role="status" aria-live="polite" className="text-muted ml-2 text-sm">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}
