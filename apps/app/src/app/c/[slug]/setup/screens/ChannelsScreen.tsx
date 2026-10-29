"use client";

import { useId, useState } from "react";

import type { ChannelPresentation } from "@/lib/setup/channel-status";
import { portalMetaOutcome } from "@/lib/meta/portal-return";
import type { MetaConnectView } from "@/lib/meta/reconnect";
import type { ForwardingView } from "@/lib/setup/forwarding";
import type { ForwardingTestView } from "@/lib/setup/forwarding-test-words";

import { ChannelNextButton, ChannelPill } from "../../ChannelStatus";
import { ForwardingStepsPanel } from "../../ForwardingStepsPanel";
import { ForwardingTestPanel } from "../../ForwardingTestPanel";
import { CopyButton } from "../../CopyButton";
import { MetaConnectButtons } from "../../MetaConnectButtons";
import { sendPhoneStepsAction } from "../../steps-actions";
import { WebsiteLinePanel } from "../../WebsiteLinePanel";
import { ScreenShell } from "../ScreenShell";

/**
 * Step 4 · Your channels (plan Part E): each bought channel with its status
 * ("Live since …", "Paused until …") and what it needs, never an opening
 * date, and, where the channel is ready for it, the one step itself:
 *
 *   - Website chat: the line to paste, once the channel is open (ready on our
 *     side), with a Copy button and "Email to my web person"
 *     (lib/setup/snippet.ts), in the panel Settings → Channels shows too
 *     (WebsiteLinePanel);
 *   - Instagram, Messenger & WhatsApp: "Connect with Facebook", the Meta
 *     login (/api/meta/login), and "Connect WhatsApp", Meta's embedded
 *     sign-up (/c/[slug]/whatsapp), each until it is connected, and
 *     Reconnect where Meta dropped it (MetaConnectButtons.tsx);
 *   - Phone: nothing about forwarding until voice is ready for the clinic
 *     (lib/setup/forwarding.ts); then AYA's number, the codes for the
 *     clinic's phone system, carrier and coverage mode with a picker for
 *     each (ForwardingStepsPanel), the undo codes, "Email these to my
 *     office manager" (O11, the action Settings uses) and "Book a
 *     five-minute call and we'll do it with you", with equal weight; then
 *     "Waiting for call forwarding" with "Test it now" (ForwardingTestPanel)
 *     until a forwarded call lands.
 *
 * Every step sits in the screen's `lead`, outside its form, because the
 * Facebook button and the email are forms of their own.
 */

export type ChannelRow = {
  channel: "web" | "meta" | "voice";
  name: string;
  /** Status, one sentence and the one button (lib/setup/channel-status.ts), the reading Settings draws too. */
  presentation: ChannelPresentation;
  /** Website chat, once open: the line to paste. */
  snippet?: string | null;
  /** Website chat, once open: whether the chat has been seen on the site (lib/channels/widget-sighting.ts sightingLine). */
  sighting?: string | null;
  /** Instagram, Messenger & WhatsApp: what is connected, dropped or still to connect, and whether each login can start. */
  meta?: MetaConnectView | null;
  /** Phone, once ready for the clinic: the forwarding steps. */
  forwarding?: ForwardingView | null;
  /** Phone, once ready for the clinic: "Test it now" and what it saw. */
  forwardingTest?: ForwardingTestView | null;
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
                  <span>
                    <ChannelPill presentation={row.presentation} />
                  </span>
                </p>
                <p className="text-muted mt-1 text-sm">{row.presentation.detail}</p>
                <ChannelNextButton surface="wizard" slug={props.slug} action={row.presentation.action} />
                {row.snippet ? (
                  <WebsiteLinePanel slug={props.slug} snippet={row.snippet} sighting={row.sighting ?? null} />
                ) : null}
                {row.meta ? <MetaConnectButtons slug={props.slug} from="setup" view={row.meta} /> : null}
                {row.forwarding ? (
                  <Forwarding
                    slug={props.slug}
                    forwarding={row.forwarding}
                    test={row.forwardingTest ?? null}
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

function Forwarding({
  slug,
  forwarding,
  test,
  callBookingUrl,
}: {
  slug: string;
  forwarding: ForwardingView;
  test: ForwardingTestView | null;
  callBookingUrl: string | null;
}) {
  const numberId = useId();
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
      <ForwardingStepsPanel slug={slug} view={forwarding} />
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
      {test ? <ForwardingTestPanel slug={slug} initial={test} /> : null}
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
