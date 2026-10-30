import type { Metadata } from "next";

import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { HUB } from "@/lib/content/registry";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/about" },
  title: "About healdesk, and how we source what we publish",
  description:
    "What healdesk is, how its guides and research are sourced and checked, how corrections work, and the interest it has in the subjects it writes about.",
};

/**
 * Piece 1 of the strategy: who publishes the guides and research, how they
 * are sourced, and how to get one corrected. Every article's byline links to
 * #sourcing, so the anchor is load-bearing.
 *
 * The editor's name and biography go in "Who writes these pages?" once the
 * owner gives them; until then the page says how pages are prepared rather
 * than inventing a byline.
 */
const SECTIONS = [
  { id: "what", title: "What is healdesk?" },
  { id: "who", title: "Who writes these pages?" },
  { id: "sourcing", title: "How do we source what we publish?" },
  { id: "legal", title: "What are the legal pages, and what are they not?" },
  { id: "corrections", title: "How do we correct a mistake?" },
  { id: "interest", title: "What is our interest?" },
] as const;

export default function AboutPage() {
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-[760px] px-5 pt-16 pb-24 sm:px-8 sm:pt-20">
        <p className="eyebrow-tag">About</p>
        <h1 className="font-display mt-3 text-[clamp(var(--text-3xl),5vw,var(--text-5xl))] leading-[1.05] font-medium tracking-[-0.025em]">
          About {site.name}, and how we source what we publish
        </h1>

        <nav aria-label="On this page" className="mt-8">
          <ul className="text-muted space-y-1 text-sm">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="hover:text-ink underline-offset-2 hover:underline">
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-6 space-y-4 text-sm leading-[1.7] [&_h2]:font-display [&_h2]:mt-12 [&_h2]:scroll-mt-24 [&_h2]:text-2xl [&_h2]:leading-tight [&_h2]:font-medium [&_h2]:tracking-[-0.02em]">
          <h2 id="what">What is healdesk?</h2>
          <p>
            {site.entityDescription} It is sold to cash-pay elective clinics such as med spas, plastic surgery and
            fertility practices, and it works inbound only, so it never texts, calls or follows up with anyone first.
            We sign a business associate agreement and handle patient data under it. Prices are on the{" "}
            <a href="/pricing" className="underline underline-offset-2">
              pricing page
            </a>
            .
          </p>

          <h2 id="who">Who writes these pages?</h2>
          <p>
            Each page in our{" "}
            <a href={HUB.path} className="underline underline-offset-2">
              guides and research
            </a>{" "}
            is drafted with AI assistance from the sources it cites. Before a page goes live, a separate review
            checks every figure, quotation and statute on it against the source, and the page prints the date of
            that check at the top. A page that fails the check is corrected or held back.
          </p>

          <h2 id="sourcing">How do we source what we publish?</h2>
          <p>
            Every figure names its source and the year it describes, and links to the primary source rather than to
            a page that repeats it. Government, court and peer-reviewed findings are stated plainly, association
            figures are attributed, and vendor data is labelled as vendor data. A figure we cannot trace to a source
            is not used.
          </p>
          <p>
            Each page lists its sources at the end, with the date each one was last opened and its cited text found.
            Where the evidence is thin or contradictory, or a law is unsettled, the page says so instead of choosing
            an answer. Interpretation, where it cannot be avoided, is attributed to whoever made it.
          </p>

          <h2 id="legal">What are the legal pages, and what are they not?</h2>
          <p>
            Some pages describe statutes, regulations and court decisions on AI disclosure, call consent and health
            privacy. They quote and link the text itself, say whom each rule binds, and name the questions the text
            leaves open. They are not legal advice and do not say how a law applies to any one practice.
          </p>
          <p>
            As of 19 October 2026 these pages are checked against the primary texts by an independent AI review, not
            by a lawyer. Each says so in the notice at its top, and the notice will name a lawyer&rsquo;s review when
            one has taken place.
          </p>

          <h2 id="corrections">How do we correct a mistake?</h2>
          <p>
            Write to{" "}
            <a href={`mailto:${site.email}`} className="underline underline-offset-2">
              {site.email}
            </a>{" "}
            with the page and the sentence you think is wrong, and the source that says otherwise if you have one.
            When we find an error we fix the page, change its last-reviewed date, and reply to say what changed.
            Every tracker is rechecked against its sources at least once a month.
          </p>

          <h2 id="interest">What is our interest?</h2>
          <p>
            {site.name} sells an AI receptionist, so we have an interest in the subjects we write about. Our pages do
            not rank vendors or name a best one, and they mention {site.agent} only in a short closing note on how it
            handles the question. That note, and the line under each title, are where our interest is stated.
          </p>
          <p>
            The company that operates {site.name} is named in our{" "}
            <a href="/terms" className="underline underline-offset-2">
              terms
            </a>
            .
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}
