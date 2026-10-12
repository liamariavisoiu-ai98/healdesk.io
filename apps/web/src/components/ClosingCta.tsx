import { BuyButton } from "@/components/BuyModal";
import { site } from "@/lib/site";

/**
 * The homepage's last word before the footer (owner, 12 October 2026): the
 * two ways in, once more, for a visitor who has read to the end.
 *
 * It used to end on the FAQ and a plain footer, so a reader who had made up
 * their mind had to scroll back to the navbar to act on it. The band says
 * nothing the page has not already said and carries no price: packages and
 * prices are shown in the buy flow (the retired /pricing page's rule), and
 * its CTA, which closed that page, went with it on 9 October 2026.
 *
 * The same two buttons as the hero, the same size, the red one first: "Get
 * AYA" opens the purchase flow in place, "Try AYA for free" goes back up to
 * the demo cards (#aya). It stands on the same ground as "See it in your own
 * branding" (owner, 12 October 2026: it was an ink band): the peach light
 * from the top of a rounded stage with a hairline edge (`own-stage`), so the
 * two places on the page that ask the visitor to act look alike.
 */
export function ClosingCta() {
  return (
    <section aria-labelledby="closing-heading" className="mb-24 sm:mb-28">
      <div
        data-reveal="stagger"
        className="own-stage rounded-lg border border-black/[0.06] px-6 py-14 text-center sm:px-12 sm:py-20"
      >
        <p className="text-muted text-[13px] font-semibold tracking-[0.12em] uppercase">Ready when you are</p>
        <h2 id="closing-heading" className="heading-section text-ink mx-auto mt-4">
          Let {site.agent} take the next call.
        </h2>
        <p className="text-muted mx-auto mt-5 max-w-[52ch] text-[clamp(17px,1.25vw,19px)] leading-[1.55] font-medium">
          Talk to her first, free. When you are ready, she answers on the channels you choose.
        </p>
        <div className="mx-auto mt-9 grid w-full max-w-[480px] grid-cols-1 gap-3 sm:grid-cols-2">
          <BuyButton size="h-[54px] px-6 text-base" className="w-full whitespace-nowrap" />
          <a href={site.cta.secondary.href} className="btn-ink h-[54px] w-full px-6 text-base whitespace-nowrap">
            {site.cta.secondary.label}
          </a>
        </div>
      </div>
    </section>
  );
}
