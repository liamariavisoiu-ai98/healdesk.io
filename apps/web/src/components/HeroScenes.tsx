import type { HeroLogo } from "@/lib/integrations";

/**
 * The scene each hero logo's card plays: one example per channel and per
 * tool, each drawn in that channel's or that tool's own look (owner, 12
 * October 2026). What each says, and why it is true of v1, is in
 * lib/integrations.ts; this file only draws it, and globals.css ("The cards'
 * scenes") moves it.
 *
 * The motion is all CSS and all keyed to the card being shown
 * (`.portrait__node[data-shown]`), so every time a card opens its scene plays
 * from the start, whether a visitor opened it or the hero did, and a hidden
 * card costs nothing. The card is decoration: it is aria-hidden, and the
 * logo's button says the same thing in words (`showcase`).
 */
export function HeroScene({ logo }: { logo: HeroLogo }) {
  switch (logo.scene) {
    case "web":
      return <WebChat />;
    case "instagram":
      return <Instagram />;
    case "messenger":
      return <Messenger />;
    case "whatsapp":
      return <WhatsApp />;
    case "call":
      return <Call />;
    case "gcal":
      return <GoogleCalendar />;
    case "calcom":
      return <CalCom />;
    case "calendly":
      return <Calendly />;
    case "highlevel":
      return <HighLevel />;
    case "stripe":
      return <Stripe />;
  }
}

/** A check that draws itself. */
function Check({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`sc-check ${className}`} aria-hidden>
      <path d="M3.5 8.4l3 3 6-6.8" pathLength={1} />
    </svg>
  );
}

/** WhatsApp's double tick, each stroke drawing in turn. */
function Ticks() {
  return (
    <svg viewBox="0 0 20 12" className="sc-ticks" aria-hidden>
      <path d="M1.5 6.4l3.3 3.3L13 1.6" pathLength={1} />
      <path d="M8.6 9.4l.3.3L17.2 1.6" pathLength={1} />
    </svg>
  );
}

/** Website chat: the question, typed, then the booking. */
function WebChat() {
  return (
    <span className="sc sc-web">
      <span className="sc-row sc-row--1">
        <span className="sc-web__icon" aria-hidden>
          <span className="sc-dots">
            <i />
            <i />
            <i />
          </span>
        </span>
        <span className="sc-type">Asked about pricing</span>
      </span>
      <span className="sc-row sc-row--2">
        <span className="sc-web__icon sc-web__icon--booked" aria-hidden>
          <Check />
        </span>
        <span className="sc-type sc-strong">Consultation booked · Thu 3:00 PM</span>
      </span>
    </span>
  );
}

/** Instagram's direct messages: a "New messages" divider, the question, the reply. */
function Instagram() {
  return (
    <span className="sc sc-ig">
      <span className="sc-ig__divider">
        <span>New messages</span>
      </span>
      <span className="sc-ig__them">
        <span className="sc-ig__avatar" aria-hidden />
        <span className="sc-ig__bubble">Can I get a consultation with…?</span>
      </span>
      <span className="sc-ig__me">Consultation booked · Sat 10:30 AM</span>
    </span>
  );
}

/**
 * Messenger, as the patient sees it: their question in Messenger's blue, the
 * clinic Page's little round avatar arriving under it to say it was seen,
 * then the answer.
 */
function Messenger() {
  return (
    <span className="sc sc-ms">
      <span className="sc-ms__q">When are you open on Saturday?</span>
      <span className="sc-ms__seen">
        Seen
        <span className="sc-ms__avatar" aria-hidden>
          h
        </span>
      </span>
      <span className="sc-ms__a">Opening hours answered</span>
    </span>
  );
}

/** WhatsApp: received with grey ticks, replied with the ticks turning blue. */
function WhatsApp() {
  return (
    <span className="sc sc-wa">
      <span className="sc-wa__bubble sc-wa__bubble--in">
        Received at 11:02 PM
        <span className="sc-wa__ticks sc-wa__ticks--grey">
          <Ticks />
        </span>
      </span>
      <span className="sc-wa__bubble sc-wa__bubble--out">
        Replied at 11:02 PM
        <span className="sc-wa__ticks sc-wa__ticks--blue">
          <Ticks />
        </span>
      </span>
    </span>
  );
}

/** The phone line: a live call, its timer running and its voice moving, then the booking. */
function Call() {
  return (
    <span className="sc sc-call">
      <span className="sc-call__live">
        <span className="sc-call__dot" aria-hidden />
        <span className="sc-call__timer" aria-hidden />
        <span className="sc-call__wave" aria-hidden>
          {Array.from({ length: 14 }, (_, i) => (
            <i key={i} style={{ ["--b" as string]: i }} />
          ))}
        </span>
      </span>
      <span className="sc-row sc-row--2 sc-call__done">
        <span className="sc-web__icon sc-web__icon--booked" aria-hidden>
          <Check />
        </span>
        <span className="sc-type sc-strong">Consultation booked, deposit flagged for your team</span>
      </span>
    </span>
  );
}

/** The hours either side of the slot, for the calendars' day columns. */
const HOURS = ["2 PM", "3 PM", "4 PM"] as const;

/** Google Calendar: a day, and the request dropping into 3 PM. */
function GoogleCalendar() {
  return (
    <span className="sc sc-cal sc-gcal">
      <span className="sc-cal__day">Thu</span>
      <span className="sc-cal__grid">
        {HOURS.map((hour) => (
          <span key={hour} className="sc-cal__hour">
            {hour}
          </span>
        ))}
        <span className="sc-gcal__block">
          <span className="sc-gcal__time">3:00 PM</span>
          Request sent for staff approval
        </span>
      </span>
    </span>
  );
}

/** Cal.com: its plain black-and-white week, the 3 PM slot turning busy. */
function CalCom() {
  return (
    <span className="sc sc-cal sc-calcom">
      <span className="sc-cal__day">Thu</span>
      <span className="sc-cal__grid">
        {HOURS.map((hour) => (
          <span key={hour} className="sc-cal__hour">
            {hour}
          </span>
        ))}
        <span className="sc-calcom__block">
          Busy
          <span className="sc-sync">Synced from Google</span>
        </span>
      </span>
    </span>
  );
}

/** Calendly: its booking page's times, 3:00 PM taken off as the slot syncs. */
function Calendly() {
  return (
    <span className="sc sc-calendly">
      <span className="sc-calendly__day">Thursday</span>
      <span className="sc-calendly__slot">2:00pm</span>
      <span className="sc-calendly__slot sc-calendly__slot--taken">3:00pm</span>
      <span className="sc-calendly__slot">4:00pm</span>
      <span className="sc-sync">Synced from Google Calendar</span>
    </span>
  );
}

/** HighLevel: its calendar, a blocked slot arriving at 3 PM. */
function HighLevel() {
  return (
    <span className="sc sc-cal sc-hl">
      <span className="sc-cal__day">Thu</span>
      <span className="sc-cal__grid">
        {HOURS.map((hour) => (
          <span key={hour} className="sc-cal__hour">
            {hour}
          </span>
        ))}
        <span className="sc-hl__block">
          Blocked · 3:00 PM
          <span className="sc-sync">Synced from Google</span>
        </span>
      </span>
    </span>
  );
}

/** Stripe: the deposit going through, the tick, the slot confirmed. */
function Stripe() {
  return (
    <span className="sc sc-stripe">
      <span className="sc-stripe__head">
        Deposit
        <span className="sc-stripe__amount">$100</span>
      </span>
      <span className="sc-stripe__bar" aria-hidden>
        <i />
      </span>
      <span className="sc-stripe__done">
        <span className="sc-stripe__tick" aria-hidden>
          <Check />
        </span>
        <span className="sc-type sc-strong">Slot confirmed</span>
      </span>
    </span>
  );
}
