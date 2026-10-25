"use client";

import { useParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

/**
 * The support chat (plan Part H; spec, "Support chat in the portal"): a
 * bubble on every screen of the portal and the setup wizard, and a button in
 * Help, both opening one panel.
 *
 * The BROWSER holds the conversation: this tab's sessionStorage, as the
 * server screened it, until the tab closes or "Start over" clears it. The
 * server keeps none of it. Each message goes to /c/<slug>/help/chat with the
 * conversation so far, and the reply streams back as one JSON event a line.
 *
 * Plain text only: every message is a React text node in a pre-wrapped
 * paragraph, so nothing the model writes can become markup or a link. The
 * links it offers arrive as their own events, are checked to be on this
 * page's own origin, and show as buttons under the reply. A reply streams
 * into view silently and is announced once, whole, in a polite live region
 * (plan Part F8: "streamed replies announced once complete"). The input
 * carries the permanent line "This is product support. Please don't paste
 * {patient|client} information" (spec, "One rule that has to be in the
 * interface"), and the conversation's opening message says it again, since
 * helper text under an input is easy to miss (design E5 §3).
 */

type ChatLink = { label: string; url: string };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Under a person's message: what the screen hid, in words. */
  notices?: string[];
  links?: ChatLink[];
  /** Under a reply: the escalation, once it has gone. */
  note?: string;
  /** A fixed line (a refusal, a limit, a failure): never sent back as conversation. */
  fixed?: boolean;
  pending?: boolean;
};

type ChatEvent =
  | { type: "screened"; text: string; notices: string[] }
  | { type: "delta"; text: string }
  | { type: "link"; label: string; url: string }
  | { type: "escalated"; topic: string; replyByOn: string; to: string | null }
  | { type: "replace"; text: string }
  | { type: "done"; outcome: string };

const MAX_CHARS = 2_000;
const STORAGE_PREFIX = "healdesk-support-chat:";

const TOPIC_WORDS: Record<string, string> = {
  forwarding: "call forwarding",
  calendar: "your calendar connection",
  channel: "a channel",
  plan: "your plan",
  billing: "billing",
  transcript: "a transcript",
  sign_in: "signing in",
  other: "your question",
};

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** "Wednesday 15 October", from an ISO date. */
function replyDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  } catch {
    return iso;
  }
}

function escalationNote(event: Extract<ChatEvent, { type: "escalated" }>): string {
  const about = TOPIC_WORDS[event.topic] ?? "your question";
  return event.to
    ? `Sent to the healdesk team, about ${about}. A person will reply to ${event.to} by ${replyDay(event.replyByOn)}.`
    : `Sent to the healdesk team, about ${about}. Please also email hello@healdesk.io so we can reply.`;
}

function loadMessages(key: string): ChatMessage[] {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ChatMessage[]).filter((m) => !m.pending) : [];
  } catch {
    return [];
  }
}

function saveMessages(key: string, messages: ChatMessage[]): void {
  try {
    if (messages.length === 0) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(messages));
  } catch {
    // Storage may be off; the conversation then lasts as long as the page.
  }
}

/** Only links to this page's own origin become buttons. */
function sameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function SupportChat(props: {
  audience: "patients" | "clients";
  /** The fixed line for when the chat can't be reached, with the phone and email. */
  failureLine: string;
  /** Open from the start: for a page that sends someone straight to the chat. */
  defaultOpen?: boolean;
}) {
  const params = useParams<{ slug?: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : null;
  const storageKey = slug ? `${STORAGE_PREFIX}${slug}` : null;
  const one = props.audience === "clients" ? "client" : "patient";

  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Nothing is saved until this tab's conversation has been read back, or the
  // first save (of the empty list) would erase it.
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const ids = {
    panel: useId(),
    heading: useId(),
    rule: useId(),
    input: useId(),
  };

  useEffect(() => {
    if (!storageKey) return;
    setMessages(loadMessages(storageKey));
    setLoaded(true);
  }, [storageKey]);

  useEffect(() => {
    if (storageKey && loaded && !busy) saveMessages(storageKey, messages);
  }, [storageKey, loaded, messages, busy]);

  // Focus moves into the panel when it opens, and back to the button that
  // opened it when it closes, once that button is on screen again.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else if (wasOpen.current) openerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages]);

  const show = useCallback((opener: HTMLElement | null) => {
    openerRef.current = opener;
    setOpen(true);
  }, []);

  const hide = useCallback(() => setOpen(false), []);

  const update = (id: string, change: (m: ChatMessage) => ChatMessage) =>
    setMessages((all) => all.map((m) => (m.id === id ? change(m) : m)));

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim().slice(0, MAX_CHARS);
    if (!text || busy || !slug) return;
    const history = messages
      .filter((m) => !m.fixed && !m.pending && m.text.trim())
      .map((m) => ({ role: m.role, text: m.text }));
    const userId = newId();
    const replyId = newId();
    setMessages((all) => [
      ...all,
      { id: userId, role: "user", text },
      { id: replyId, role: "assistant", text: "", pending: true },
    ]);
    setDraft("");
    setBusy(true);
    setAnnouncement("");

    let reply = "";
    let note = "";
    const fail = (line: string) => {
      reply = line;
      update(replyId, (m) => ({ ...m, text: line, links: [], fixed: true }));
    };
    try {
      const response = await fetch(`/c/${encodeURIComponent(slug)}/help/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history, text }),
        credentials: "same-origin",
      });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !response.body || !type.includes("application/x-ndjson")) {
        fail(
          response.redirected
            ? "Your sign-in has ended. Sign in again, then ask again."
            : props.failureLine,
        );
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        const handle = (line: string) => {
          if (!line.trim()) return;
          let parsed: ChatEvent;
          try {
            parsed = JSON.parse(line) as ChatEvent;
          } catch {
            return;
          }
          switch (parsed.type) {
            case "screened":
              update(userId, (m) => ({ ...m, text: parsed.text, notices: parsed.notices }));
              break;
            case "delta":
              reply += parsed.text;
              update(replyId, (m) => ({ ...m, text: m.text + parsed.text }));
              break;
            case "link":
              if (sameOrigin(parsed.url)) {
                const link = { label: parsed.label, url: parsed.url };
                update(replyId, (m) => ({ ...m, links: [...(m.links ?? []), link] }));
              }
              break;
            case "escalated":
              note = escalationNote(parsed);
              update(replyId, (m) => ({ ...m, note }));
              break;
            case "replace":
              fail(parsed.text);
              break;
            case "done":
              break;
          }
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          let newline = buffered.indexOf("\n");
          while (newline >= 0) {
            handle(buffered.slice(0, newline));
            buffered = buffered.slice(newline + 1);
            newline = buffered.indexOf("\n");
          }
        }
        handle(buffered + decoder.decode());
      }
    } catch {
      fail(props.failureLine);
    }
    if (!reply.trim() && !note) fail(props.failureLine);
    update(replyId, (m) => ({ ...m, pending: false }));
    setBusy(false);
    // Announced once, whole, after the stream has finished.
    setAnnouncement([reply.trim(), note].filter(Boolean).join(" "));
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  function startOver() {
    setMessages([]);
    setAnnouncement("");
    if (storageKey) saveMessages(storageKey, []);
    inputRef.current?.focus();
  }

  if (!slug) return null;

  return (
    <>
      <div className="mt-3">
        <button
          type="button"
          onClick={(e) => show(e.currentTarget)}
          aria-expanded={open}
          aria-controls={ids.panel}
          className="border-line min-h-11 rounded-full border px-4 text-sm font-semibold"
        >
          Ask the support chat
        </button>
      </div>

      {/* Kept mounted while the panel is open, so focus can come back to it. */}
      <button
        type="button"
        onClick={(e) => show(e.currentTarget)}
        aria-expanded={open}
        aria-controls={ids.panel}
        className={`bg-ink fixed bottom-4 right-4 z-10 min-h-12 rounded-full px-5 text-sm font-bold text-white shadow-lg ${open ? "hidden" : ""}`}
      >
        Help
      </button>

      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {open ? (
        <section
          id={ids.panel}
          aria-labelledby={ids.heading}
          onKeyDown={(e) => {
            if (e.key === "Escape") hide();
          }}
          className="border-line fixed inset-x-0 bottom-0 z-30 flex max-h-[85vh] flex-col rounded-t-2xl border bg-white shadow-xl sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[26rem] sm:rounded-2xl"
        >
          <header className="border-line flex items-center justify-between gap-2 border-b px-4 py-2">
            <h2 id={ids.heading} className="font-semibold">
              Support chat
            </h2>
            <div className="flex items-center gap-1">
              {messages.length > 0 ? (
                <button
                  type="button"
                  onClick={startOver}
                  disabled={busy}
                  className="min-h-11 rounded-full px-3 text-sm font-semibold underline disabled:opacity-50"
                >
                  Start over
                </button>
              ) : null}
              <button
                type="button"
                onClick={hide}
                className="min-h-11 rounded-full px-3 text-sm font-semibold"
              >
                Close
              </button>
            </div>
          </header>

          <ol
            ref={listRef}
            aria-label="Conversation"
            className="flex min-h-40 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 text-sm"
          >
            {messages.length === 0 ? (
              <li className="text-muted">
                Ask how to do something in healdesk, or why something isn&rsquo;t working. It
                answers from this account&rsquo;s setup, and can pass you to a person. Please
                don&rsquo;t paste {one} information here.
              </li>
            ) : null}
            {messages.map((m) => (
              <li key={m.id} className={m.role === "user" ? "self-end text-right" : "self-start"}>
                <p className="sr-only">{m.role === "user" ? "You:" : "Support:"}</p>
                <p
                  className={`inline-block max-w-[22rem] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-left ${
                    m.role === "user" ? "bg-paper-2" : "border-line border bg-white"
                  }`}
                >
                  {m.pending && !m.text ? "…" : m.text}
                </p>
                {m.notices?.map((notice) => (
                  <p key={notice} className="text-muted mt-1 text-xs">
                    {notice}
                  </p>
                ))}
                {m.links && m.links.length > 0 ? (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {m.links.map((link) => (
                      <li key={link.url}>
                        <a
                          href={link.url}
                          className="border-line inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold"
                        >
                          {link.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {m.note ? <p className="mt-2 text-sm font-semibold">{m.note}</p> : null}
              </li>
            ))}
          </ol>

          <form onSubmit={send} className="border-line border-t px-4 py-3">
            <p id={ids.rule} className="text-muted mb-2 text-xs font-semibold">
              This is product support. Please don&rsquo;t paste {one} information.
            </p>
            <label htmlFor={ids.input} className="sr-only">
              Your question
            </label>
            <div className="flex items-end gap-2">
              <textarea
                id={ids.input}
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                aria-describedby={ids.rule}
                maxLength={MAX_CHARS}
                rows={2}
                className="border-line min-h-11 flex-1 resize-none rounded-xl border px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={busy || !draft.trim()}
                className="bg-ink min-h-11 rounded-full px-4 text-sm font-bold text-white disabled:opacity-50"
              >
                {busy ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </>
  );
}
