"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ChatComposer, ChatThread, type ChatMessage } from "@/components/agent-panel/ChatView";

/**
 * The personalised demo's website-chat half: the widget the clinic would put
 * on its own site, answering as the clinic.
 *
 * Drawn with the shared ChatView, so it looks exactly like the homepage's
 * chat card. The greeting is not sent to the model: it is the first assistant
 * line on screen, and the route strips leading assistant turns before the call, so
 * the model sees the conversation from the visitor's first message. The
 * thread lives only in this component; nothing is stored on our side.
 */

type Message = ChatMessage;

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
      <ChatThread
        name={clinicName}
        logoUrl={logoUrl}
        messages={messages}
        chips={onlyGreeting && !locked ? chips : []}
        onChip={(chip) => void send(chip)}
        threadRef={scrollRef}
        error={error}
      />
      <ChatComposer
        name={clinicName}
        value={input}
        onChange={setInput}
        onSubmit={() => void send(input)}
        disabled={locked}
        sending={streaming}
        placeholder={locked ? "This demo has been archived" : undefined}
      />
    </div>
  );
}
