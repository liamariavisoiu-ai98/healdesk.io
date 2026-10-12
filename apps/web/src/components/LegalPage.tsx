import { Children, isValidElement } from "react";

import { Footer } from "@/components/Footer";
import { type LegalContentsEntry, LegalContents } from "@/components/LegalContents";
import { Nav } from "@/components/Nav";
import { ENTITY, LEGAL_LAST_UPDATED, LEGAL_VERSION, legalFactsComplete } from "@/lib/legal";

/**
 * Shared frame for /privacy, /terms and /data-deletion. (/subprocessors and
 * /trust were retired on 9 October 2026: no vendor is named publicly, and
 * /trust's content is the terms' closing annex.)
 *
 * One column of readable width, real headings, and a footer that prints the
 * version and date so a reader can tell which text they read. While the
 * founder-supplied facts in src/lib/legal.ts are incomplete, a banner says
 * so at the top of every page — the alternative, a plausible-looking entity
 * name invented to fill the gap, is the one thing a legal page must never do.
 *
 * ## Measure, leading and the contents rail (owner, 12 October 2026)
 *
 * The body ran at about 84 characters a line with a line-height of 1.6, which
 * is long and tight for a contract read carefully: paragraphs and list items
 * are now held to about 68 characters and set at 1.7. The measure is 34em,
 * not 68ch: `ch` is the width of a zero, and Instrument Sans's zero is so much
 * wider than its average letter that 68ch came out at about 90 characters,
 * longer than before. Tables keep the column's full width, so section 3's
 * prices scroll sideways no sooner than they did.
 *
 * From 1024px a contents rail sits to the left of the text (LegalContents),
 * one link per Section. The list is read from the page's own Sections, the
 * `<Section id title>` children below, so no page lists its headings twice
 * and a section added to a page is in its contents the same day. The ids are
 * the Sections' own, unchanged: /terms#security, where /trust redirects, and
 * every other link into these pages keep working.
 *
 * The rail is outside <main> on purpose. legal-version.test.ts hashes the text
 * inside <main> as the published legal text, and a list of headings is
 * navigation, not a term: inside, it would read as a change to the contract.
 */
export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  const complete = legalFactsComplete();
  return (
    <>
      <Nav />
      <div className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-12 lg:px-14 xl:grid-cols-[15rem_minmax(0,1fr)] xl:gap-20">
        <LegalContents entries={contentsOf(children)} />

        <main className="mx-auto max-w-[760px] pt-14 pb-24 sm:pt-20 lg:mx-0">
          {!complete ? (
            <div
              role="status"
              className="border-sun bg-sun/[0.16] mb-8 rounded-md border px-5 py-4 text-[15px] leading-relaxed"
            >
              <strong>Draft.</strong> This page is complete except for the legal
              entity name, postal address and governing law, which are being
              finalised. Until they appear here these terms are not offered as a
              binding contract; the Business Associate Agreement presented at
              checkout is.
            </div>
          ) : null}

          <p className="eyebrow-tag">Legal</p>
          <h1 className="font-display mt-3 text-[clamp(34px,5vw,52px)] leading-[1.05] font-medium tracking-[-0.025em]">
            {title}
          </h1>
          <p className="text-muted mt-5 max-w-[34em] text-[18px] leading-[1.6] font-medium">{intro}</p>

          <div className="legal-prose mt-10">{children}</div>

          <p className="text-muted border-line mt-14 border-t pt-6 text-xs">
            Version {LEGAL_VERSION} · last updated {LEGAL_LAST_UPDATED} · questions to{" "}
            <a href={`mailto:${ENTITY.email}`} className="underline underline-offset-2">
              {ENTITY.email}
            </a>
          </p>
        </main>
      </div>
      <Footer />
    </>
  );
}

type SectionProps = { id: string; title: string; children: React.ReactNode };

export function Section({ id, title, children }: SectionProps) {
  return (
    <section id={id} className="mt-12 scroll-mt-24">
      <h2 className="font-display text-[26px] leading-tight font-medium tracking-[-0.02em]">{title}</h2>
      <div className="mt-4 space-y-4 text-[16.5px] leading-[1.7] [&_li]:max-w-[34em] [&_p]:max-w-[34em]">
        {children}
      </div>
    </section>
  );
}

/** The contents of a legal page: its Sections, in order, by their own id and title. */
function contentsOf(children: React.ReactNode): LegalContentsEntry[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement<SectionProps>(child) && child.type === Section
      ? [{ id: child.props.id, title: child.props.title }]
      : [],
  );
}
