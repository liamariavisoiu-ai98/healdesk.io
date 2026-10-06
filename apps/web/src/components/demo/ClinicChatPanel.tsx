"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The personalised demo's website-chat half: the widget the clinic would put
 * on its own site, answering as the clinic.
 *
 * The greeting is not sent to the model: it is the first assistant line on
 * screen, and the route strips leading assistant turns before the call, so
 * the model sees the conversation from the visitor's first message. The
 * thread lives only in this component; nothing is stored on our side.
 */

type Message = { role: "user" | "assistant"; content: string };

export function ClinicChatPanel({
  slug,
  clinicName,
  logoUrl,
  greeting,
  chips,
  locked,
}: {
  slug: string;
  clinicName: string;
  logoUrl: string | null;
  greeting: string;
  chips: string[];
  locked: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([{ role: "assistant", content: greeting }]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || streaming || locked) return;
      setError(null);
      setInput("");
      const next: Message[] = [...messages, { role: "user", content }];
      setMessages([...next, { role: "assistant", content: "" }]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch(`/api/demo/${slug}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: next }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const data = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? "The assistant is unavailable.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
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
                if (last?.role === "assistant") updated[updated.length - 1] = { role: "assistant", content: last.content + chunk };
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
        setMessages((current) => {
          const last = current[current.length - 1];
          return last?.role === "assistant" && last.content === "" ? current.slice(0, -1) : current;
        });
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [locked, messages, slug, streaming],
  );

  const onlyGreeting = messages.length === 1;

  return (
    <div className="flex min-h-[460px] flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-5" aria-live="polite">
        {messages.map((message, i) =>
          message.role === "assistant" ? (
            <div key={i} className="flex items-end gap-2">
              <span
                className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-full text-[12px] font-bold"
                style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
                aria-hidden
              >
                {logoUrl ? (
                  <img src={logoUrl} alt="" referrerPolicy="no-referrer" className="size-full bg-white object-contain p-0.5" />
                ) : (
                  clinicName.slice(0, 1).toUpperCase()
                )}
              </span>
              <p className="bg-paper-2 text-ink max-w-[85%] rounded-2xl rounded-bl-md px-3.5 py-2.5 text-[15.6px] leading-[1.5] whitespace-pre-wrap">
                {message.content || <span className="text-muted">…</span>}
              </p>
            </div>
          ) : (
            <div key={i} className="flex justify-end">
              <p
                className="max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5 text-[15.6px] leading-[1.5] whitespace-pre-wrap"
                style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
              >
                {message.content}
              </p>
            </div>
          ),
        )}
        {onlyGreeting && !locked ? (
          <div className="flex flex-wrap gap-2 pt-1 pl-9">
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => send(chip)}
                className="border-line hover:border-line-strong text-ink rounded-full border bg-white px-3 py-1.5 text-left text-[14px] font-semibold transition-colors"
              >
                {chip}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="text-red-deep px-4 pb-2 text-[14.4px] font-semibold" role="alert">
          {error}
        </p>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="border-line flex items-center gap-2 border-t p-3"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={locked ? "This demo has been archived" : `Message ${clinicName}…`}
          aria-label={`Message ${clinicName}`}
          maxLength={1000}
          disabled={locked}
          className="border-line text-ink placeholder:text-muted min-w-0 flex-1 rounded-full border px-4 py-2.5 text-[16px] outline-none transition-colors focus:border-[var(--clinic)]"
        />
        <button
          type="submit"
          disabled={locked || streaming || !input.trim()}
          className="shrink-0 rounded-full px-5 py-2.5 text-[15.6px] font-bold transition-opacity disabled:opacity-45"
          style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
