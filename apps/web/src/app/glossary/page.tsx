import type { Metadata } from "next";

import { Footer } from "@/components/Footer";
import { JsonLd } from "@/components/JsonLd";
import { Nav } from "@/components/Nav";
import { glossary, glossaryReviewed, glossarySources } from "@/lib/content/glossary";
import { Inline } from "@/lib/content/inline";
import { HUB, formatDate } from "@/lib/content/registry";
import { site } from "@/lib/site";
import { breadcrumbLd, definedTermSetLd, termAnchor } from "@/lib/structured-data";

const PATH = "/glossary";

export const metadata: Metadata = {
  alternates: { canonical: PATH },
  title: "Glossary of AI receptionist terms",
  description:
    "One-sentence definitions of the terms a clinic meets when choosing an AI receptionist: call forwarding, business associate agreements, consent laws and more.",
};

/**
 * One sentence per term, each able to stand on its own, because a
 * definition is the unit an answer engine lifts. Terms are listed
 * alphabetically and each has its own anchor.
 */
export default function GlossaryPage() {
  const entries = [...glossary].sort((a, b) => a.term.localeCompare(b.term));
  const numbers = new Map(glossarySources.map((source, index) => [source.id, index + 1]));

  return (
    <>
      <JsonLd
        data={[
          definedTermSetLd(entries, PATH),
          breadcrumbLd([
            { name: "Home", path: "/" },
            { name: HUB.name, path: HUB.path },
            { name: "Glossary", path: PATH },
          ]),
        ]}
      />
      <Nav />
      <main className="mx-auto max-w-[760px] px-5 pt-16 pb-24 sm:px-8 sm:pt-20">
        <nav aria-label="Breadcrumb" className="text-muted text-[14px] font-medium">
          <a href={HUB.path} className="hover:text-ink underline-offset-2 hover:underline">
            {HUB.name}
          </a>
        </nav>
        <h1 className="font-display mt-3 text-[clamp(34px,5vw,52px)] leading-[1.05] font-medium tracking-[-0.025em]">
          Glossary of AI receptionist terms
        </h1>
        <p className="text-muted mt-4 text-[14.5px] leading-relaxed">
          Published by {site.name}, which sells an AI receptionist. How we source and correct:{" "}
          <a href="/about#sourcing" className="underline underline-offset-2">
            our standards
          </a>
          . Last reviewed <time dateTime={glossaryReviewed}>{formatDate(glossaryReviewed)}</time>.
        </p>

        <dl className="mt-10 space-y-6">
          {entries.map((entry) => (
            <div key={entry.term} id={termAnchor(entry.term)} className="scroll-mt-24">
              <dt className="font-display text-[20px] font-medium tracking-[-0.01em]">{entry.term}</dt>
              <dd className="mt-1 text-[16.5px] leading-[1.7]">
                <Inline text={entry.definition} />
                {entry.cite?.map((id) => {
                  const n = numbers.get(id);
                  return n === undefined ? null : (
                    <sup key={id} className="text-muted ml-0.5 text-[0.7em]">
                      <a href={`#source-${String(n)}`} aria-label={`Source ${String(n)}`}>
                        [{n}]
                      </a>
                    </sup>
                  );
                })}
                {entry.see ? (
                  <>
                    {" "}
                    <a href={entry.see} className="text-muted underline underline-offset-2">
                      More
                    </a>
                  </>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>

        {glossarySources.length > 0 ? (
          <section aria-labelledby="sources-heading" className="mt-14">
            <h2 id="sources-heading" className="font-display text-[22px] font-medium tracking-[-0.015em]">
              Sources
            </h2>
            <ol className="mt-4 space-y-2 text-[14.5px] leading-[1.6]">
              {glossarySources.map((source, index) => (
                <li key={source.id} id={`source-${String(index + 1)}`} className="scroll-mt-24">
                  <span className="text-muted">[{index + 1}]</span>{" "}
                  <a href={source.url} rel="noopener" className="underline underline-offset-2">
                    {source.title}
                  </a>
                  , {source.publisher}, checked {formatDate(source.checked)}.
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </main>
      <Footer />
    </>
  );
}
