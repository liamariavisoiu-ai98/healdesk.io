import { ContactCard } from "@/components/ContactCard";
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
 * - "How do you handle patient data" must never assert that anyone has
 *   certified or audited us. There is no HIPAA certification, and displaying a
 *   compliance seal was charged as a standalone deception count in *In re
 *   SkyMed International* (2021). Say what we do; say that nobody has audited
 *   it. See the note in Footer.tsx.
 */
const FAQS = [
  {
    q: `What does ${site.agent} actually do?`,
    a:
      "She answers the phone, texts, web chat, Instagram DMs and WhatsApp, " +
      "24 hours a day. She handles treatment and pricing questions, works out " +
      "whether someone is a serious consult or a price-shopper, books them in, " +
      "and rings back the numbers that went unanswered. An unanswered phone " +
      "stops being a lost patient.",
  },
  {
    q: "Does she book into the system we already use?",
    a:
      "Yes. Mindbody, Vagaro, Boulevard, Zenoti and GoHighLevel, or a plain " +
      "calendar if that's what you run. A deposit link goes out after the call " +
      "when you want one, which is the cheapest no-show fix there is.",
  },
  {
    q: "What do we have to log into?",
    a:
      "Nothing. There is no dashboard for your team to learn, no seats to " +
      "hand out and no software to run. You get the bookings in the system you " +
      "already use and a report in your inbox. healdesk is a service, not " +
      "another tool sitting on your front desk.",
  },
  {
    q: "Will she give medical advice?",
    a:
      "Never, and that is the design rather than a limitation. Anything " +
      "clinical, safety, side effects, recovery, whether someone is a " +
      "candidate, goes to your clinical team, with a warm handoff and a " +
      "booked consult. Intake, history and consent go to a secure link, not " +
      "onto the call.",
  },
  {
    q: "How do you handle patient data?",
    a:
      "We sign a BAA with every clinic. Patient data sits in US-only AWS " +
      "infrastructure under a signed AWS BAA, encrypted in transit and at rest, " +
      "and we never use it to train models. Our access to your practice " +
      "management system is read-only, and we delete any patient's data on " +
      "request. No third party has audited us, those are our own commitments, " +
      "and we will walk you through the architecture behind any of them.",
  },
  {
    q: "How would we know it's working?",
    a:
      "You get the part most AI receptionists skip. They write a booking into " +
      "your calendar and stop there, so the most they can tell you is that a " +
      "call was recovered. We read the money event back out of your own " +
      "point-of-sale, so you can follow a single recovered call through to " +
      "booked, showed up, and collected. It all stays inside your systems, " +
      "we never send patient information to an advertising platform.",
  },
  {
    q: "Can we hear her before we commit?",
    a:
      "Yes. Put your number into the phone panel above and she'll ring you " +
      "back in about a minute, talk to her the way a patient would.",
  },
] as const;

export function KnowMore() {
  return (
    <section id="more" className="scroll-mt-24 pt-8 pb-24 sm:pb-28">
      <div className="max-w-[52ch]">
        <p className="text-muted text-xs font-bold tracking-[0.14em] uppercase">
          Want to know more?
        </p>
        <h2 className="font-display mt-3 text-[clamp(36px,5.28vw,62.4px)] leading-[1.04] font-medium tracking-[-0.026em]">
          Ask us anything you&apos;d ask a supplier.
        </h2>
      </div>

      <div className="mt-11 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-14">
        <ContactCard />

        <div>
          {FAQS.map((faq) => (
            <details
              key={faq.q}
              // Native disclosure rather than a hand-rolled accordion: it is
              // keyboard-operable, announced correctly, and findable by the
              // browser's own in-page search, all without a line of JS.
              className="group border-line border-b py-5 first:border-t"
            >
              <summary className="flex cursor-pointer list-none items-start gap-4 [&::-webkit-details-marker]:hidden">
                <span className="font-display flex-1 text-[21.6px] leading-snug font-medium tracking-[-0.015em]">
                  {faq.q}
                </span>
                <span
                  aria-hidden
                  className="text-red-deep mt-0.5 shrink-0 text-[21.6px] leading-none transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="text-muted mt-3 max-w-[62ch] text-[18px] leading-[1.55] font-medium">
                {faq.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
