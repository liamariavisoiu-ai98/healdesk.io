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
 * the demo cards (#aya). Ink, because it is the one dark band on a light page
 * and should read as the end of it, with a soft warm glow in the corner where
 * the hero's own warmth was.
 */
export function ClosingCta() {
  return (
    <section aria-labelledby="closing-heading" className="mb-24 sm:mb-28">
      <div
        data-reveal="stagger"
        className="bg-ink relative isolate overflow-hidden rounded-lg px-6 py-14 text-center text-white sm:px-12 sm:py-20"
      >
        <span
          aria-hidden
          className="absolute inset-0 -z-10 bg-[radial-gradient(60%_80%_at_85%_0%,rgb(255_118_30/0.28),transparent_70%),radial-gradient(50%_70%_at_10%_110%,rgb(230_38_39/0.22),transparent_70%)]"
        />
        <p className="text-[13px] font-semibold tracking-[0.12em] text-white/60 uppercase">Ready when you are</p>
        <h2 id="closing-heading" className="heading-section mx-auto mt-4">
          Let {site.agent} take the next call.
        </h2>
        <p className="mx-auto mt-5 max-w-[52ch] text-[clamp(17px,1.25vw,19px)] leading-[1.55] font-medium text-white/75">
          Talk to her first, free. When you are ready, she answers on the channels you choose.
        </p>
        <div className="mx-auto mt-9 grid w-full max-w-[480px] grid-cols-1 gap-3 sm:grid-cols-2">
          <BuyButton size="h-[54px] px-6 text-base" className="w-full whitespace-nowrap" />
          <a
            href={site.cta.secondary.href}
            className="inline-flex h-[54px] w-full items-center justify-center rounded-sm border-[1.5px] border-white/40 px-6 text-base font-semibold whitespace-nowrap text-white transition-colors duration-fast hover:border-white hover:bg-white hover:text-ink"
          >
            {site.cta.secondary.label}
          </a>
        </div>
      </div>
    </section>
  );
}
