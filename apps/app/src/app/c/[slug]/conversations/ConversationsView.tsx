"use client";

import { useState, type FormEvent } from "react";

import {
  CHANNEL_NAMES,
  OUTCOME_NAMES,
  OUTCOME_STYLES,
  phoneText,
  type ConversationOutcome,
  type DayChip,
} from "@/lib/portal/conversation-words";
import { bookingRequestPath } from "@/lib/portal/booking-paths";
import type { ConversationListItem } from "@/lib/portal/conversations";
import { portalMoment } from "@/lib/portal/format";

import { useAnnounce } from "../feedback";

import { confirmExportAction, exportAllAction, findConversationsAction } from "./actions";
import { digestOf, downloadJson } from "./download";

/**
 * The Conversations list (plan Part F4): a search by name or phone digits,
 * the Today / Yesterday / This week chips, and the rows. The first rows come
 * with the page; a search or a chip asks the server again
 * (findConversationsAction), behind the step-up and logged, and never puts
 * what was typed in the address bar.
 *
 * One column, every target at least 44px tall, and the count announced in a
 * polite region when the rows change (Part F8).
 */

const CHIPS: { day: DayChip; label: string }[] = [
  { day: "today", label: "Today" },
  { day: "yesterday", label: "Yesterday" },
  { day: "week", label: "This week" },
];

export function ConversationsView(props: {
  slug: string;
  timeZone: string;
  initialRows: ConversationListItem[];
  /**
   * Bookings, or null while it isn't in this build. A request opens there by
   * its `?request=` focus (bookingRequestPath), which shows it, or what became
   * of it, wherever it now sits; an id anchor would land nowhere for a
   * declined or older request, and the step-up's return drops it.
   */
  bookingsHref: string | null;
  limit: number;
}) {
  const [rows, setRows] = useState(props.initialRows);
  const [q, setQ] = useState("");
  const [day, setDay] = useState<DayChip | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [filtered, setFiltered] = useState(false);

  async function run(next: { q: string; day: DayChip | null }): Promise<void> {
    setWorking(true);
    setProblem(null);
    try {
      const found = await findConversationsAction(props.slug, next);
      if (found.ok) {
        setRows(found.rows);
        setFiltered(next.q.trim() !== "" || next.day !== null);
      } else {
        setProblem(found.message);
      }
    } catch {
      setProblem("That didn't reach us. Try again.");
    } finally {
      setWorking(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void run({ q, day });
  }

  function chip(next: DayChip): void {
    const chosen = day === next ? null : next;
    setDay(chosen);
    void run({ q, day: chosen });
  }

  function clear(): void {
    setQ("");
    setDay(null);
    void run({ q: "", day: null });
  }

  const now = new Date();
  return (
    <div>
      <form role="search" onSubmit={submit} className="mt-6">
        <label htmlFor="conversation-search" className="font-semibold">
          Find a conversation
        </label>
        <p id="conversation-search-hint" className="text-muted text-sm">
          By name, or by any part of the phone number.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            id="conversation-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={80}
            autoComplete="off"
            aria-describedby="conversation-search-hint"
            className="border-line min-h-11 flex-1 rounded-xl border bg-white px-3"
          />
          <button
            type="submit"
            disabled={working}
            className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
          >
            Search
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="When">
          {CHIPS.map((c) => (
            <button
              key={c.day}
              type="button"
              aria-pressed={day === c.day}
              disabled={working}
              onClick={() => chip(c.day)}
              className={`min-h-11 rounded-full border px-4 text-sm font-semibold disabled:opacity-50 ${
                day === c.day ? "border-ink bg-ink text-white" : "border-line bg-white"
              }`}
            >
              {c.label}
            </button>
          ))}
          {filtered || q || day ? (
            <button
              type="button"
              onClick={clear}
              disabled={working}
              className="text-muted min-h-11 px-3 text-sm font-semibold underline disabled:opacity-50"
            >
              Show all
            </button>
          ) : null}
        </div>
        {problem ? <p className="mt-2 text-sm text-red-800">{problem}</p> : null}
      </form>

      <p role="status" aria-live="polite" className="text-muted mt-6 text-sm">
        {rows.length === 0
          ? filtered
            ? "No conversations match."
            : "No conversations yet."
          : `${rows.length === 1 ? "1 conversation" : `${rows.length} conversations`}${
              rows.length >= props.limit ? `, the newest ${props.limit}` : ""
            }, newest first.`}
      </p>

      <ul className="mt-3 grid gap-2">
        {rows.map((row) => (
          <li key={row.id} className="border-line rounded-xl border bg-white px-4 py-3">
            <p className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">
                {CHANNEL_NAMES[row.channel]} ·{" "}
                <span className="font-normal">
                  {portalMoment(new Date(row.at), props.timeZone, now)}
                </span>
              </span>
              {row.outcome ? <OutcomeBadge outcome={row.outcome} /> : null}
            </p>
            <p className="mt-1">
              {row.callerName || row.callerPhone ? (
                [row.callerName, row.callerPhone ? phoneText(row.callerPhone) : null]
                  .filter(Boolean)
                  .join(" · ")
              ) : (
                <span className="text-muted">
                  {row.source === "meta_thread"
                    ? "Name and number not shared"
                    : "No name or number"}
                </span>
              )}
              {row.amended ? <span className="text-muted text-sm"> · Amended</span> : null}
            </p>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <a
                href={`/c/${props.slug}/conversations/${row.id}`}
                className="inline-flex min-h-11 items-center font-semibold underline"
              >
                Open
              </a>
              {row.bookingRequestId ? (
                props.bookingsHref ? (
                  <a
                    href={bookingRequestPath(props.slug, row.bookingRequestId)}
                    className="inline-flex min-h-11 items-center font-semibold underline"
                  >
                    See the booking request
                  </a>
                ) : (
                  <span className="text-muted inline-flex min-h-11 items-center">
                    Produced a booking request
                  </span>
                )
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OutcomeBadge({ outcome }: { outcome: ConversationOutcome }) {
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${OUTCOME_STYLES[outcome]}`}
    >
      {OUTCOME_NAMES[outcome]}
    </span>
  );
}

/**
 * "Download every record": the whole clinic's export, as a JSON file, behind
 * the step-up. After the account has closed the button says what a download
 * sets in motion before anyone presses it.
 */
export function ExportAll(props: { slug: string; closedNote: string | null; destroyed: boolean }) {
  const announce = useAnnounce();
  const [working, setWorking] = useState(false);

  async function download(): Promise<void> {
    setWorking(true);
    try {
      const result = await exportAllAction(props.slug);
      if (result.ok) {
        downloadJson(result.filename, result.body);
        if (result.receipt) {
          // After cancellation: only a file that arrived whole is a delivery.
          const confirmed = await confirmExportAction(
            props.slug,
            result.receipt,
            await digestOf(result.body),
          );
          announce({ text: confirmed.message, tone: confirmed.ok ? "ok" : "problem" });
        } else {
          announce({ text: result.message, tone: "ok" });
        }
      } else {
        announce({ text: result.message, tone: "problem" });
      }
    } catch {
      announce({ text: "The export didn't reach you. Try again.", tone: "problem" });
    } finally {
      setWorking(false);
    }
  }

  if (props.destroyed) {
    return (
      <p className="text-muted mt-3 text-sm">
        Your records have been deleted, so there is nothing left to export.
      </p>
    );
  }
  return (
    <div className="mt-3">
      <p className="text-muted text-sm" id="export-all-note">
        Every conversation, booking request and appointment healdesk holds for your practice, with
        any amendments and the log of who opened what, as one JSON file.
        {props.closedNote ? ` ${props.closedNote}` : ""}
      </p>
      <button
        type="button"
        onClick={() => void download()}
        disabled={working}
        aria-describedby="export-all-note"
        className="border-ink mt-3 min-h-11 rounded-full border bg-white px-5 text-sm font-bold disabled:opacity-50"
      >
        {working ? "Preparing the export…" : "Download every record"}
      </button>
    </div>
  );
}
