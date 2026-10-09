/**
 * The eight outcomes on the homepage, as the notifications a clinic's phone
 * would show in its first month, and the photograph that stands for each.
 *
 * Approved by the owner on 23 September 2026; the photographs were made to a
 * brief on 29 September: the same boutique clinic in every frame, high-key
 * daylight, Apple devices with their screens as soft glow, people only as
 * hands or a turned back. They sit in public/outcomes at 720x990.
 *
 * Since 9 October 2026 the section is an iOS lock screen (the owner's pick,
 * "Notification wall, but make it look more like iOS"), so each outcome is a
 * notification: `title` is its bold first line, a few words that say what
 * just happened (the owner asked for headings that make more sense with the
 * fewest words), `time` is when, and `line` is its body, the outcome itself,
 * unchanged. Newest first, as a lock screen lists them; the clock above them
 * reads 9:41.
 *
 * Every line is a thing v1 does as docs/v1-product-spec.md defines it, and
 * the proof lines stay inside the spec's v1 claim set: conversations handled,
 * appointments booked, calls answered that would have rung out, deposits
 * collected, booked value. Never revenue. Change the product before changing
 * a line.
 */
export type Outcome = {
  id: string;
  title: string;
  time: string;
  line: string;
  still: string;
};

export const OUTCOMES: readonly Outcome[] = [
  {
    id: "one-voice",
    title: "DMs answered",
    time: "now",
    line: "Instagram, Messenger and WhatsApp answered in the same voice as the phone.",
    still: "/outcomes/one-voice.webp",
  },
  {
    id: "from-your-list",
    title: "Price quoted from your list",
    time: "2m ago",
    line: "Price questions answered from your own list, never guessed.",
    still: "/outcomes/from-your-list.webp",
  },
  {
    id: "deposit",
    title: "Deposit paid",
    time: "26m ago",
    line: "Deposits taken in chat, through your own checkout, before the slot is lost.",
    still: "/outcomes/deposit.webp",
  },
  {
    id: "by-morning",
    title: "Booked overnight",
    time: "7:02 AM",
    line: "Consults booked into your calendar overnight, there when you open up.",
    still: "/outcomes/by-morning.webp",
  },
  {
    id: "answered",
    title: "After-hours call answered",
    time: "11:48 PM",
    line: "Every after-hours call answered, not sent to voicemail.",
    still: "/outcomes/answered.webp",
  },
  {
    id: "recovered",
    title: "Overflow call answered",
    time: "Yesterday",
    // "Calls ... answered", not "callbacks ... recovered": the product is
    // inbound only and never rings anyone, and the terms say so.
    line: "Calls the desk missed, answered while the caller is still deciding.",
    still: "/outcomes/recovered.webp",
  },
  {
    id: "to-a-person",
    title: "Handed to your team",
    time: "Yesterday",
    line: "Anything clinical passed to a person, every time.",
    still: "/outcomes/to-a-person.webp",
  },
  {
    id: "named",
    title: "Your week, counted",
    time: "Monday",
    line: "Every week: calls answered that would have rung out, appointments booked, and their booked value.",
    still: "/outcomes/named.webp",
  },
] as const;
