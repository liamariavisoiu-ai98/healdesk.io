"use client";

import { type MouseEvent } from "react";

import type { AgreementResult } from "./AgreementStep";

/**
 * The copy the buyer takes away, in whichever format we can actually produce.
 *
 * A PDF where one can be had, because a text file is a poor thing to hand a
 * clinic that may have to produce this for its own regulator, and the PDF
 * carries the version and the hash on every page.
 *
 * The text link it falls back to is not a lesser copy, it is the authority:
 * the same string the server hashed and recorded, which the PDF is only a
 * presentation of. That is why the click is intercepted at all. The last
 * screen before payment is the wrong place to discover that keeping your own
 * contract was a thing that could fail.
 *
 * Its own component, and exported, so that the fallback can be RENDERED in a
 * test rather than reasoned about. Every branch here is a branch nobody sees
 * until something upstream is already broken, which is the worst kind to leave
 * unproved.
 */
export function AgreementCopyLink({
  agreement,
  unavailable,
  pending,
  onPdfClick,
  label = "Download the copy you signed",
  fileStem = "healdesk-baa",
}: {
  agreement: AgreementResult | null;
  /** The PDF could not be produced or fetched. One-way; see CheckoutFlow. */
  unavailable: boolean;
  pending: boolean;
  onPdfClick: (event: MouseEvent<HTMLAnchorElement>, href: string, filename: string) => void;
  /** The link's words; Review and pay uses the compact "Download". */
  label?: string;
  /** The start of the file name, which says which agreement it is. */
  fileStem?: string;
}) {
  // The id is a reference, not a key: /api/agreement/pdf answers it only for
  // the browser holding the cookie that signing set. Pasting this URL anywhere
  // else gets a 401.
  const pdfHref = `/api/agreement/pdf?id=${encodeURIComponent(agreement?.agreementId ?? "")}`;
  const pdfName = `${fileStem}-${agreement?.version ?? "agreement"}.pdf`;
  const textHref = `data:text/plain;charset=utf-8,${encodeURIComponent(agreement?.text ?? "")}`;
  const textName = `${fileStem}-${agreement?.version ?? "agreement"}.txt`;
  // No id means nothing to ask the server for, so the link is the text from
  // the start rather than a PDF link that is certain to fail.
  const pdfOffered = Boolean(agreement?.agreementId) && !unavailable;

  return (
    <>
      {/* One anchor, not one per format. The href swaps; the element does not.
          A ternary around two <a> tags reads better and would have React tear
          the link down and build another, which drops focus to the top of the
          document at the exact moment a keyboard user has just activated it.
          Keeping the same node keeps the focus on it.

          It stays a real anchor with a real href in both formats, so Tab
          reaches it, Enter activates it, and the context menu, a middle-click
          and a cmd-click all still do what the browser says they do. */}
      <a
        href={pdfOffered ? pdfHref : textHref}
        download={pdfOffered ? pdfName : textName}
        onClick={pdfOffered ? (event) => onPdfClick(event, pdfHref, pdfName) : undefined}
        aria-busy={pending || undefined}
        className="text-red-deep inline-block py-1 text-xs font-bold underline underline-offset-4"
      >
        {pending ? "Preparing your copy…" : label}
      </a>

      {/* Said out loud, not just shown, and to a screen reader as well as to
          the screen. The link the buyer clicked has quietly become a different
          link, and a swap nobody is told about is how someone ends up clicking
          twice and trusting neither result.

          The sentence admits that the click produced NO FILE, says the link
          now gives text, and asks for the second press: `unavailable` is only
          ever set from a failed click, so at the moment this renders the
          buyer has asked for their agreement once and been given nothing.

          The region is always in the document, empty until it has something to
          say, because a live region is only announced when it was already
          there before its text arrived. Empty it renders no text and no
          margin, so it costs the layout nothing. */}
      <p
        role="status"
        aria-live="polite"
        className={unavailable ? "text-muted mt-2 w-full text-xs" : undefined}
      >
        {unavailable
          ? "We couldn't produce the PDF, so nothing was downloaded. Use the link again for the plain text version. It is word for word what you signed, and it is the copy we recorded."
          : null}
      </p>
    </>
  );
}

/**
 * The name the server gave this file, or the one the caller guessed.
 *
 * The download route sets `Content-Disposition` from the renderer's own
 * filename, `healdesk-baa-<version>-<date>.pdf`, built there from a filtered
 * alphabet. A browser following the link plainly would use exactly that name.
 * Intercepting the click is what makes our `download` attribute win instead,
 * so this is the one path on which the file the buyer keeps could be named
 * something the server did not choose. Reading the header back removes the
 * second opinion rather than trying to keep it in step.
 *
 * Same-origin, so the header is readable. Our own route already sanitised it,
 * and this narrows it again anyway: the value becomes a filesystem name, and a
 * download attribute is the wrong place to discover that the layer upstream
 * stopped filtering. Anything that does not survive as a `.pdf` falls back to
 * the caller's name rather than to something arbitrary.
 */
export function filenameFrom(disposition: string | null, fallback: string): string {
  const match = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition ?? "");
  const raw = (match?.[1] ?? match?.[2] ?? "").trim();
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.\-]+/, "")
    .slice(0, 120);
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : fallback;
}
