"use client";

import { useId, useState } from "react";

import { sendStepsAction } from "./steps-actions";

/**
 * O11 from the portal: one address, one button, and the outcome said right
 * under it in a polite status line, so it works on Settings (whose toasts
 * are elsewhere) and on the wizard's channel screen alike. The words that go
 * are ours; nothing typed here but the address is sent.
 *
 *   - phone (the default): "Email these steps to my office manager", the
 *     forwarding steps with AYA's number;
 *   - website chat: "Email to my web person", the line to paste
 *     (WebsiteLinePanel).
 */
export function SendStepsForm(
  props: { slug: string } & ({ channel?: "voice"; numberLabel: string } | { channel: "web" }),
) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const id = useId();
  const statusId = useId();
  const web = props.channel === "web";

  async function submit() {
    setBusy(true);
    try {
      const outcome = await sendStepsAction(props.slug, web ? "web" : "voice", to);
      setResult(outcome);
      if (outcome.ok) setTo("");
    } catch {
      setResult({ ok: false, message: "That didn't send. Try again in a minute." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      className="grid gap-2 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {props.channel === "web" ? (
        <p className="text-sm">
          If someone else looks after your website, we&rsquo;ll email them the line and where it
          goes, and nothing else.
        </p>
      ) : (
        <p className="text-sm">
          Forward your main line to AYA at{" "}
          <span className="font-semibold">{props.numberLabel}</span>. If someone else looks after
          your phone line, send them the steps for your carrier.
        </p>
      )}
      <label htmlFor={id} className="font-semibold">
        {web ? "Email to my web person" : "Email these steps to"}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          type="email"
          inputMode="email"
          autoComplete={web ? "off" : "email"}
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder={web ? "web@example.com" : "office@yourpractice.com"}
          aria-describedby={statusId}
          className="border-line min-h-11 min-w-0 flex-1 rounded-md border bg-white px-4 py-2 text-base"
        />
        <button
          type="submit"
          disabled={busy || !to.trim()}
          className="bg-ink min-h-11 rounded-full px-5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Sending…" : web ? "Send the line" : "Send the steps"}
        </button>
      </div>
      <p id={statusId} role="status" aria-live="polite" className="text-sm">
        {result ? <span className={result.ok ? "" : "text-problem"}>{result.message}</span> : null}
      </p>
    </form>
  );
}
