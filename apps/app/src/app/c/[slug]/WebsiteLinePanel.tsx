"use client";

import { useId } from "react";

import { WEB_CHAT_COUNTS_LINE } from "@/lib/setup/channels";

import { CopyButton } from "./CopyButton";
import { SendStepsForm } from "./SendStepsForm";

/**
 * Website chat's line, once the channel is open (lib/setup/snippet.ts): the
 * one line to paste, where it goes, that a chat on the live site is a real
 * one, a Copy button and "Email to my web person" (O11, through the action
 * the phone steps use). One component for the wizard's channel screen and
 * Settings → Channels, so the line a clinic copies, and what it is told
 * about it, never differ between the two (spec: "shown on screen, emailed,
 * and available in the dashboard forever").
 */
export function WebsiteLinePanel({ slug, snippet }: { slug: string; snippet: string }) {
  const id = useId();
  return (
    <div className="mt-3 grid gap-2 text-sm">
      <label htmlFor={id} className="font-semibold">
        The line for your website
      </label>
      <textarea
        id={id}
        readOnly
        rows={2}
        value={snippet}
        className="border-line bg-paper-2 w-full rounded-xl border px-3 py-2 font-mono text-xs"
      />
      <p className="text-muted">
        Paste it once, just before <code>&lt;/body&gt;</code>, on every page of your website, or
        send it to whoever looks after your site. AYA is designed to start answering there once
        it&rsquo;s in.
      </p>
      <p>{WEB_CHAT_COUNTS_LINE}</p>
      <p>
        <CopyButton text={snippet} label="Copy the line" targetId={id} />
      </p>
      <SendStepsForm slug={slug} channel="web" />
    </div>
  );
}
