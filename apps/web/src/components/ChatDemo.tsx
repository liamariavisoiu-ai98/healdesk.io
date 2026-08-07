"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Specialty } from "@/lib/specialties";

type Message = { role: "user" | "assistant"; content: string };

const CHAT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const SEND_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);

/**
 * Live chat against Claude, via /api/chat.
 *
 * Gated on an email: the visitor submits one, the server sets a signed cookie,
 * and only then will the chat route answer. Every demo becomes a lead, and the
 * gate doubles as the first line of abuse control.
 */
export function ChatDemo({ specialty }: { specialty: Specialty }) {
  const [unlocked, setUnlocked] = useState(false);
  const [email, setEmail] = useState("");
  const [gateError, setGateError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Switching specialty resets the conversation — the system prompt changed, so
  // carrying turns across would produce an assistant that contradicts itself.
  useEffect(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setStreaming(false);
  }, [specialty.id]);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages, streaming]);

  useEffect(() => () => abortRef.current?.abort(), []);

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
        setUnlocked(true);
      } catch {
        setGateError("Network error. Try again.");
      } finally {
        setUnlocking(false);
      }
    },
    [email],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      setError(null);
      setInput("");

      const next: Message[] = [...messages, { role: "user", content: trimmed }];
      setMessages([...next, { role: "assistant", content: "" }]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specialtyId: specialty.id, messages: next }),
          signal: controller.signal,
        });

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
        // buffer — chunk boundaries do not respect line boundaries.
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
        abortRef.current = null;
      }
    },
    [messages, specialty.id, streaming],
  );

  const showChips = messages.length === 0 && unlocked;

  return (
    <div className="border-line flex h-[500px] flex-col overflow-hidden rounded-[18px] border bg-white">
      <div className="border-line flex items-center gap-2.5 border-b px-[18px] py-3.5">
        <span className="bg-orange/[0.12] text-red grid size-[30px] shrink-0 place-items-center rounded-[9px] [&_svg]:size-4">
          {CHAT_ICON}
        </span>
        <span className="text-sm font-bold">Web chat &amp; SMS</span>
        <span className="text-muted ml-auto text-[12.5px] font-semibold">
          {unlocked ? "Live AI · ask anything" : "Live AI · email to unlock"}
        </span>
      </div>

      {!unlocked ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
          <div>
            <p className="font-display text-[22px] leading-tight font-medium tracking-[-0.02em]">
              Talk to a real {specialty.name.toLowerCase()} front desk.
            </p>
            <p className="text-muted mx-auto mt-2 max-w-[34ch] text-sm font-medium">
              This is a live model, not a script. Drop your email and ask it
              anything — pricing, scheduling, or how healdesk would run your
              phones.
            </p>
          </div>

          <form onSubmit={unlock} className="w-full max-w-sm">
            <div className="border-line focus-within:border-orange flex items-center gap-2 rounded-full border py-1.5 pr-1.5 pl-4 transition-colors">
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@yourclinic.com"
                aria-label="Work email"
                className="text-ink placeholder:text-muted min-w-0 flex-1 bg-transparent text-[14.5px] outline-none"
              />
              <button
                type="submit"
                disabled={unlocking}
                className="bg-brand-gradient rounded-full px-4 py-2 text-[13px] font-bold text-white transition-opacity disabled:opacity-50"
              >
                {unlocking ? "…" : "Start"}
              </button>
            </div>
            {gateError ? (
              <p className="text-red mt-2 text-[13px] font-semibold">{gateError}</p>
            ) : (
              <p className="text-muted mt-2 text-xs">
                One email, no spam. We&apos;ll only follow up about healdesk.
              </p>
            )}
          </form>
        </div>
      ) : (
        <>
          <div
            ref={threadRef}
            className="scroll-subtle flex flex-1 flex-col gap-2.5 overflow-y-auto px-[18px] py-5"
            aria-live="polite"
          >
            <Bubble role="assistant">{specialty.greeting}</Bubble>

            {messages.map((message, index) => (
              <Bubble key={index} role={message.role}>
                {message.content ||
                  (streaming && index === messages.length - 1 ? <Typing /> : "")}
              </Bubble>
            ))}

            {error ? (
              <p className="text-red px-1 text-[13px] font-semibold">{error}</p>
            ) : null}
          </div>

          {showChips ? (
            <div className="flex flex-wrap gap-2 px-[18px] pb-3">
              {specialty.chips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => void send(chip)}
                  className="border-line hover:border-orange hover:text-ink rounded-full border bg-white px-3.5 py-2 text-[13px] font-semibold text-[#5a4a3f] transition-colors"
                >
                  {chip}
                </button>
              ))}
            </div>
          ) : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
            className="border-line flex items-center gap-2.5 border-t px-3.5 py-3"
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask about treatments, pricing, or healdesk…"
              aria-label="Message the assistant"
              autoComplete="off"
              className="text-ink placeholder:text-muted min-w-0 flex-1 bg-transparent text-[14.5px] outline-none"
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
        </>
      )}
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
        "max-w-[82%] rounded-2xl px-[15px] py-[11px] text-[14.5px] leading-[1.42] whitespace-pre-wrap",
        isAgent
          ? "bg-paper-2 text-ink self-start rounded-bl-[5px]"
          : "bg-brand-gradient self-end rounded-br-[5px] text-white",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

function Typing() {
  return (
    <span className="inline-flex gap-1" aria-label="Assistant is typing">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="bg-muted size-1.5 animate-pulse rounded-full"
          style={{ animationDelay: `${index * 0.2}s` }}
        />
      ))}
    </span>
  );
}
