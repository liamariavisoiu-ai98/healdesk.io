import { Footer } from "@/components/Footer";
import { JsonLd } from "@/components/JsonLd";
import { LegalContents } from "@/components/LegalContents";
import { Nav } from "@/components/Nav";
import { Inline } from "@/lib/content/inline";
import { FAMILIES, HUB, formatDate, liveBySlug, piecePath } from "@/lib/content/registry";
import type { Block, Piece, Source } from "@/lib/content/types";
import { site } from "@/lib/site";
import { articleLd, breadcrumbLd } from "@/lib/structured-data";

/**
 * One editorial page: a guide, a piece of research or a standards page.
 *
 * The order is the house style's. The title is the question; the line under
 * it says who published the page and what they sell, because an AI answer
 * may quote the body without the closing note; the first two sentences
 * answer the question; then the sections, the short factual note on how AYA
 * handles it, and every source with the date it was last opened.
 *
 * Server-rendered and static. Every crawler, including fetchers that run no
 * JavaScript, reads the whole page.
 */
export function ArticlePage({ piece }: { piece: Piece }) {
  const path = piecePath(piece);
  const family = FAMILIES[piece.family];
  const numbers = new Map(piece.sources.map((source, index) => [source.id, index + 1]));
  const related = (piece.related ?? []).flatMap((slug) => {
    const found = liveBySlug(slug);
    return found ? [found] : [];
  });

  return (
    <>
      <JsonLd
        data={[
          articleLd(piece, path),
          breadcrumbLd([
            { name: "Home", path: "/" },
            { name: HUB.name, path: HUB.path },
            { name: piece.title, path },
          ]),
        ]}
      />
      <Nav />
      <div className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-12 lg:px-14 xl:grid-cols-[15rem_minmax(0,1fr)] xl:gap-20">
        <LegalContents entries={piece.sections.map((section) => ({ id: section.id, title: section.heading }))} />

        <main className="mx-auto max-w-[760px] pt-14 pb-24 sm:pt-20 lg:mx-0">
          <nav aria-label="Breadcrumb" className="text-muted text-[14px] font-medium">
            <a href={HUB.path} className="hover:text-ink underline-offset-2 hover:underline">
              {HUB.name}
            </a>
            <span aria-hidden="true"> / </span>
            <span>{family.label}</span>
          </nav>

          <h1 className="font-display mt-3 text-[clamp(32px,4.6vw,50px)] leading-[1.06] font-medium tracking-[-0.025em]">
            {piece.title}
          </h1>

          <p className="text-muted mt-4 text-[14.5px] leading-relaxed">
            Published by {site.name}, which sells an AI receptionist. How we source and correct:{" "}
            <a href="/about#sourcing" className="underline underline-offset-2">
              our standards
            </a>
            . Last reviewed <time dateTime={piece.lastReviewed}>{formatDate(piece.lastReviewed)}</time>.
          </p>

          {piece.legal ? (
            <div role="note" className="border-line bg-paper-2 mt-6 rounded-md border px-5 py-4 text-[15px] leading-relaxed">
              This page describes what the laws say, as of the date above, and links each one. It is not legal
              advice and does not say how a law applies to any one practice.
              {piece.review ? ` ${piece.review}` : ""}
            </div>
          ) : null}

          <p className="mt-8 text-[19px] leading-[1.6] font-medium">
            <Inline text={piece.answer} />
          </p>

          {piece.sections.map((section) => (
            <section key={section.id} id={section.id} className="mt-12 scroll-mt-24">
              <h2 className="font-display text-[26px] leading-tight font-medium tracking-[-0.02em]">
                {section.heading}
              </h2>
              <div className="mt-4 space-y-4 text-[16.5px] leading-[1.7] [&_li]:max-w-[38em] [&_p]:max-w-[38em]">
                {section.blocks.map((block, index) => (
                  <BlockView key={index} block={block} numbers={numbers} />
                ))}
              </div>
            </section>
          ))}

          <section aria-labelledby="aya-note" className="border-line mt-14 border-t pt-8">
            <h2 id="aya-note" className="font-display text-[22px] font-medium tracking-[-0.015em]">
              How {site.agent} handles this
            </h2>
            <div className="mt-3 space-y-3 text-[16.5px] leading-[1.7] [&_p]:max-w-[38em]">
              {piece.aya.map((sentence, index) => (
                <p key={index}>
                  <Inline text={sentence} />
                </p>
              ))}
              <p>
                <a href="/#aya" className="underline underline-offset-2">
                  Try {site.agent} in the demo
                </a>
                .
              </p>
            </div>
          </section>

          <section aria-labelledby="sources-heading" className="mt-12">
            <h2 id="sources-heading" className="font-display text-[22px] font-medium tracking-[-0.015em]">
              Sources
            </h2>
            <ol className="mt-4 space-y-2 text-[14.5px] leading-[1.6]">
              {piece.sources.map((source, index) => (
                <SourceItem key={source.id} source={source} number={index + 1} />
              ))}
            </ol>
          </section>

          {related.length > 0 ? (
            <section aria-labelledby="related-heading" className="mt-12">
              <h2 id="related-heading" className="font-display text-[22px] font-medium tracking-[-0.015em]">
                Related
              </h2>
              <ul className="mt-3 space-y-2 text-[16px]">
                {related.map((other) => (
                  <li key={other.slug}>
                    <a href={piecePath(other)} className="underline underline-offset-2">
                      {other.title}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="text-muted border-line mt-14 border-t pt-6 text-xs">
            First published {formatDate(piece.published)} · last reviewed {formatDate(piece.lastReviewed)} ·
            corrections to{" "}
            <a href={`mailto:${site.email}`} className="underline underline-offset-2">
              {site.email}
            </a>
          </p>
        </main>
      </div>
      <Footer />
    </>
  );
}

function Cites({ ids, numbers }: { ids: readonly string[] | undefined; numbers: Map<string, number> }) {
  if (!ids || ids.length === 0) return null;
  return (
    <sup className="text-muted ml-0.5 text-[0.7em]">
      {ids.map((id, index) => {
        const n = numbers.get(id);
        if (n === undefined) return null;
        return (
          <a key={id} href={`#source-${String(n)}`} aria-label={`Source ${String(n)}`} className="hover:text-ink">
            {index > 0 ? "," : ""}[{n}]
          </a>
        );
      })}
    </sup>
  );
}

function BlockView({ block, numbers }: { block: Block; numbers: Map<string, number> }) {
  switch (block.kind) {
    case "p":
      return (
        <p>
          <Inline text={block.text} />
          <Cites ids={block.cite} numbers={numbers} />
        </p>
      );
    case "h3":
      return <h3 className="font-display pt-2 text-[20px] font-medium tracking-[-0.01em]">{block.text}</h3>;
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <Inline text={item} />
        </li>
      ));
      return (
        <>
          {block.ordered ? (
            <ol className="list-decimal space-y-2 pl-6">{items}</ol>
          ) : (
            <ul className="list-disc space-y-2 pl-6">{items}</ul>
          )}
          {block.cite ? (
            <p className="text-muted text-[14px]">
              Sources: <Cites ids={block.cite} numbers={numbers} />
            </p>
          ) : null}
        </>
      );
    }
    case "table":
      return (
        <figure className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[560px] border-collapse text-left text-[14.5px] leading-[1.55]">
            <caption className="text-muted mb-2 text-left text-[14px]">
              <Inline text={block.caption} />
              <Cites ids={block.cite} numbers={numbers} />
            </caption>
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index} scope="col" className="border-line border-b py-2 pr-4 align-bottom font-semibold">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) =>
                    c === 0 ? (
                      <th key={c} scope="row" className="border-line border-b py-2 pr-4 align-top font-semibold">
                        <Inline text={cell} />
                      </th>
                    ) : (
                      <td key={c} className="border-line border-b py-2 pr-4 align-top">
                        <Inline text={cell} />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      );
    case "quote":
      return (
        <blockquote className="border-line-strong border-l-2 pl-4 italic">
          <Inline text={block.text} />
          <Cites ids={[block.cite]} numbers={numbers} />
        </blockquote>
      );
    case "note":
      return (
        <p className="border-line bg-paper-2 rounded-md border px-4 py-3 text-[15.5px]">
          <Inline text={block.text} />
        </p>
      );
  }
}

const KIND_LABEL: Record<Source["kind"], string> = {
  statute: "statute",
  regulation: "regulation",
  court: "court record",
  government: "government",
  "peer-reviewed": "peer-reviewed",
  association: "association",
  research: "research",
  vendor: "vendor data",
  news: "news",
  company: "healdesk",
};

function SourceItem({ source, number }: { source: Source; number: number }) {
  return (
    <li id={`source-${String(number)}`} className="scroll-mt-24">
      <span className="text-muted">[{number}]</span>{" "}
      <a href={source.url} rel="noopener" className="underline underline-offset-2">
        {source.title}
      </a>
      , {source.publisher} ({KIND_LABEL[source.kind]}), checked {formatDate(source.checked)}.
    </li>
  );
}
