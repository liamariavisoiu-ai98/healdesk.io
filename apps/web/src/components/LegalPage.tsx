import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { ENTITY, LEGAL_LAST_UPDATED, LEGAL_VERSION, legalFactsComplete } from "@/lib/legal";

/**
 * Shared frame for /privacy, /terms and /subprocessors.
 *
 * One column of readable width, real headings, and a footer that prints the
 * version and date so a reader can tell which text they read. While the
 * founder-supplied facts in src/lib/legal.ts are incomplete, a banner says
 * so at the top of every page — the alternative, a plausible-looking entity
 * name invented to fill the gap, is the one thing a legal page must never do.
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
      <main className="mx-auto max-w-[760px] px-5 pt-14 pb-24 sm:px-8 sm:pt-20">
        {!complete ? (
          <div
            role="status"
            className="border-sun bg-sun/[0.16] mb-8 rounded-2xl border px-5 py-4 text-[15px] leading-relaxed"
          >
            <strong>Draft.</strong> This page is complete except for the legal
            entity name, postal address and governing law, which are being
            finalised. Until they appear here these terms are not offered as a
            binding contract; the Business Associate Agreement presented at
            checkout is.
          </div>
        ) : null}

        <p className="text-muted text-xs font-bold tracking-[0.14em] uppercase">Legal</p>
        <h1 className="font-display mt-3 text-[clamp(34px,5vw,52px)] leading-[1.05] font-medium tracking-[-0.025em]">
          {title}
        </h1>
        <p className="text-muted mt-5 text-[18px] font-medium">{intro}</p>

        <div className="legal-prose mt-10">{children}</div>

        <p className="text-muted border-line mt-14 border-t pt-6 text-xs">
          Version {LEGAL_VERSION} · last updated {LEGAL_LAST_UPDATED} · questions to{" "}
          <a href={`mailto:${ENTITY.privacyEmail}`} className="underline underline-offset-2">
            {ENTITY.privacyEmail}
          </a>
        </p>
      </main>
      <Footer />
    </>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-10 scroll-mt-24">
      <h2 className="font-display text-[26px] leading-tight font-medium tracking-[-0.02em]">{title}</h2>
      <div className="mt-4 space-y-4 text-[16.5px] leading-[1.6]">{children}</div>
    </section>
  );
}
