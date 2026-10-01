import { GUARANTEE_TEXT } from "@/lib/legal";

/**
 * The first-month guarantee, as it appears on the pricing page.
 *
 * The spec ("The guarantee") requires the wording on the pricing page and in
 * the service agreement to be identical, so neither page writes a word of it:
 * both render GUARANTEE_TEXT from lib/legal.ts, paragraph for paragraph, with
 * the same bold lead-in. The terms (§ 5) add the contract mechanics around it
 * — that the refund sits outside the liability section and that force majeure
 * does not excuse a miss — and those stay there, where the section numbers
 * mean something. This component is a server component on purpose: the
 * pricing page's client-side modal provider wraps it, and a plain function of
 * a constant is what a test can render on its own.
 *
 * Under the FTC Act the material conditions of an advertised guarantee have
 * to be clear where it is advertised, not only in the agreement a buyer sees
 * later, which is why the whole text is here rather than a one-line summary
 * with a link.
 */
export function Guarantee() {
  return (
    <section
      aria-labelledby="guarantee-heading"
      className="border-line mt-20 rounded-[24px] border bg-white p-7 sm:p-10"
    >
      <p className="eyebrow-tag">If she misses one, the month is on us</p>
      <h2
        id="guarantee-heading"
        className="font-display mt-5 text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]"
      >
        {GUARANTEE_TEXT.heading}
      </h2>
      <div className="mt-6 max-w-[72ch] space-y-4 text-[16.2px] leading-[1.55] font-medium">
        {GUARANTEE_TEXT.paragraphs.map((para) => (
          <p key={para.lead}>
            <strong>{para.lead}</strong> {para.body}
          </p>
        ))}
      </div>
      <p className="text-muted mt-6 max-w-[72ch] text-sm font-medium">
        The same words are in section 5 of our{" "}
        <a href="/terms#refunds" className="underline underline-offset-2">
          terms
        </a>
        , which also say how the refund sits with the rest of the agreement.
      </p>
    </section>
  );
}
