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
  /**
   * What opens when the notification is pressed: the outcome in practice, one
   * concrete case, in a working clinician's plain voice (owner, 12 October
   * 2026: "easy, peer-to-peer and highly knowledgeable"). Each is written
   * from the spec's own mechanics (docs/v1-product-spec.md) and nothing else:
   * the forwarding modes, the 60-second hold, the clinic's own list, the fixed
   * reply to a complication, the confirm-or-ignore list. No treatment name
   * appears in a Meta example (the spec's guardrails), no vendor is named, and
   * nothing says "revenue".
   */
  detail: string;
  still: string;
};

export const OUTCOMES: readonly Outcome[] = [
  {
    id: "one-voice",
    title: "DMs answered",
    time: "now",
    line: "Instagram, Messenger and WhatsApp answered in the same voice as the phone.",
    detail:
      "Someone messages your Instagram at 9:40 on a Sunday night to ask what a first consultation costs. AYA answers from your own price list, in the tone you set, and offers times to come in. She keeps it non-clinical, because Meta carries no BAA, and the whole thread is waiting in Conversations when your team opens on Monday.",
    still: "/outcomes/one-voice.webp",
  },
  {
    id: "from-your-list",
    title: "Price quoted from your list",
    time: "2m ago",
    line: "Price questions answered from your own list, never guessed.",
    detail:
      "A caller asks what a consultation runs, then asks about something you haven't priced. The first she answers to the dollar, from your list. The second she doesn't guess: she offers a consultation instead. When your site's prices change, she waits for you to confirm them before she quotes the new ones.",
    still: "/outcomes/from-your-list.webp",
  },
  {
    id: "deposit",
    title: "Deposit paid",
    time: "26m ago",
    line: "Deposits taken in chat, through your own checkout, before the slot is lost.",
    detail:
      "A visitor picks a time on your website and gives a name and number. AYA holds the slot for 60 seconds, and if that service carries a deposit, your own checkout opens in the same browser. They pay, the booking flips to paid. No card number ever passes through us, and the booking is in your calendar either way.",
    still: "/outcomes/deposit.webp",
  },
  {
    id: "by-morning",
    title: "Booked overnight",
    time: "7:02 AM",
    line: "Consults booked into your calendar overnight, there when you open up.",
    detail:
      "At 11:50 on a weeknight a caller who has dithered all evening rings. AYA checks your live calendar, offers two or three times aloud, holds the one they choose for 60 seconds, takes a name and number, and writes it to your Google Calendar. If your booking page reads Google, that slot is already off it. On Mindbody or Boulevard your staff confirm it by hand.",
    still: "/outcomes/by-morning.webp",
  },
  {
    id: "answered",
    title: "After-hours call answered",
    time: "11:48 PM",
    line: "Every after-hours call answered, not sent to voicemail.",
    detail:
      "You set call forwarding on your own line once: after hours goes to her. At 8:15 on a Tuesday evening a caller gets AYA, greeting them in your tone and answering from your menu and hours, instead of a voicemail they won't leave. Your published number never changes, and you choose all calls, overflow, or after hours only.",
    still: "/outcomes/answered.webp",
  },
  {
    id: "recovered",
    title: "Overflow call answered",
    time: "Yesterday",
    // "Calls ... answered", not "callbacks ... recovered": the product is
    // inbound only and never rings anyone, and the terms say so.
    line: "Calls the desk missed, answered while the caller is still deciding.",
    detail:
      "Your desk is with a patient and the phone rings out. With overflow coverage the call forwards on busy, or after the number of rings you set, and AYA picks up while the caller is still deciding whether to try the next clinic. When your team answers, nothing changes for them: she only gets what would have rung out.",
    still: "/outcomes/recovered.webp",
  },
  {
    id: "to-a-person",
    title: "Handed to your team",
    time: "Yesterday",
    line: "Anything clinical passed to a person, every time.",
    detail:
      "A patient writes that something feels wrong after a visit. That message never reaches the AI: it matches a fixed pattern first, gets a fixed reply pointing to 911 and your urgent-help number, and your on-call contact is alerted at once. A question that is merely clinical, like whether someone is a candidate, becomes a consultation with your provider, not an answer.",
    still: "/outcomes/to-a-person.webp",
  },
  {
    id: "named",
    title: "Your week, counted",
    time: "Monday",
    line: "Every week: calls answered that would have rung out, appointments booked, and their booked value.",
    detail:
      "Your portal's Home screen and the first email of each week show the same few numbers: conversations handled, appointments booked, deposits collected, the calls she answered that would have rung out, and the booked value at your own prices. It counts bookings, so you can check any figure against your own calendar.",
    still: "/outcomes/named.webp",
  },
] as const;
