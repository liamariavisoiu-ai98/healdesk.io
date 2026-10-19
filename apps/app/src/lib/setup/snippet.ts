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
 * ready.
 */

/** Where the widget's script is served, on the public origin. */
export const WIDGET_SCRIPT_PATH = "/widget/v1.js";

/** Whether the website-chat line may be shown: the channel is ready on our side. */
export function snippetOpen(web: Pick<ChannelState, "readyAt"> | undefined): boolean {
  return web !== undefined && web.readyAt !== null;
}

/** The line itself, for the clinic whose public slug is `slug`. */
export function widgetSnippet(slug: string): string {
  const safe = slug.replace(/[^a-z0-9-]/g, "");
  return `<script src="${publicUrl(WIDGET_SCRIPT_PATH)}" data-clinic="${safe}" async></script>`;
}
