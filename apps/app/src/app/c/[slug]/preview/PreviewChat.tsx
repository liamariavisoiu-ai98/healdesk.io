"use client";

import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import type { BookingCapture } from "@/lib/assistant/turn";
import type { PreviewAvailability, PreviewLine } from "@/lib/preview/talk";

import { talkToAyaAction } from "./actions";

/**
 * The preview's conversation (lib/preview/talk.ts). It lives in this
 * component's state and nowhere else: not in the browser's storage, not on
 * the server. Each message sends what is on screen back with it, and closing
 * or reloading the page ends the conversation.
 *
 * Under AYA's reply, a line only the practice sees when the preview did
 * something a patient's conversation would do differently: the urgent reply
 * raised no alert, the calendar's free times (nothing held), or the chat
 * ended. A cap or a closed preview shows its fixed line instead of a reply.
 */

type Line = PreviewLine & { notes?: string[] };

const EMPTY: BookingCapture = {
  wants: false,
  firstName: null,
  phone: null,
  window: null,
  altWindows: [],
  service: null,
  fields: {},
};

function availabilityNote(a: PreviewAvailability): string {
  switch (a.status) {
    case "times":
      return a.times.length > 0
        ? `Your calendar has these times free${a.service ? ` for ${a.service}` : ""}: ${a.times.join("; ")}. Nothing is held.`
        : `Your calendar has no free times${a.service ? ` for ${a.service}` : ""} in the next few weeks.`;
    case "requests":
      return "Bookings arrive as requests your team confirms, so there are no times to show here.";
    case "no_calendar":
      return "Bookings arrive as requests your team confirms.";
    case "unavailable":
      return "Your calendar didn't answer just now, so there are no times to show.";
  }
}

export function PreviewChat(props: { slug: string; opening: string; homeHref: string }) {
  const inputId = useId();
  const [lines, setLines] = useState<Line[]>([]);
  const [capture, setCapture] = useState<BookingCapture>(EMPTY);
  const [text, setText] = useState("");
  const [working, setWorking] = useState(false);
  const [stopped, setStopped] = useState<{ line: string; home?: boolean } | null>(null);
  const [ended, setEnded] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  function startAgain() {
    setLines([]);
    setCapture(EMPTY);
    setStopped(null);
    setEnded(false);
    setText("");
    field.current?.focus();
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const said = text.trim();
    if (!said || working) return;
    setWorking(true);
    setStopped(null);
    try {
      const history = lines.map(({ speaker, text: t }) => ({ speaker, text: t }));
      const result = await talkToAyaAction(props.slug, { history, text: said, capture });
      switch (result.mode) {
        case "reply": {
          const notes: string[] = [];
          if (result.urgent) {
            notes.push(
              "This is the fixed reply for someone who needs urgent help. In the preview, no alert is sent.",
            );
          }
          if (result.availability) notes.push(availabilityNote(result.availability));
          if (result.ended) notes.push("AYA ended the chat here.");
          setLines([
            ...lines,
            { speaker: "person", text: said },
            { speaker: "assistant", text: result.reply, notes },
          ]);
          setCapture(result.capture);
          setEnded(result.ended);
          setText("");
          break;
        }
        case "limited":
          setStopped({ line: result.line });
          break;
        case "locked":
          setStopped({
            line: "The preview has closed until every stage of the build is done again.",
            home: true,
          });
          break;
        case "closed":
          setStopped({ line: "This account has closed." });
          break;
        case "invalid":
          setStopped({
            line: "That message couldn't be sent. Start a new conversation and try again.",
          });
          break;
      }
    } catch {
      setStopped({ line: "Something went wrong on our side. Try again in a moment." });
    } finally {
      setWorking(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="border-line mt-6 rounded-2xl border bg-white px-4 py-4 sm:px-5">
      <ol aria-label="Conversation" aria-live="polite" className="grid gap-3">
        <li className="grid gap-1">
          <p className="text-muted text-xs font-semibold">AYA</p>
          <p className="bg-paper-2 rounded-2xl px-4 py-3">{props.opening}</p>
        </li>
        {lines.map((line, i) => (
          <li
            key={i}
            className={`grid gap-1 ${line.speaker === "person" ? "justify-items-end" : ""}`}
          >
            <p className="text-muted text-xs font-semibold">
              {line.speaker === "person" ? "You" : "AYA"}
            </p>
            <p
              className={`whitespace-pre-wrap rounded-2xl px-4 py-3 ${
                line.speaker === "person" ? "bg-ink text-white" : "bg-paper-2"
              }`}
            >
              {line.text}
            </p>
            {line.notes?.map((note) => (
              <p
                key={note}
                className="text-muted border-line rounded-xl border border-dashed px-3 py-2 text-sm"
              >
                {note}
              </p>
            ))}
          </li>
        ))}
      </ol>

      {stopped ? (
        <p
          role="status"
          className="border-line bg-tint-butter mt-4 rounded-xl border px-4 py-3 text-sm"
        >
          {stopped.line}
          {stopped.home ? (
            <>
              {" "}
              <a href={props.homeHref} className="font-semibold underline">
                See where the build is
              </a>
              .
            </>
          ) : null}
        </p>
      ) : null}

      <form onSubmit={send} className="mt-4 grid gap-2">
        <label htmlFor={inputId} className="text-sm font-semibold">
          Your message
        </label>
        <textarea
          id={inputId}
          ref={field}
          rows={2}
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={working || ended}
          className="border-line-strong min-h-11 rounded-xl border px-3 py-2"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={working || ended || text.trim().length === 0}
            className="bg-ink min-h-11 rounded-full px-6 text-sm font-bold text-white disabled:opacity-50"
          >
            {working ? "AYA is answering…" : "Send"}
          </button>
          <button
            type="button"
            onClick={startAgain}
            disabled={working || (lines.length === 0 && !stopped)}
            className="border-line min-h-11 rounded-full border px-5 text-sm font-semibold disabled:opacity-50"
          >
            Start again
          </button>
        </div>
      </form>
    </div>
  );
}
