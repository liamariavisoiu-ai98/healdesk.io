"use client";

import { useId, useState } from "react";

import { portalMetaOutcome } from "@/lib/meta/portal-return";
import type { MetaConnectView } from "@/lib/meta/reconnect";
import { WEB_CHAT_COUNTS_LINE } from "@/lib/setup/channels";
import type { ForwardingView } from "@/lib/setup/forwarding";

import { MetaConnectButtons } from "../../MetaConnectButtons";
import { sendPhoneStepsAction } from "../../steps-actions";
import { ScreenShell } from "../ScreenShell";

/**
 * Step 4 · Your channels (plan Part E): each bought channel with its status
 * ("Live since …", "Paused until …") and what it needs, never an opening
 * date, and, where the channel is ready for it, the one step itself:
 *
 *   - Website chat: the line to paste, once the channel is open (ready on our
 *     side), with a Copy button (lib/setup/snippet.ts);
 *   - Instagram, Messenger & WhatsApp: "Connect with Facebook", the Meta
 *     login (/api/meta/login), and "Connect WhatsApp", Meta's embedded
 *     sign-up (/c/[slug]/whatsapp), each until it is connected, and
 *     Reconnect where Meta dropped it (MetaConnectButtons.tsx);
 *   - Phone: nothing about forwarding until voice is ready for the clinic
 *     (lib/setup/forwarding.ts); then AYA's number, the codes for the
 *     clinic's carrier and coverage mode with a carrier picker, the undo
 *     codes, "Email these to my office manager" (O11, the action Settings
 *     uses) and "Book a five-minute call and we'll do it with you", with
 *     equal weight.
 *
 * Every step sits in the screen's `lead`, outside its form, because the
 * Facebook button and the email are forms of their own.
 */

export type ChannelRow = {
  channel: "web" | "meta" | "voice";
  name: string;
  /** The status, with its time where it has one (lib/setup/channels.ts, channelStatusLabel). */
  status: string;
  /** What happens next, in one or two sentences. */
  line: string;
  /** Website chat, once open: the line to paste. */
  snippet?: string | null;
  /** Instagram, Messenger & WhatsApp: what is connected, dropped or still to connect, and whether each login can start. */
  meta?: MetaConnectView | null;
  /** Phone, once ready for the clinic: the forwarding steps. */
  forwarding?: ForwardingView | null;
  /** Phone, ready but for the direct line: where to set it. */
  directLineHref?: string | null;
};

export function ChannelsScreen(props: {
  slug: string;
  backHref: string | null;
  rows: readonly ChannelRow[];
  callBookingUrl: string | null;
  /** `?meta=` from a Meta login that could not start. */
  metaProblem?: string | null;
}) {
  const phone = props.rows.find((row) => row.channel === "voice");
  const metaOutcome = portalMetaOutcome(props.metaProblem);
  return (
    <ScreenShell
      slug={props.slug}
      screen="channels"
      title="Your channels"
      intro={<p>Where each channel you bought stands, and what it needs from you.</p>}
      lead={
        <>
          {metaOutcome ? (
            <p
              role={metaOutcome.ok ? "status" : "alert"}
              className={`rounded-xl border bg-white px-4 py-3 text-sm ${
                metaOutcome.ok ? "border-line" : "border-red-200 text-red-800"
              }`}
            >
              {metaOutcome.text}
            </p>
          ) : null}
          <ul className="grid gap-3">
            {props.rows.map((row) => (
              <li key={row.channel} className="border-line rounded-xl border bg-white px-4 py-3">
                <p className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{row.name}</span>
                  {/* Wraps rather than overflows: "Paused until …" carries a whole moment. */}
                  <span className="bg-paper-2 max-w-full rounded-full px-3 py-1 text-xs font-semibold">
                    {row.status}
                  </span>
                </p>
                <p className="text-muted mt-1 text-sm">{row.line}</p>
                {row.snippet ? <Snippet snippet={row.snippet} /> : null}
                {row.meta ? <MetaConnectButtons slug={props.slug} from="setup" view={row.meta} /> : null}
                {row.forwarding ? (
                  <Forwarding
                    slug={props.slug}
                    forwarding={row.forwarding}
                    callBookingUrl={props.callBookingUrl}
                  />
                ) : row.directLineHref ? (
                  <p className="mt-2 text-sm">
                    The forwarding steps appear here once your direct line is set: calls go there
                    whenever AYA can&rsquo;t answer.{" "}
                    <a href={row.directLineHref} className="font-semibold underline">
                      Set your direct line
                    </a>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {phone && !phone.forwarding && props.callBookingUrl ? (
            <p className="text-sm">
              When phone is ready, setting call forwarding is easier with someone on the line.{" "}
              <a
                href={props.callBookingUrl}
                className="font-semibold underline"
                rel="noopener noreferrer"
                target="_blank"
              >
                Book a five-minute call and we&rsquo;ll do it with you
              </a>
              .
            </p>
          ) : null}
        </>
      }
      skipCost=""
      skippable={false}
      backHref={props.backHref}
      submitLabel="Done"
      payload={() => ({})}
    />
  );
}

/** Copy to the clipboard, saying so politely; selecting the text is the fallback. */
function CopyButton({ text, label, targetId }: { text: string; label: string; targetId: string }) {
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

function Snippet({ snippet }: { snippet: string }) {
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
    </div>
  );
}

function Forwarding({
  slug,
  forwarding,
  callBookingUrl,
}: {
  slug: string;
  forwarding: ForwardingView;
  callBookingUrl: string | null;
}) {
  const pickerId = useId();
  const numberId = useId();
  const [carrier, setCarrier] = useState(forwarding.carrier);
  const shown =
    forwarding.carriers.find((c) => c.id === carrier) ??
    forwarding.carriers[forwarding.carriers.length - 1]!;
  return (
    <div className="mt-3 grid gap-3 text-sm">
      <div>
        <p className="font-semibold">Forward your main line&rsquo;s calls to AYA</p>
        <p id={numberId} className="mt-1 text-2xl font-semibold tracking-tight">
          {forwarding.ayaNumber}
        </p>
        <p className="mt-1">
          <CopyButton text={forwarding.ayaNumberE164} label="Copy the number" targetId={numberId} />
        </p>
      </div>
      {forwarding.phoneSystem === "voip" ? null : (
        <div className="grid gap-1">
          <label htmlFor={pickerId} className="font-semibold">
            Who provides your main line
          </label>
          <select
            id={pickerId}
            value={carrier}
            onChange={(event) => setCarrier(event.target.value as typeof carrier)}
            className="border-line min-h-11 rounded-xl border bg-white px-3"
          >
            {forwarding.carriers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <p className="font-semibold">The steps</p>
        <ol className="mt-1 grid list-decimal gap-1 pl-5">
          {shown.steps.map((step) => (
            <li key={`${step.label}${step.dial}`}>
              {step.label}
              {step.dial ? <strong className="ml-1 font-mono">{step.dial}</strong> : null}
            </li>
          ))}
        </ol>
      </div>
      <div>
        <p className="font-semibold">To undo it at any time</p>
        <ul className="mt-1 grid gap-1">
          {shown.undo.map((step) => (
            <li key={`${step.label}${step.dial}`}>
              {step.label}
              {step.dial ? <strong className="ml-1 font-mono">{step.dial}</strong> : null}
            </li>
          ))}
        </ul>
      </div>
      {shown.notes.length > 0 ? (
        <ul className="text-muted grid list-disc gap-1 pl-5">
          {shown.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <EmailSteps slug={slug} />
        {callBookingUrl ? (
          <div className="border-line rounded-xl border px-3 py-3">
            <p className="font-semibold">Rather do it together?</p>
            <a
              href={callBookingUrl}
              rel="noopener noreferrer"
              target="_blank"
              className="border-line mt-2 inline-flex min-h-11 items-center rounded-full border px-5 font-semibold"
            >
              Book a five-minute call and we&rsquo;ll do it with you
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Email these to my office manager": O11, through the same server action as
 * Settings → Channels (app/c/[slug]/steps-actions.ts), which reads AYA's
 * number itself and sends only once phone is ready on our side.
 */
function EmailSteps({ slug }: { slug: string }) {
  const fieldId = useId();
  const statusId = useId();
  const [to, setTo] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  return (
    <form
      noValidate
      aria-describedby={statusId}
      onSubmit={async (event) => {
        event.preventDefault();
        setWorking(true);
        setResult(null);
        try {
          setResult(await sendPhoneStepsAction(slug, to));
        } catch {
          setResult({ ok: false, message: "The email didn't go. Try again in a minute." });
        }
        setWorking(false);
      }}
      className="border-line grid gap-2 rounded-xl border px-3 py-3"
    >
      <label htmlFor={fieldId} className="font-semibold">
        Email these to my office manager
      </label>
      <input
        id={fieldId}
        type="email"
        autoComplete="off"
        value={to}
        onChange={(event) => setTo(event.target.value)}
        placeholder="maria@example.com"
        className="border-line min-h-11 rounded-xl border bg-white px-3"
      />
      <button
        type="submit"
        disabled={working}
        className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
      >
        {working ? "Sending…" : "Email the steps"}
      </button>
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={result ? (result.ok ? "text-sm" : "text-sm text-red-800") : "sr-only"}
      >
        {result?.message ?? ""}
      </p>
    </form>
  );
}
