"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ChatSkins, type SkinMessage } from "@/components/agent-panel/ChatSkins";
import { track } from "@/lib/analytics";
import { campaignCode } from "@/lib/attribution";
import {
  CHAT_EMAIL_NOTE,
  CONSENT_NOTICE_VERSION,
  GATE_NOTICE,
  MARKETING_CONSENT_LABEL,
} from "@/lib/consent";
import { DEMO_AGENT } from "@/lib/demo-agent";
import { site } from "@/lib/site";

type Message = SkinMessage;

/** AYA's avatar in the thread: the healdesk "h". */
const AVATAR = "/icon.png";

/**
 * Live chat against Claude, via /api/chat.
 *
 * ## Drawn like the personalised demo's
 *
 * Since 9 October 2026 the card is the shared ChatSkins inside the shared
 * AgentPanel (components/agent-panel), so it looks exactly like the chat on a
 * clinic's personalised demo, the Website, WhatsApp, Instagram and Messenger
 * boxes included, in healdesk's colour (owner's request). What is this card's
 * own is the conversation: the email gate below, the route's pause, and the
 * analytics. The boxes only dress the thread; /api/chat never hears which one
 * is showing.
 *
 * ## One agent, no picker
 *
 * The panel sends no specialty. That is the product: a single agent that starts
 * at the root of the knowledge tree and goes deeper as the conversation reveals
 * who it is talking to. A dropdown in front of the chat demonstrated the
 * opposite. That healdesk is configured per vertical and you were about to see
 * the one you clicked. See lib/demo-agent.ts.
 *
 * ## The email is asked for AFTER the first message, not before
 *
 * The gate still exists, /api/chat refuses to answer without a signed cookie,
 * which is what keeps the model bill bounded and each demo attached to a lead.
 * What changed is when the visitor meets it. Asking first put a form in front
 * of a page whose entire argument is "watch this thing work", so the cost of
 * the ask landed before any of the value did. Now they type their question,
 * hit send, see their own words in the thread, and the ask arrives with the
 * answer already queued behind it.
 *
 * The mechanism is deliberately the 401 rather than a "am I gated?" probe on
 * mount. A returning visitor with a valid cookie is never asked and never pays
 * for an extra round trip; a new one spends one rejected request, and their
 * message is already on screen while they type the email. The server stays the
 * single source of truth about whether the gate is satisfied, which a client
 * flag would not be.
 */
export function ChatDemo() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The route said 503: no model key, or the daily cap. That is not a retry
   * situation, so the panel stops offering one until the page is reloaded.
   * Keyed on the status, not on the message text: matching "unavailable" in
   * the error string also caught the generic fallback for any 5xx, and a
   * transient 500 locked the demo until reload.
   */
  const [paused, setPaused] = useState(false);

  const [needsEmail, setNeedsEmail] = useState(false);
  const [email, setEmail] = useState("");
  // Unticked by default, and never required. See src/lib/consent.ts.
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The composer is replaced by the email field, so move the caret with it.
  useEffect(() => {
    if (needsEmail) emailRef.current?.focus();
  }, [needsEmail]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * Run one turn against an already-complete message list.
   *
   * Takes the full list rather than appending, so the same function serves the
   * first attempt and the retry after the email, the visitor's turn is already
   * in `messages` at that point and appending again would double it.
   */
  const runTurn = useCallback(async (next: Message[]) => {
    setError(null);
    setMessages([...next, { role: "assistant", content: "", at: Date.now() }]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No specialtyId: one agent, every specialty. It works out which one it
        // is talking to from the conversation, which is also why every visitor
        // here shares one cached system prompt.
        body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })) }),
        signal: controller.signal,
      });

      // The gate, and the only place it is discovered. Keep the visitor's
      // question on screen and drop the empty answer bubble.
      if (response.status === 401) {
        setMessages(next);
        setNeedsEmail(true);
        track("demo_gate_viewed");
        return;
      }

      if (!response.ok || !response.body) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        if (response.status === 503) setPaused(true);
        throw new Error(data?.error ?? "The assistant is unavailable.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // NDJSON: one JSON object per line. Keep the trailing partial in the
      // buffer, chunk boundaries do not respect line boundaries.
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: { type?: string; text?: string; error?: string };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === "text" && event.text) {
            const chunk = event.text;
            setMessages((current) => {
              const updated = [...current];
              const last = updated[updated.length - 1];
              if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, content: last.content + chunk };
              }
              return updated;
            });
          } else if (event.type === "error" && event.error) {
            setError(event.error);
          }
        }
      }
    } catch (caught) {
      if ((caught as Error).name === "AbortError") return;
      setError((caught as Error).message);
      // Drop the empty assistant bubble so the thread doesn't dead-end.
      setMessages((current) => {
        const last = current[current.length - 1];
        if (last?.role === "assistant" && last.content === "") {
          return current.slice(0, -1);
        }
        return current;
      });
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, []);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming || needsEmail) return;
      setInput("");
      void runTurn([...messages, { role: "user", content: trimmed, at: Date.now() }]);
    },
    [messages, needsEmail, runTurn, streaming],
  );

  const unlock = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setUnlocking(true);
      setGateError(null);
      try {
        const response = await fetch("/api/gate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            marketingConsent,
            noticeVersion: CONSENT_NOTICE_VERSION,
            // `?c=` from a cold-email link, remembered for the session so a
            // visitor who browses first still attributes to the campaign.
            campaign: campaignCode(),
          }),
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          setGateError(data?.error ?? "Something went wrong. Try again.");
          return;
        }
        track("demo_unlocked", { consent: marketingConsent });
        setNeedsEmail(false);
        // The question is still the last entry in `messages`, send it as-is.
        void runTurn(messages);
      } catch {
        setGateError("Network error. Try again.");
      } finally {
        setUnlocking(false);
      }
    },
    [email, marketingConsent, messages, runTurn],
  );

  const emailAsk = needsEmail ? (
    <form onSubmit={unlock} className="border-line border-t px-4 py-4">
      <p className="text-sm font-semibold">
        Where should {site.agent} send her answer?
      </p>
      <p className="text-muted mt-1 text-sm font-medium">
        Drop your email and she&apos;ll reply right here.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <input
          ref={emailRef}
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@yourclinic.com"
          aria-label="Work email"
          autoComplete="email"
          className="border-line text-ink placeholder:text-muted min-w-0 flex-1 rounded-full border px-4 py-2.5 text-sm outline-none transition-colors focus:border-[var(--clinic)]"
        />
        <button
          type="submit"
          disabled={unlocking}
          className="shrink-0 rounded-full px-5 py-2.5 text-sm font-bold transition-opacity disabled:opacity-45"
          style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
        >
          {unlocking ? "…" : "Send"}
        </button>
      </div>

      {gateError ? (
        <p className="text-red-deep mt-2 text-sm font-semibold" role="alert">
          {gateError}
        </p>
      ) : (
        <p className="text-muted mt-2 text-xs leading-relaxed">
          {CHAT_EMAIL_NOTE}
        </p>
      )}

      {/* Collection notice and the SEPARATE marketing opt-in. The box is
          unticked by default and is never required: unlocking the demo is
          the service asked for, not consent to be marketed to. The label
          is rendered verbatim from the constant the server stores. */}
      <p className="text-muted mt-3 text-xs leading-relaxed">
        {GATE_NOTICE}{" "}
        <a href="/privacy" className="text-red-deep underline underline-offset-2">
          Privacy policy
        </a>
      </p>
      <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs leading-relaxed">
        <input
          type="checkbox"
          checked={marketingConsent}
          onChange={(event) => setMarketingConsent(event.target.checked)}
          className="accent-red-deep mt-[3px] h-4 w-4 shrink-0"
        />
        <span className="text-ink">{MARKETING_CONSENT_LABEL}</span>
      </label>
    </form>
  ) : null;

  return (
    <ChatSkins
      name={site.agent}
      logoUrl={AVATAR}
      // The greeting is the thread's first line on screen; it is never sent
      // to the model.
      messages={[{ role: "assistant", content: DEMO_AGENT.greeting }, ...messages]}
      chips={paused ? [] : DEMO_AGENT.chips}
      onSend={send}
      input={input}
      onInput={setInput}
      streaming={streaming}
      disabled={paused}
      disabledPlaceholder="The demo is paused"
      placeholder="Ask about treatments, pricing, or healdesk…"
      aiNotice={`Messages are answered by ${site.agent}, an AI assistant.`}
      error={error}
      composer={emailAsk}
      // White, with AYA's mark on red (owner, 12 October 2026).
      headerTone="light"
      // The line under the field that said this is a demo for clinic staff,
      // and not to type patient information, went at the owner's request on
      // 12 October 2026. Privacy section 2 still says it.
    />
  );
}
