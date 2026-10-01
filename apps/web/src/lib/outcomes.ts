/**
 * The eight outcomes on the homepage, and the photograph that stands for each.
 *
 * Approved by the owner on 23 September 2026; the photographs were made to a
 * brief on 29 September: the same boutique clinic in every frame, high-key
 * daylight, Apple devices with their screens as soft glow, people only as
 * hands or a turned back. They sit in public/outcomes at 720x990, the crop
 * the niche cards use, so the two decks are the same object.
 *
 * `word` is what the front card carries on its floor, one or two words in
 * serif; `line` is the outcome itself, which the ledger beside the deck shows
 * in full at all times and the card opens under the word on hover. The line
 * is never hidden behind the hover: a visitor who never touches the deck has
 * still read all eight.
 *
 * Every line is a thing v1 does as docs/v1-product-spec.md defines it, and
 * the proof lines stay inside the spec's v1 claim set: conversations handled,
 * appointments booked, calls answered that would have rung out, deposits
 * collected, booked value. Never revenue. Change the product before changing
 * a line.
 */
export type Outcome = {
  id: string;
  word: string;
  line: string;
  still: string;
};

export const OUTCOMES: readonly Outcome[] = [
  {
    id: "answered",
    word: "Answered.",
    line: "Every after-hours call answered, not sent to voicemail.",
    still: "/outcomes/answered.webp",
  },
  {
    id: "by-morning",
    word: "Booked overnight.",
    line: "Consults booked into your calendar overnight, there when you open up.",
    still: "/outcomes/by-morning.webp",
  },
  {
    id: "from-your-list",
    word: "From your list.",
    line: "Price questions answered from your own list, never guessed.",
    still: "/outcomes/from-your-list.webp",
  },
  {
    id: "deposit",
    word: "Secured.",
    line: "Deposits taken in chat, through your own checkout, before the slot is lost.",
    still: "/outcomes/deposit.webp",
  },
  {
    id: "one-voice",
    word: "One voice.",
    line: "Instagram, Messenger and WhatsApp answered in the same voice as the phone.",
    still: "/outcomes/one-voice.webp",
  },
  {
    id: "recovered",
    word: "Recovered.",
    // "Calls ... answered", not "callbacks ... recovered": the product is
    // inbound only and never rings anyone, and the terms say so.
    line: "Calls the desk missed, answered while the caller is still deciding.",
    still: "/outcomes/recovered.webp",
  },
  {
    id: "to-a-person",
    word: "To a person.",
    line: "Anything clinical passed to a person, every time.",
    still: "/outcomes/to-a-person.webp",
  },
  {
    id: "named",
    word: "Counted.",
    line: "Every week: calls answered that would have rung out, appointments booked, and their booked value.",
    still: "/outcomes/named.webp",
  },
] as const;
