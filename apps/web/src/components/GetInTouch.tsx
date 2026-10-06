"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { track } from "@/lib/analytics";
import { site } from "@/lib/site";

/**
 * "Get in touch": the navbar's way to book a call with us, in Calendly's
 * scheduler opened over the page. The copy here names no length: the event's
 * own page says how long the call is (it was 15 minutes on 6 October 2026,
 * whatever its link says), and it stays right when that changes.
 *
 * ## Calendly's page, framed, without Calendly's script
 *
 * Calendly's widget.js does two things for an inline embed: it builds an
 * iframe on the scheduling page with `embed_domain` and `embed_type=Inline`
 * added to its URL, which is what makes the page report a booking back to
 * the site, and it listens for those reports. This does both itself, so the
 * site loads no third-party script for it and the security policy only has to
 * let calendly.com be framed (security-headers.ts). Nothing of Calendly's
 * loads until a visitor opens the modal; the frame is mounted on the first
 * open and kept, so closing and reopening halfway through a booking finds it
 * where it was left.
 *
 * ## The same dialog as the purchase flow
 *
 * A native <dialog> with the `hd-modal` styles, for the reasons BuyModal.tsx
 * gives: showModal() brings the focus trap, the top layer and the inert page,
 * and this adds what it does not, the scroll lock, the backdrop click and
 * focus going back to the button. Escape closes it; nothing is lost, because
 * the frame stays mounted.
 *
 * The trigger is a link to the scheduling page itself, so a browser that has
 * not run this script yet still books the call, in a new page.
 */
export function GetInTouch({ className = "" }: { className?: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  /** Where focus returns on close. showModal does not restore it. */
  const openerRef = useRef<HTMLElement | null>(null);

  /** Built on the first open: it needs this page's host, which only the browser knows. */
  const [src, setSrc] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const open = useCallback(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSrc((current) => current ?? embedUrl());
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    setIsOpen(true);
    track("meeting_opened");
  }, []);

  const close = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  // Escape and close() both bypass React, so the element tells us.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onClose = () => setIsOpen(false);
    dialog.addEventListener("close", onClose);
    return () => dialog.removeEventListener("close", onClose);
  }, []);

  useEffect(() => {
    if (isOpen) {
      const previous = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = previous;
      };
    }
    openerRef.current?.focus();
    return undefined;
  }, [isOpen]);

  // A booking, as Calendly reports it to the page that framed it. Only the
  // fact is counted: the payload names the invitee and is never read.
  useEffect(() => {
    if (!src) return;
    const origin = new URL(site.meeting.url).origin;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const data: unknown = event.data;
      if (data && typeof data === "object" && "event" in data && data.event === "calendly.event_scheduled") {
        track("meeting_booked");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [src]);

  return (
    <>
      <a
        href={site.meeting.url}
        aria-haspopup="dialog"
        onClick={(event) => {
          // A modified click (new tab, new window) keeps the plain link.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          open();
        }}
        className={`border-line-strong text-ink hover:border-ink items-center justify-center gap-2 rounded-[6px] border-[1.5px] bg-white px-5 py-2.5 text-sm font-semibold transition-colors duration-200 ${className}`}
      >
        {site.meeting.label}
      </a>

      <dialog
        ref={dialogRef}
        className="hd-modal hd-modal--meeting"
        aria-labelledby="meeting-title"
        onClick={(event) => {
          // A click on the backdrop reports the dialog itself as the target.
          if (event.target === dialogRef.current) close();
        }}
      >
        <div className="hd-meeting">
          <header className="border-line flex items-start gap-4 border-b px-5 py-4 sm:px-7 sm:py-5">
            <div className="min-w-0 flex-1">
              <h2 id="meeting-title" className="font-display text-ink text-2xl leading-tight font-normal">
                {site.meeting.label}
              </h2>
              <p className="text-muted mt-1 text-sm">
                Pick a time for a call with us.{" "}
                <a
                  href={site.meeting.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink underline underline-offset-2"
                >
                  Open the calendar in a new tab
                </a>
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="text-muted hover:text-ink -mr-1 grid size-7 shrink-0 place-items-center rounded-full text-lg leading-none transition-colors"
            >
              <span aria-hidden>×</span>
            </button>
          </header>

          <div className="hd-meeting-frame">
            {src ? (
              <iframe
                src={src}
                title="Book a call with healdesk, on Calendly"
                onLoad={() => setLoaded(true)}
              />
            ) : null}
            {loaded ? null : (
              <p className="text-muted absolute inset-0 grid place-items-center text-sm font-semibold" role="status">
                Loading the calendar…
              </p>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}

/** The scheduling page, marked as an inline embed on this site, as widget.js marks it. */
function embedUrl(): string {
  const url = new URL(site.meeting.url);
  url.searchParams.set("embed_domain", window.location.host);
  url.searchParams.set("embed_type", "Inline");
  return url.toString();
}
