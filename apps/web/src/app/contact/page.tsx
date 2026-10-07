import type { Metadata } from "next";

import { ContactCard } from "@/components/ContactCard";
import { BuyModalProvider } from "@/components/BuyModal";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/contact" },
  title: "Contact us",
  description:
    "Talk to a person about healdesk, what it would answer, what it would " +
    "book, and how we handle patient data.",
};

/**
 * Contact, linked only from the footer.
 *
 * Also the page the demo's consent checkbox links to for terms and privacy, so
 * the data commitments below are load-bearing rather than filler, someone
 * about to hand over their phone number clicks through to exactly this.
 */
const COMMITMENTS = [
  {
    q: "What happens to a number I give you?",
    a:
      "It is used to place the demo call you asked for and nothing else. We " +
      "don't sell it, we don't add it to a marketing list, and we delete it on " +
      "request. Say \"stop\" on the call and the agent hangs up.",
  },
  {
    q: "What happens to an email I give you?",
    a:
      "We use it to reply to you. We email you about healdesk only if you " +
      "ticked the box that says so — one sender, no list swapping, and one " +
      "click or a reply of \"stop\" ends it.",
  },
  {
    q: "And patient data, once we're a customer?",
    a:
      "We sign a BAA before anything connects, and handle patient data under " +
      "it: encrypted at rest and, wherever we control both ends, in transit, " +
      "and never used to train models. The only system we write to is the " +
      "Google Calendar you connect. No third party has audited us, these are " +
      "our own commitments and we'll show you the architecture behind any of " +
      "them.",
  },
] as const;

export default function ContactPage() {
  return (
    <BuyModalProvider>
      <Nav />

      <main className="mx-auto max-w-[1240px] px-5 pt-16 pb-24 sm:px-8 sm:pt-20 lg:px-14">
        <div className="max-w-[52ch]">
          <p className="eyebrow-tag">
            Contact us
          </p>
          <h1 className="font-display mt-3 text-[clamp(40.8px,6vw,69.6px)] leading-[1.03] font-medium tracking-[-0.028em]">
            A real person, usually within a day.
          </h1>
          <p className="text-muted mt-5 text-[20.4px] font-medium">
            Tell us the specialty and where your phone drops, and we&apos;ll tell
            you what {site.agent} would have answered. If you&apos;d rather just
            hear her, call her on{" "}
            <a href={`tel:${site.demoLine.e164}`} className="text-red-deep underline underline-offset-2">
              {site.demoLine.display}
            </a>{" "}
            or{" "}
            <a href="/#aya" className="text-red-deep underline underline-offset-2">
              have her call you
            </a>
            .
          </p>
        </div>

        <div className="mt-12 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-14">
          <ContactCard />

          <div>
            <h2 className="font-display text-[clamp(26.4px,3.12vw,36px)] leading-tight font-medium tracking-[-0.024em]">
              What we do with what you give us.
            </h2>

            {COMMITMENTS.map((item) => (
              <div key={item.q} className="border-line mt-6 border-t pt-5">
                <h3 className="font-display text-[21.6px] leading-snug font-medium tracking-[-0.015em]">
                  {item.q}
                </h3>
                <p className="text-muted mt-2.5 max-w-[62ch] text-[18px] leading-[1.55] font-medium">
                  {item.a}
                </p>
              </div>
            ))}

            <p className="text-muted mt-8 max-w-[62ch] text-[15.6px]">
              Prefer email? {site.email}. Pricing figures anywhere on this site
              are approximate industry ranges, not quotes.
            </p>
          </div>
        </div>
      </main>

      <Footer />
    </BuyModalProvider>
  );
}
