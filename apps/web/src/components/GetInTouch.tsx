"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { track } from "@/lib/analytics";
import { site } from "@/lib/site";

/**
 * "Get in touch": the navbar's way to book a call with us, in Calendly's
 * scheduler opened over the page. The copy here names no length: the event's
 * own page says how long the call is (15 minutes on 6 October 2026), and it
 * stays right when that changes.
 *
 * ## On a phone it is an icon
 *
 * Below 480px the button is a calendar in the same outlined square, named
 * "Get in touch" for assistive technology. A phone's navbar holds the
 * wordmark and "Get AYA" with about 50px to spare; the worded button needs
 * 135px, and making it fit meant shrinking the logo and both buttons below
 * their sizes everywhere else. From 480px it carries its words. Either way it
 * is exactly as tall as "Get AYA", which its border used to make it 2px
 * taller than.
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
  const titleRef = useRef<HTMLHeadingElement>(null);
  /** Where focus returns on close. showModal does not restore it. */
  const openerRef = useRef<HTMLElement | null>(null);

  /** Built on the first open: it needs this page's host, which only the browser knows. */
  const [src, setSrc] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  /** The frame's load event: Calendly's page has arrived, not yet drawn. */
  const [loaded, setLoaded] = useState(false);
  /** Calendly's page is on screen, so the loading panel can go. */
  const [drawn, setDrawn] = useState(false);

  const open = useCallback(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSrc((current) => current ?? embedUrl());
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    // showModal focuses the first link in the dialog, "Open the calendar in a
    // new tab", and Safari rings it in orange even when the button was tapped.
    // The title takes focus instead: a screen reader starts from the dialog's
    // name, and Tab still reaches the link next.
    titleRef.current?.focus();
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

  // What Calendly reports to the page that framed it. Its page fires the
  // frame's load event two or three seconds before it has drawn anything, so
  // "event_type_viewed", sent as the calendar appears, is what lifts the
  // loading panel over the frame; until then the frame is a blank white
  // sheet. A booking is counted as a fact only: the payload names the invitee
  // and is never read.
  useEffect(() => {
    if (!src) return;
    const origin = new URL(site.meeting.url).origin;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const data: unknown = event.data;
      if (!data || typeof data !== "object" || !("event" in data)) return;
      if (data.event === "calendly.event_type_viewed") setDrawn(true);
      if (data.event === "calendly.event_scheduled") track("meeting_booked");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [src]);

  // Should Calendly stop sending that message, the panel still goes, a little
  // after the page has loaded.
  useEffect(() => {
    if (!loaded || drawn) return;
    const timer = window.setTimeout(() => setDrawn(true), 4000);
    return () => window.clearTimeout(timer);
  }, [loaded, drawn]);

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
        // Below 480px there is no room for the words beside the logo and
        // "Get AYA", so it was a calendar icon alone, which nobody could read
        // as "Get in touch" (owner, 12 October 2026). It now says so under
        // the icon, small; the full label takes over from 480px.
        className={`border-line-strong text-ink hover:border-ink inline-flex h-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-sm border-[1.5px] bg-white px-2 text-sm font-semibold whitespace-nowrap transition-colors duration-fast min-[480px]:flex-row min-[480px]:gap-2 min-[480px]:px-5 ${className}`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="size-[17px] min-[480px]:hidden"
        >
          <path d="M8 2v4" />
          <path d="M16 2v4" />
          <rect width="18" height="18" x="3" y="4" rx="2" />
          <path d="M3 10h18" />
          <path d="M8 14h.01" />
          <path d="M12 14h.01" />
          <path d="M16 14h.01" />
          <path d="M8 18h.01" />
          <path d="M12 18h.01" />
          <path d="M16 18h.01" />
        </svg>
        {/* Its name is whichever label shows, so what is read out is what is
            on screen. */}
        <span className="text-xs leading-none min-[480px]:hidden">Contact</span>
        <span className="hidden min-[480px]:inline">{site.meeting.label}</span>
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
              <h2
                id="meeting-title"
                ref={titleRef}
                tabIndex={-1}
                className="font-display text-ink text-2xl leading-tight font-normal outline-none"
              >
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
              className="text-muted hover:text-ink -mr-1 grid size-7 shrink-0 place-items-center rounded-full text-xl leading-none transition-colors"
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
            {drawn ? null : (
              <p
                className="bg-paper text-muted absolute inset-0 grid place-items-center text-sm font-semibold"
                role="status"
              >
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
