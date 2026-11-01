/**
 * What the "Add from a file" card and the server share (portal redesign,
 * owner, 1 November 2026): the limits, the request's header and the words
 * for each refusal. No imports, so the card can load it in the browser.
 */

/** The owner's limits (1 November 2026). 4 MB stays under the TLS proxy's 4 MiB body limit (infra/aws/images/tls-proxy). */
export const FILE_LIMITS = {
  maxBytes: 4_000_000,
  maxPages: 20,
  perDay: 10,
} as const;

/** The header the card sends, which a form on another site cannot send without a preflight the route never answers. */
export const FILE_HEADER = "x-healdesk-file";

/** Why a file was not read, in the clinic's words. */
export type FileRefusal =
  | "too_big"
  | "empty"
  | "wrong_type"
  | "too_many_pages"
  | "daily_limit"
  | "unavailable"
  | "unreadable"
  | "nothing_found";

export const FILE_REFUSAL_WORDS: Readonly<Record<FileRefusal, string>> = {
  too_big: "That file is over 4 MB. Try a smaller one, or a photo of the page.",
  empty: "That file is empty.",
  wrong_type: "Use a PDF, or a JPG or PNG photo.",
  too_many_pages: `That file has more than ${FILE_LIMITS.maxPages} pages. Try just the pages with your prices or information.`,
  daily_limit: `That's ${FILE_LIMITS.perDay} files today. You can add more tomorrow.`,
  unavailable: "Reading files isn't available right now. Try again later, or type it in below.",
  unreadable: "AYA couldn't read that file. Try a clearer copy, or type it in below.",
  nothing_found: "AYA found no prices, hours, policies or answers in that file.",
};

