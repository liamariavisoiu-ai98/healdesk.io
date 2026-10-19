import type { ChannelState } from "@/lib/channels/state";
import { publicUrl } from "@/lib/public-url";

/**
 * The one line a clinic pastes on its website for website chat (spec,
 * "Web chat": "a script tag on the clinic's site"; "The embed snippet is
 * shown on screen, emailed, and available in the dashboard forever. It is
 * one line.").
 *
 * The script is static and may be served from anywhere (CLAUDE.md, the PHI
 * boundary); every request carrying a visitor's words goes to this app's
 * /api/widget/v1/<slug>/*, which answers only the clinic's own website's
 * origin (lib/chat/widget-http.ts). The line names the clinic by its public
 * slug, the same name those routes take, and the script by WIDGET_SCRIPT_PATH
 * on the public origin, so it never names the internal one.
 *
 * Shown once the channel is open: ready on our side (`ready_at`), so a
 * clinic never pastes a line that loads nothing. The widget's script is the
 * runtime's to serve at WIDGET_SCRIPT_PATH before any web channel is marked
 * ready. From then on it is in the wizard's channel step and in Settings →
 * Channels for good (app/c/[slug]/WebsiteLinePanel.tsx), emailed to the
 * clinic an hour later if still not on its site (O10), and sent on to its
 * web person when asked (O11), each from the same parts.
 */

/** Where the widget's script is served, on the public origin. */
export const WIDGET_SCRIPT_PATH = "/widget/v1.js";

/** Whether the website-chat line may be shown: the channel is ready on our side. */
export function snippetOpen(web: Pick<ChannelState, "readyAt"> | undefined): boolean {
  return web !== undefined && web.readyAt !== null;
}

/** The widget's script on the public origin: what the line loads. */
export function widgetScriptUrl(): string {
  return publicUrl(WIDGET_SCRIPT_PATH);
}

/** The line itself, for the clinic whose public slug is `slug`. */
export function widgetSnippet(slug: string): string {
  return snippetLineFor(widgetScriptUrl(), slug);
}

/**
 * The line from its two parts, for an email that stores them (O10 and O11,
 * lib/email/templates/web-line.ts) rather than the line: the same words as
 * the screens print, from the payload alone. The URL passes through the URL
 * parser, so no quote in it can end the attribute early.
 */
export function snippetLineFor(scriptUrl: string, slug: string): string {
  const safe = slug.replace(/[^a-z0-9-]/g, "");
  return `<script src="${new URL(scriptUrl).href}" data-clinic="${safe}" async></script>`;
}
