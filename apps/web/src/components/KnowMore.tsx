import { ContactCard } from "@/components/ContactCard";
import { FaqItem } from "@/components/FaqItem";
import { site } from "@/lib/site";

/**
 * "Want to know more", the questions, and a way to ask a different one.
 *
 * ## Why the answers read the way they do
 *
 * Every one of these is a fact we can be asked to demonstrate. That is a
 * deliberate constraint, not a style: this section replaced a grid of
 * capability cards, and a FAQ is the format where vague marketing language gets
 * caught, because a prospect reads it as a direct answer to a direct question.
 *
 * Two answers carry real risk if they drift:
 *
 * - "Does she give medical advice" must keep saying no. The product is
 *   deliberately PHI-light and deflects anything clinical, the chat demo's
 *   system prompt enforces the same boundary, and nothing stands behind a
 *   bodily-injury claim: healdesk carries no insurance (docs/handover.md,
 *   decisions log, item 10), and no policy would have covered it anyway.
 * - "How do you handle patient data" (the footer's commitments since 9
 *   October 2026) must never assert that anyone has certified or audited us. There is no HIPAA certification, and displaying a
 *   compliance seal was charged as a standalone deception count in *In re
 *   SkyMed International* (2021). Say what we do; say that nobody has audited
 *   it. See the note in Footer.tsx. It also claims only what is decided: no
 *   storage location while the voice provider's region is unconfirmed,
 *   encryption in transit only where we control both ends, and the model
 *   provider's two-year exception beside its 30 days.
 * - "How would we know it's working" may claim only what v1 counts:
 *   conversations handled, appointments booked, calls answered that would
 *   have rung out, deposits collected, and booked value. Never revenue or
 *   "collected": attended-and-paid needs read-back from the clinic's own
 *   point of sale, which is phase two (docs/v1-product-spec.md, "What v1 can
 *   prove, and what it cannot").
 *
 * The setup answer is per channel on purpose: a global "live in minutes" is
 * the promise the spec forbids, because voice waits on the clinic's call
 * forwarding and WhatsApp on its own Meta billing.
 */
/** A question, its answer, and, for an answer that is a set of commitments, the list before it. */
type Faq = { q: string; a: string; list?: readonly string[] };

const FAQS = [
  {
    q: `What does ${site.agent} actually do?`,
    a:
      "She answers your phone, website chat, Instagram, Messenger and " +
      "WhatsApp, day or night. She answers treatment and price questions " +
      "from your own menu, books consultations into your calendar during " +
      "the conversation, and picks up the calls that used to ring out. She " +
      "only answers: she never contacts a patient first.",
  },
  {
    q: "Where does she book?",
    a:
      "Into your Google Calendar, live, during the conversation. Link " +
      "Calendly or Cal.com to that calendar and they stop offering the " +
      "slot. Mindbody syncs one way and Boulevard is unconfirmed, so for " +
      "those your staff confirm each booking in your own system; we tell " +
      "you which applies before you buy. In chat she sends your own " +
      "checkout link for a deposit. On the phone she books and flags the " +
      "deposit for your desk.",
  },
  {
    q: "What do we have to log into?",
    a:
      "A small portal, used when you want it. Your clinic has one sign-in, " +
      "at the one email address it uses with us (a shared inbox such as " +
      "info@ is fine), from an emailed link with no password. Each device " +
      "adds its own passkey, which opening a conversation or booking asks " +
      "for. Switches change how she behaves. Every conversation and " +
      "booking is there.",
  },
  {
    q: "How long until she's live?",
    a:
      "About fifteen minutes of your time, then each channel goes live on " +
      "its own: website chat once the snippet is on your site, Instagram " +
      "and Messenger once you connect them, your phone once call " +
      "forwarding is set. WhatsApp goes live once its account has a " +
      "payment method: Meta bills you directly for WhatsApp messages, " +
      "replies included from 1 October 2026, and we don't resell them.",
  },
  {
    q: "Do we have to give her every call?",
    a:
      "No. You choose all calls, overflow and after hours, or after hours " +
      "only. Your published number never changes: your line forwards the " +
      "calls you pick. With a full-time receptionist, start on after " +
      "hours only and widen it when you trust her.",
  },
  {
    q: "Will she give medical advice?",
    a:
      "Never, by design. Anything clinical (safety, side effects, recovery, " +
      "whether someone is a candidate) gets a consultation with your " +
      "provider, not an answer. A complication or urgent symptom never " +
      "reaches the AI: it gets a fixed response and an immediate alert to " +
      "your on-call contact. She takes only what a receptionist would " +
      "write on a callback slip.",
  },
  {
    // The footer's "How we handle patient data" strip, moved here as its own
    // answer on 9 October 2026 (owner). The bookings line says "the Calendar
    // you connect", as the owner asked; v1 writes to Google Calendar only.
    q: "How do you handle patient data?",
    list: [
      "We sign a business associate agreement and handle patient data under it.",
      "We never use patient data to train models.",
      "We write bookings only to the Calendar you connect.",
      "Encrypted at rest, and in transit wherever we control both ends.",
      "Patient data is deleted on your instruction. Each transcript is emailed to you " +
        "and not kept: our encrypted copy is deleted seven days after it is sent, and " +
        "conversation records after 90 days. Our AI model provider keeps " +
        "conversation inputs for 30 days, or up to two years where its safety " +
        "systems flag them or the law requires it to keep them.",
    ],
    a:
      "Meta signs no BAA, so Instagram, Messenger and WhatsApp stay " +
      "non-clinical. No third party has audited us: these are our own " +
      "commitments, and we'll walk you through the architecture behind " +
      "any of them.",
  },
  {
    q: "How would we know it's working?",
    a:
      "Your portal's Home screen and a weekly email show conversations " +
      "handled, appointments booked, calls answered that would have rung " +
      "out, and deposits collected, plus the booked value at your own " +
      "prices. Nothing about a patient goes to an advertising platform.",
  },
  {
    q: "Can we hear her before we commit?",
    a:
      "Yes. Talk to her in the cards above, in your browser or by phone, or " +
      "have her call you once. That demo call is the only call she ever " +
      "places: for your clinic she only answers.",
  },
] as const satisfies readonly Faq[];

export function KnowMore() {
  return (
    <section id="more" className="page-section scroll-mt-24">
      <div data-reveal="stagger">
        <p className="eyebrow-tag">
          Want to know more?
        </p>
        <h2 className="heading-section mt-5">
          Ask us anything.
        </h2>
      </div>

      <div data-reveal="stagger" className="mt-11 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-14">
        <ContactCard />

        <div>
          {FAQS.map((faq) => (
            // A native <details> still (FaqItem): keyboard-operable, announced
            // correctly, and findable by the browser's own in-page search; it
            // only adds the smooth open and close.
            <FaqItem key={faq.q} question={faq.q}>
              {"list" in faq ? (
                <ul className="mt-3 max-w-[62ch] space-y-2">
                  {faq.list.map((item) => (
                    <li key={item} className="text-muted flex gap-2.5 text-[18px] leading-[1.55] font-medium">
                      <span aria-hidden className="text-red-deep shrink-0">
                        ✓
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-muted mt-3 max-w-[62ch] text-[18px] leading-[1.55] font-medium">
                {faq.a}
              </p>
            </FaqItem>
          ))}
        </div>
      </div>
    </section>
  );
}
