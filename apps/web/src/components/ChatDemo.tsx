"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { BuyButton } from "@/components/BuyModal";
import { HealdeskSoul } from "@/components/HealdeskSoul";
import { CHAT_EMAIL_NOTE } from "@/lib/consent";
import { DEMO_AGENT } from "@/lib/demo-agent";
import { site } from "@/lib/site";

type Message = { role: "user" | "assistant"; content: string };

const SEND_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);

/**
 * Live chat against Claude, via /api/chat.
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
  /**
   * One heartbeat of the header orb while an answer is streaming, in ms.
   *
   * Measured, not chosen: see `noteChunk`. Null between turns, which drops the
   * orb back to its resting rate.
   */
  const [beatMs, setBeatMs] = useState<number | null>(null);
  const lastChunkAt = useRef(0);
  const chunkGap = useRef(0);
  const [error, setError] = useState<string | null>(null);

  const [needsEmail, setNeedsEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [gateError, setGateError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages, streaming, needsEmail]);

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
  /**
   * Turn the arrival rate of streamed chunks into a heartbeat.
   *
   * A chunk lands every 30 to 150ms depending on how fast the model is going,
   * which is far too quick to beat on directly, so the gap is smoothed and
   * multiplied up. The exponential average is weighted towards history rather
   * than the newest sample: one slow packet should not make the orb lurch.
   *
   * The clamp is the honest part. Below 260ms a heartbeat stops reading as a
   * heartbeat and becomes a flicker; above 900ms it has stopped following
   * anything. Everything in between genuinely tracks the answer.
   */
  const noteChunk = useCallback(() => {
    const now = performance.now();
    const previous = lastChunkAt.current;
    lastChunkAt.current = now;
    if (!previous) return;

    const gap = now - previous;
    chunkGap.current = chunkGap.current ? chunkGap.current * 0.7 + gap * 0.3 : gap;

    const next = Math.min(Math.max(chunkGap.current * 6, 260), 900);
    // Only re-render when it has moved enough to see. Without this the orb
    // takes a new animation-duration on every packet, which restarts the
    // keyframe and leaves it twitching in place instead of beating.
    setBeatMs((current) => (current && Math.abs(current - next) < 60 ? current : next));
  }, []);

  const runTurn = useCallback(async (next: Message[]) => {
    setError(null);
    lastChunkAt.current = 0;
    chunkGap.current = 0;
    setMessages([...next, { role: "assistant", content: "" }]);
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
        body: JSON.stringify({ messages: next }),
        signal: controller.signal,
      });

      // The gate, and the only place it is discovered. Keep the visitor's
      // question on screen and drop the empty answer bubble.
      if (response.status === 401) {
        setMessages(next);
        setNeedsEmail(true);
        return;
      }

      if (!response.ok || !response.body) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
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
            noteChunk();
            setMessages((current) => {
              const updated = [...current];
              const last = updated[updated.length - 1];
              if (last?.role === "assistant") {
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: last.content + chunk,
                };
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
      setBeatMs(null);
      abortRef.current = null;
    }
  }, [noteChunk]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming || needsEmail) return;
      setInput("");
      void runTurn([...messages, { role: "user", content: trimmed }]);
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
          body: JSON.stringify({ email }),
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          setGateError(data?.error ?? "Something went wrong. Try again.");
          return;
        }
        setNeedsEmail(false);
        // The question is still the last entry in `messages`, send it as-is.
        void runTurn(messages);
      } catch {
        setGateError("Network error. Try again.");
      } finally {
        setUnlocking(false);
      }
    },
    [email, messages, runTurn],
  );

  const showChips = messages.length === 0;

  return (
    <div className="border-line flex h-[600px] flex-col overflow-hidden rounded-[18px] border bg-white">
      <div className="border-line flex items-center gap-2.5 border-b px-[18px] py-3.5">
        {/* Alive from first paint, faster while she is composing. The tempo
            is the real streaming rate, so a stalled answer stalls the orb. */}
        <HealdeskSoul
          mode={streaming ? "typing" : "idle"}
          beatMs={beatMs ?? undefined}
          size={26}
          label={streaming ? `${site.agent} is typing` : undefined}
        />
        <span className="text-sm font-bold">Web chat &amp; Instagram DM</span>
        <span className="text-muted ml-auto text-[15px] font-semibold">
          Live AI · ask anything
        </span>
      </div>

      <div
        ref={threadRef}
        className="scroll-subtle flex flex-1 flex-col gap-2.5 overflow-y-auto px-[18px] py-5"
        aria-live="polite"
      >
        <Bubble role="assistant">{DEMO_AGENT.greeting}</Bubble>

        {/* An assistant turn with nothing in it yet renders nothing at all.
            It used to hold a placeholder, which put a piece of chrome in the
            thread pretending to be a message and pulled the eye away from the
            header, where the orb is already saying the same thing. */}
        {messages.map((message, index) =>
          message.content ? (
            <Bubble key={index} role={message.role}>
              {message.content}
            </Bubble>
          ) : null,
        )}

        {error ? (
          <p className="text-red-deep px-1 text-[15.6px] font-semibold">{error}</p>
        ) : null}
      </div>

      {showChips ? (
        <div className="flex flex-wrap gap-2 px-[18px] pb-3">
          {DEMO_AGENT.chips.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => send(chip)}
              className="border-line hover:border-orange hover:text-ink text-muted rounded-full border bg-white px-3.5 py-2 text-[15.6px] font-semibold transition-colors"
            >
              {chip}
            </button>
          ))}
        </div>
      ) : null}

      {needsEmail ? (
        <form onSubmit={unlock} className="border-line border-t px-[18px] py-4">
          <p className="text-[16.2px] font-semibold">
            Where should {site.agent} send her answer?
          </p>
          <p className="text-muted mt-1 text-[15px] font-medium">
            Drop your email and she&apos;ll reply right here.
          </p>

          <div className="border-line focus-within:border-orange mt-3 flex items-center gap-2 rounded-full border py-1.5 pr-1.5 pl-4 transition-colors">
            <input
              ref={emailRef}
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@yourclinic.com"
              aria-label="Work email"
              autoComplete="email"
              className="text-ink placeholder:text-muted min-w-0 flex-1 bg-transparent text-[17.4px] outline-none"
            />
            <button
              type="submit"
              disabled={unlocking}
              className="bg-brand-gradient rounded-full px-4 py-2 text-[15.6px] font-bold text-white transition-opacity disabled:opacity-50"
            >
              {unlocking ? "…" : "Send"}
            </button>
          </div>

          {gateError ? (
            <p className="text-red-deep mt-2 text-[15.6px] font-semibold" role="alert">
              {gateError}
            </p>
          ) : (
            <p className="text-muted mt-2 text-[13.2px] leading-relaxed">
              {CHAT_EMAIL_NOTE}
            </p>
          )}
        </form>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send(input);
          }}
          className="border-line flex items-center gap-2.5 border-t px-3.5 py-3"
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask about treatments, pricing, or healdesk…"
            aria-label="Message the assistant"
            autoComplete="off"
            className="text-ink placeholder:text-muted min-w-0 flex-1 bg-transparent text-[17.4px] outline-none"
          />
          <button
            type="submit"
            disabled={streaming || !input.trim()}
            aria-label="Send message"
            className="bg-brand-gradient grid size-[38px] shrink-0 place-items-center rounded-full text-white transition-transform duration-150 hover:-translate-y-px disabled:translate-y-0 disabled:opacity-45 [&_svg]:size-[17px]"
          >
            {SEND_ICON}
          </button>
        </form>
      )}

      {/* The conversion step, where the conviction actually happens. It carries
          the email already given to the gate, so the buyer meets a form that is
          partly answered rather than a blank one on another page. */}
      <div className="border-line flex items-center gap-3 border-t px-[18px] py-3">
        <span className="text-muted text-[15px] font-semibold">
          {/* Not "answering your line": that is the phone panel's question, and
              it was on both. This one covers what this panel actually
              demonstrates, which is the website widget and the Meta inbox. */}
          Want her on your site and your DMs?
        </span>
        <BuyButton
          variant="quiet"
          className="ml-auto shrink-0 !px-4 !py-2 !text-[15.6px]"
          prefill={{ email: email.trim() || undefined }}
        />
      </div>
    </div>
  );
}

function Bubble({
  role,
  children,
}: {
  role: "user" | "assistant";
  children: React.ReactNode;
}) {
  const isAgent = role === "assistant";
  return (
    <div
      className={[
        "max-w-[82%] rounded-2xl px-[15px] py-[11px] text-[17.4px] leading-[1.42] whitespace-pre-wrap",
        isAgent
          ? "bg-paper-2 text-ink self-start rounded-bl-[5px]"
          : "bg-brand-gradient self-end rounded-br-[5px] text-white",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

