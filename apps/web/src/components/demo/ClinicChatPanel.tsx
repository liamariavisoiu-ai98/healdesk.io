"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ChatSkins, type SkinMessage } from "@/components/agent-panel/ChatSkins";

/**
 * The personalised demo's chat: one conversation, dressed four ways.
 *
 * The drawing, the Website, WhatsApp, Instagram and Messenger boxes and
 * everything under them, is the shared ChatSkins (components/agent-panel),
 * which the homepage's card uses too. What is this card's own is the
 * conversation: api/demo/[slug]/chat, as the clinic, and the archive lock.
 * The route is never told which box is showing, and nothing goes to Meta.
 *
 * The greeting is not sent to the model: it is the first assistant line on
 * screen, and the route strips leading assistant turns before the call. The
 * thread lives only in this component; nothing is stored on our side.
 *
 * ## When a chat "ends"
 *
 * A chat has no hang-up, so `onConversationEnded` is called once, the first
 * time the visitor goes quiet after a real exchange: AYA's third reply and
 * then fifteen seconds without a keystroke, or four seconds after she offers
 * a time, which is where a booking conversation peaks. The demo page shows its
 * close card then (components/demo/DemoClose.tsx). Only the timing is read;
 * nothing of the conversation leaves this component.
 */

const QUIET_AFTER_EXCHANGE_MS = 15_000;
const QUIET_AFTER_TIME_OFFER_MS = 4_000;
const EXCHANGE_REPLIES = 3;
const OFFERS_A_TIME = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i;

type Message = SkinMessage;

export function ClinicChatPanel({
  slug,
  clinicName,
  logoUrl,
  greeting,
  chips,
  locked,
  onConversationEnded,
}: {
  slug: string;
  clinicName: string;
  logoUrl: string | null;
  greeting: string;
  chips: string[];
  locked: boolean;
  onConversationEnded?: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>(() => [{ role: "assistant", content: greeting }]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Once per page: see "When a chat ends" above.
  const endedRef = useRef(false);
  useEffect(() => {
    if (endedRef.current || streaming || !onConversationEnded) return;
    const replies = messages.filter((m) => m.role === "assistant").length - 1; // less the greeting
    if (replies < 1 || input.trim() !== "") return;
    const last = messages[messages.length - 1];
    const offered = last?.role === "assistant" && OFFERS_A_TIME.test(last.content);
    if (!offered && replies < EXCHANGE_REPLIES) return;
    const id = window.setTimeout(
      () => {
        endedRef.current = true;
        onConversationEnded();
      },
      offered ? QUIET_AFTER_TIME_OFFER_MS : QUIET_AFTER_EXCHANGE_MS,
    );
    return () => window.clearTimeout(id);
  }, [messages, streaming, input, onConversationEnded]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || streaming || locked) return;
      setError(null);
      setInput("");
      const next: Message[] = [...messages, { role: "user", content, at: Date.now() }];
      setMessages([...next, { role: "assistant", content: "", at: Date.now() }]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch(`/api/demo/${slug}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: next.map(({ role, content: c }) => ({ role, content: c })) }),
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
                const copy = [...current];
                const last = copy[copy.length - 1];
                if (last?.role === "assistant") copy[copy.length - 1] = { ...last, content: last.content + chunk };
                return copy;
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

  return (
    <ChatSkins
      name={clinicName}
      logoUrl={logoUrl}
      messages={messages}
      chips={chips}
      onSend={(text) => void send(text)}
      input={input}
      onInput={setInput}
      streaming={streaming}
      disabled={locked}
      disabledPlaceholder="This demo has been archived"
      aiNotice={`Messages are answered by ${clinicName}\u2019s AI assistant.`}
      error={error}
    />
  );
}
