import { Fragment } from "react";

import { livePieces, piecePath } from "@/lib/content/registry";
import { PUBLIC_ROUTES } from "@/lib/seo";

/**
 * Content strings carry one kind of markup, `[label](href)`, and this turns
 * it into links. Anything else is text: house style puts no emphasis inside
 * sentences, so there is nothing else to parse.
 *
 * Links to other sites open in the same tab with `rel="noopener"`; a page that
 * cites a statute is read beside it, and a new tab per citation is clutter.
 *
 * A link to a page on this site that is not public (a piece still in draft or
 * audit) is printed as its label alone. Pieces link to each other freely, and
 * this is what keeps one held back by its audit from leaving a 404 in every
 * page that mentions it.
 */
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

export function Inline({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const [whole, label = "", href = ""] = match;
    const at = match.index;
    if (at > last) parts.push(text.slice(last, at));
    const external = /^https?:\/\//.test(href);
    if (!external && !isPublicPath(href)) {
      parts.push(label);
      last = at + whole.length;
      continue;
    }
    parts.push(
      <a
        key={`${String(at)}-${href}`}
        href={href}
        rel={external ? "noopener" : undefined}
        className="decoration-line-strong hover:decoration-ink underline underline-offset-2"
      >
        {label}
      </a>,
    );
    last = at + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts.map((part, i) => (typeof part === "string" ? <Fragment key={i}>{part}</Fragment> : part))}</>;
}

/** Whether an on-site href leads to a public page: a fixed route or a live piece. */
export function isPublicPath(href: string): boolean {
  if (/^(?:mailto:|tel:|#)/.test(href)) return true;
  const path = href.split("#")[0]?.split("?")[0] ?? "";
  if (path === "") return true;
  const normalised = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return (
    PUBLIC_ROUTES.some((route) => route.path === normalised) ||
    livePieces().some((piece) => piecePath(piece) === normalised)
  );
}

/** The same string as plain text: labels kept, hrefs dropped. For meta tags and llms.txt. */
export function plain(text: string): string {
  return text.replace(LINK, "$1");
}
