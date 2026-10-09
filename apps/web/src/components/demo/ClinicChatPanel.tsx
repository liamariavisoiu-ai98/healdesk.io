"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The personalised demo's chat: one conversation, dressed four ways.
 *
 * The boxes above it (Website, WhatsApp, Instagram, Messenger) only change
 * how the same thread looks, so a prospect sees at a glance that one
 * assistant answers every place a patient writes. It is make-up, on the
 * owner's instruction of 7 October 2026: nothing is sent to Meta, the
 * conversation carries on unchanged when the box changes, and the assistant
 * behaves the same whichever is selected (api/demo/[slug]/chat is never told
 * which one is showing).
 *
 * The greeting is not sent to the model: it is the first assistant line on
 * screen, and the route strips leading assistant turns before the call. The
 * thread lives only in this component; nothing is stored on our side.
 */

type Skin = "website" | "whatsapp" | "instagram" | "messenger";
type Message = { role: "user" | "assistant"; content: string; at: string };

function now(): string {
  return new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// ─── Icons, drawn simply: the point is recognition, not a copy of a logo ───

const Icon = {
  globe: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  ),
  whatsapp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 20.5l1.3-4.4A8.7 8.7 0 1 1 8 19.3l-4.5 1.2Z" />
      <path d="M9 8.5c.3 2.6 2.4 5.2 5.4 6l1.3-1.3-1.8-1-.8.7c-1-.4-2.1-1.5-2.5-2.5l.7-.8-1-1.8L9 8.5Z" fill="currentColor" stroke="none" />
    </svg>
  ),
  instagram: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  messenger: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2.5C6.5 2.5 2.5 6.5 2.5 11.6c0 2.8 1.2 5.2 3.2 6.9v3.5l3.1-1.7c1 .3 2.1.4 3.2.4 5.5 0 9.5-4 9.5-9.1S17.5 2.5 12 2.5Zm1 12.1-2.4-2.6-4.7 2.6 5.2-5.5 2.5 2.6 4.6-2.6-5.2 5.5Z" />
    </svg>
  ),
  back: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 5-7 7 7 7" />
    </svg>
  ),
  phone: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2Z" />
    </svg>
  ),
  video: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="6" width="13" height="12" rx="2.5" />
      <path d="m15.5 10.5 6-3.5v10l-6-3.5" />
    </svg>
  ),
  camera: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  ),
  mic: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 7v10M7 12h10" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3.4 20.6 21 12 3.4 3.4 3.4 10l12.6 2-12.6 2z" />
    </svg>
  ),
  ticks: (
    <svg viewBox="0 0 18 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m1 6 3 3L10 2M7 8.5l.5.5L14 2" />
    </svg>
  ),
};

const BOXES: { id: Skin; label: string; badge: string; ink: string; icon: React.ReactNode }[] = [
  { id: "website", label: "Website", badge: "var(--clinic)", ink: "var(--clinic-ink)", icon: Icon.globe },
  { id: "whatsapp", label: "WhatsApp", badge: "#25d366", ink: "#fff", icon: Icon.whatsapp },
  {
    id: "instagram",
    label: "Instagram",
    badge: "linear-gradient(45deg,#feda75,#fa7e1e 30%,#d62976 60%,#962fbf 85%,#4f5bd5)",
    ink: "#fff",
    icon: Icon.instagram,
  },
  { id: "messenger", label: "Messenger", badge: "linear-gradient(45deg,#0099ff,#a033ff 60%,#ff5280)", ink: "#fff", icon: Icon.messenger },
];

function Avatar({ clinicName, logoUrl, size, ring }: { clinicName: string; logoUrl: string | null; size: number; ring?: boolean }) {
  const inner = (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-full bg-white text-[12px] font-bold"
      style={{ width: size, height: size, boxShadow: "0 0 0 1px rgb(0 0 0 / 0.06)" }}
      aria-hidden
    >
      {logoUrl ? (
        <img src={logoUrl} alt="" referrerPolicy="no-referrer" className="size-full object-contain p-[2px]" />
      ) : (
        <span className="grid size-full place-items-center" style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}>
          {clinicName.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
  // Instagram's story ring.
  return ring ? (
    <span className="shrink-0 rounded-full p-[2px]" style={{ background: "linear-gradient(45deg,#feda75,#fa7e1e,#d62976,#962fbf,#4f5bd5)" }}>
      <span className="block rounded-full bg-white p-[2px]">{inner}</span>
    </span>
  ) : (
    inner
  );
}

/** The handle a clinic's Instagram would most likely have, for the header. */
function handleOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "clinic";
}

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
  const [skin, setSkin] = useState<Skin>("website");
  const [messages, setMessages] = useState<Message[]>(() => [{ role: "assistant", content: greeting, at: now() }]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, skin]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || streaming || locked) return;
      setError(null);
      setInput("");
      const next: Message[] = [...messages, { role: "user", content, at: now() }];
      setMessages([...next, { role: "assistant", content: "", at: now() }]);
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

  const onlyGreeting = messages.length === 1;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(input);
  };
  const inputProps = {
    value: input,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setInput(e.target.value),
    maxLength: 1000,
    disabled: locked,
    "aria-label": `Message ${clinicName}`,
  };

  // ─── The four costumes ─────────────────────────────────────────────────────

  const header = {
    website: (
      <div className="flex items-center gap-2.5 px-4 py-3" style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}>
        <Avatar clinicName={clinicName} logoUrl={logoUrl} size={34} />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold leading-tight">{clinicName}</p>
          <p className="truncate text-[12.6px] leading-tight opacity-80">We typically reply instantly</p>
        </div>
      </div>
    ),
    whatsapp: (
      <div className="flex items-center gap-2 px-2.5 py-2.5 text-white" style={{ background: "#008069" }}>
        <span className="[&_svg]:size-5">{Icon.back}</span>
        <Avatar clinicName={clinicName} logoUrl={logoUrl} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15.5px] font-medium leading-tight">{clinicName}</p>
          <p className="truncate text-[12.5px] leading-tight opacity-85">{streaming ? "typing…" : "online"}</p>
        </div>
        <span className="flex gap-5 pr-1.5 [&_svg]:size-[21px]">
          {Icon.video}
          {Icon.phone}
        </span>
      </div>
    ),
    instagram: (
      <div className="flex items-center gap-2.5 border-b border-[#dbdbdb] bg-white px-3 py-2.5 text-black">
        <span className="[&_svg]:size-6">{Icon.back}</span>
        <Avatar clinicName={clinicName} logoUrl={logoUrl} size={30} ring />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold leading-tight">{clinicName}</p>
          <p className="truncate text-[12.5px] leading-tight text-[#737373]">{handleOf(clinicName)}</p>
        </div>
        <span className="flex gap-5 pr-1 [&_svg]:size-[23px]">
          {Icon.phone}
          {Icon.video}
        </span>
      </div>
    ),
    messenger: (
      <div className="flex items-center gap-2.5 bg-white px-3 py-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.08)]" style={{ color: "#0a7cff" }}>
        <span className="[&_svg]:size-6">{Icon.back}</span>
        <span className="relative">
          <Avatar clinicName={clinicName} logoUrl={logoUrl} size={36} />
          <span className="absolute right-0 bottom-0 size-3 rounded-full border-2 border-white bg-[#31a24c]" />
        </span>
        <div className="min-w-0 flex-1 text-[#050505]">
          <p className="truncate text-[15.5px] font-semibold leading-tight">{clinicName}</p>
          <p className="truncate text-[12.5px] leading-tight text-[#65676b]">Active now</p>
        </div>
        <span className="flex gap-5 pr-1 [&_svg]:size-[22px]">
          {Icon.phone}
          {Icon.video}
        </span>
      </div>
    ),
  }[skin];

  const surface: React.CSSProperties =
    skin === "whatsapp"
      ? {
          backgroundColor: "#efeae2",
          backgroundImage:
            "radial-gradient(rgb(0 0 0 / 0.045) 1px, transparent 1.2px), radial-gradient(rgb(0 0 0 / 0.03) 1px, transparent 1.2px)",
          backgroundSize: "22px 22px, 22px 22px",
          backgroundPosition: "0 0, 11px 11px",
        }
      : { background: "#ffffff" };

  function bubble(message: Message, i: number) {
    const mine = message.role === "user";
    const body = message.content || <span className="opacity-50">…</span>;
    const prev = messages[i - 1];
    const firstOfRun = !prev || prev.role !== message.role;

    if (skin === "whatsapp") {
      return (
        <div key={i} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
          <div
            className={`relative max-w-[82%] px-2.5 pt-1.5 pb-[18px] text-[14.6px] leading-[1.38] text-[#111b21] shadow-[0_1px_0.5px_rgb(11_20_26/0.13)] ${
              firstOfRun ? (mine ? "rounded-[7.5px] rounded-tr-none" : "rounded-[7.5px] rounded-tl-none") : "rounded-[7.5px]"
            }`}
            style={{ background: mine ? "#d9fdd3" : "#ffffff" }}
          >
            <span className="whitespace-pre-wrap">{body}</span>
            <span className="absolute right-2 bottom-1 flex items-center gap-0.5 text-[11px] text-[#667781]">
              {message.at}
              {mine ? <span className="text-[#53bdeb] [&_svg]:h-[11px] [&_svg]:w-[16px]">{Icon.ticks}</span> : null}
            </span>
          </div>
        </div>
      );
    }

    if (skin === "instagram") {
      return (
        <div key={i} className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"}`}>
          {!mine ? <span className="w-7">{firstOfRun ? <Avatar clinicName={clinicName} logoUrl={logoUrl} size={28} /> : null}</span> : null}
          <p
            className="max-w-[75%] rounded-[22px] px-3.5 py-2 text-[15px] leading-[1.38] whitespace-pre-wrap"
            style={mine ? { background: "linear-gradient(180deg,#a033ff,#6e3dff)", color: "#fff" } : { background: "#efefef", color: "#000" }}
          >
            {body}
          </p>
        </div>
      );
    }

    if (skin === "messenger") {
      return (
        <div key={i} className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"}`}>
          {!mine ? <span className="w-7">{firstOfRun ? <Avatar clinicName={clinicName} logoUrl={logoUrl} size={28} /> : null}</span> : null}
          <p
            className="max-w-[75%] rounded-[18px] px-3 py-2 text-[15px] leading-[1.34] whitespace-pre-wrap"
            style={mine ? { background: "#0a7cff", color: "#fff" } : { background: "#f0f0f0", color: "#050505" }}
          >
            {body}
          </p>
        </div>
      );
    }

    return (
      <div key={i} className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"}`}>
        {!mine ? <Avatar clinicName={clinicName} logoUrl={logoUrl} size={26} /> : null}
        <p
          className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-[15.2px] leading-[1.45] whitespace-pre-wrap ${mine ? "rounded-br-md" : "text-ink rounded-bl-md bg-[#f1f1f1]"}`}
          style={mine ? { background: "var(--clinic)", color: "var(--clinic-ink)" } : undefined}
        >
          {body}
        </p>
      </div>
    );
  }

  const composer = {
    website: (
      <form onSubmit={submit} className="flex items-center gap-2 border-t border-black/5 bg-white p-3">
        <input
          {...inputProps}
          placeholder={locked ? "This demo has been archived" : `Message ${clinicName}…`}
          className="border-line text-ink placeholder:text-muted min-w-0 flex-1 rounded-full border bg-white px-4 py-2.5 text-[16px] outline-none focus:border-[var(--clinic)]"
        />
        <button
          type="submit"
          disabled={locked || streaming || !input.trim()}
          className="shrink-0 rounded-full px-5 py-2.5 text-[15.2px] font-bold transition-opacity disabled:opacity-45"
          style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
        >
          Send
        </button>
      </form>
    ),
    whatsapp: (
      <form onSubmit={submit} className="flex items-center gap-2 px-2 py-2" style={{ background: "#f0f2f5" }}>
        <input
          {...inputProps}
          placeholder={locked ? "This demo has been archived" : "Message"}
          className="min-w-0 flex-1 rounded-full bg-white px-4 py-2.5 text-[15.5px] text-[#111b21] outline-none placeholder:text-[#667781]"
        />
        <button
          type="submit"
          disabled={locked || streaming}
          aria-label="Send"
          className="grid size-11 shrink-0 place-items-center rounded-full text-white disabled:opacity-60 [&_svg]:size-[20px]"
          style={{ background: "#00a884" }}
        >
          {input.trim() ? Icon.send : Icon.mic}
        </button>
      </form>
    ),
    instagram: (
      <form onSubmit={submit} className="bg-white px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-full bg-[#efefef] py-1.5 pr-3 pl-1.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full text-white [&_svg]:size-[18px]" style={{ background: "#3797f0" }}>
            {Icon.camera}
          </span>
          <input
            {...inputProps}
            placeholder={locked ? "This demo has been archived" : "Message..."}
            className="min-w-0 flex-1 bg-transparent py-1 text-[15px] text-black outline-none placeholder:text-[#737373]"
          />
          {input.trim() ? (
            <button type="submit" disabled={locked || streaming} className="text-[15px] font-semibold text-[#3797f0] disabled:opacity-50">
              Send
            </button>
          ) : (
            <span className="text-black [&_svg]:size-[22px]">{Icon.mic}</span>
          )}
        </div>
      </form>
    ),
    messenger: (
      <form onSubmit={submit} className="flex items-center gap-2.5 bg-white px-3 py-2.5" style={{ color: "#0a7cff" }}>
        <span className="[&_svg]:size-[22px]">{Icon.plus}</span>
        <span className="[&_svg]:size-[22px]">{Icon.camera}</span>
        <input
          {...inputProps}
          placeholder={locked ? "This demo has been archived" : "Aa"}
          className="min-w-0 flex-1 rounded-full bg-[#f0f2f5] px-4 py-2 text-[15px] text-[#050505] outline-none placeholder:text-[#65676b]"
        />
        <button type="submit" disabled={locked || streaming || !input.trim()} aria-label="Send" className="disabled:opacity-40 [&_svg]:size-[22px]">
          {Icon.send}
        </button>
      </form>
    ),
  }[skin];

  return (
    <div className="flex min-h-[540px] flex-1 flex-col">
      {/* The boxes: where the same assistant answers. They change the look, never the conversation. */}
      <div className="border-line grid grid-cols-4 gap-1 border-b p-2" role="tablist" aria-label="Where patients can message you">
        {BOXES.map((box) => {
          const active = box.id === skin;
          return (
            <button
              key={box.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSkin(box.id)}
              className={`flex flex-col items-center gap-1 rounded-xl px-1 py-2 transition-colors ${active ? "bg-paper-2 ring-line-strong ring-1" : "hover:bg-paper-2/60"}`}
            >
              <span className="grid size-8 place-items-center rounded-[10px] [&_svg]:size-[18px]" style={{ background: box.badge, color: box.ink }}>
                {box.icon}
              </span>
              <span className={`text-[12.6px] font-bold ${active ? "text-ink" : "text-muted"}`}>{box.label}</span>
            </button>
          );
        })}
      </div>

      {header}

      <div ref={scrollRef} className={`flex-1 overflow-y-auto px-3 py-4 ${skin === "whatsapp" ? "space-y-1.5" : "space-y-2"}`} style={surface} aria-live="polite">
        {skin === "whatsapp" ? (
          <p className="mx-auto mb-2 w-fit rounded-md bg-[#ffeecd] px-3 py-1.5 text-center text-[12px] text-[#54656f] shadow-[0_1px_0.5px_rgb(11_20_26/0.13)]">
            Messages are answered by {clinicName}&rsquo;s AI assistant.
          </p>
        ) : null}
        {messages.map(bubble)}
        {onlyGreeting && !locked ? (
          <div className="flex flex-wrap gap-2 pt-2 pl-9">
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => send(chip)}
                className="border-line hover:border-line-strong text-ink rounded-full border bg-white px-3 py-1.5 text-left text-[13.8px] font-semibold transition-colors"
              >
                {chip}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="text-red-deep bg-white px-4 py-2 text-[14.4px] font-semibold" role="alert">
          {error}
        </p>
      ) : null}

      {composer}
    </div>
  );
}
