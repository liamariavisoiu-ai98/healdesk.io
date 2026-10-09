"use client";

import type { ReactNode, RefObject } from "react";

/**
 * The chat card's thread and composer, drawn the same way wherever an
 * assistant chats: the personalised demo's website chat (as the clinic) and
 * the homepage's (as AYA), since the owner asked on 9 October 2026 for the
 * homepage's cards to look exactly like the demo page's (AgentPanel.tsx).
 *
 * Only the drawing is shared. Each card keeps its own conversation logic:
 * the homepage's asks for an email after the first message and can be
 * paused by its route, and the demo's can be archived.
 *
 * An assistant turn with nothing in it yet shows an ellipsis, so the visitor
 * sees an answer coming before the first words of it land.
 */

export type ChatMessage = { role: "user" | "assistant"; content: string };

export function ChatAvatar({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  return (
    <span
      className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-full text-[12px] font-bold"
      style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
      aria-hidden
    >
      {logoUrl ? (
        <img src={logoUrl} alt="" referrerPolicy="no-referrer" className="size-full bg-white object-contain p-0.5" />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

export function ChatThread({
  name,
  logoUrl,
  messages,
  chips,
  onChip,
  threadRef,
  error,
}: {
  name: string;
  logoUrl: string | null;
  /** The whole thread, greeting first. */
  messages: readonly ChatMessage[];
  /** Offered under the greeting; pass none once the conversation has started. */
  chips: readonly string[];
  onChip: (chip: string) => void;
  threadRef?: RefObject<HTMLDivElement | null>;
  error?: string | null;
}) {
  return (
    <>
      <div ref={threadRef} className="scroll-subtle flex-1 space-y-3 overflow-y-auto px-4 py-5" aria-live="polite">
        {messages.map((message, i) =>
          message.role === "assistant" ? (
            <div key={i} className="flex items-end gap-2">
              <ChatAvatar name={name} logoUrl={logoUrl} />
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
        {chips.length > 0 ? (
          <div className="flex flex-wrap gap-2 pt-1 pl-9">
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => onChip(chip)}
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
    </>
  );
}

export function ChatComposer({
  name,
  value,
  onChange,
  onSubmit,
  disabled = false,
  sending = false,
  placeholder,
  inputRef,
  children,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** The whole composer is off: an archived demo, a paused route. */
  disabled?: boolean;
  /** An answer is on its way, so Send waits. */
  sending?: boolean;
  placeholder?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Under the field, e.g. a note on what happens to what is typed. */
  children?: ReactNode;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="border-line border-t p-3"
    >
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder ?? `Message ${name}…`}
          aria-label={`Message ${name}`}
          maxLength={1000}
          disabled={disabled}
          className="border-line text-ink placeholder:text-muted min-w-0 flex-1 rounded-full border px-4 py-2.5 text-[16px] outline-none transition-colors focus:border-[var(--clinic)]"
        />
        <button
          type="submit"
          disabled={disabled || sending || !value.trim()}
          className="shrink-0 rounded-full px-5 py-2.5 text-[15.6px] font-bold transition-opacity disabled:opacity-45"
          style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
        >
          Send
        </button>
      </div>
      {children}
    </form>
  );
}
