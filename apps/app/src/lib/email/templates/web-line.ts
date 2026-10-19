import { snippetLineFor } from "@/lib/setup/snippet";

import type { Block } from "./compose";

/**
 * The website-chat line an email carries (O10 to the clinic, O11 to its web
 * person): the one line the clinic pastes, exactly as the wizard and
 * Settings → Channels print it (lib/setup/snippet.ts), so an email can never
 * hand anyone a line the screens would not.
 *
 * Stored as its two parts, never as the line: the payload allowlist (Annex
 * X4) takes a URL on our public origin and an id, and no free text, so the
 * line is built here from what was stored and a retry renders the same bytes.
 * Business data only: the clinic's public slug and the script's address,
 * both on every page the line is pasted into.
 */

export type WebLineFields = {
  /** lib/setup/snippet.ts widgetScriptUrl(): the widget's script, on the public origin. */
  scriptUrl: string;
  /** The clinic's public slug, which the line names it by. */
  clinicSlug: string;
};

/** Where the line goes, in the words the screens use. */
export const PASTE_WHERE = "just before </body>, on every page";

export function webLineBlock(fields: WebLineFields): Block {
  return { type: "code", text: snippetLineFor(fields.scriptUrl, fields.clinicSlug) };
}
