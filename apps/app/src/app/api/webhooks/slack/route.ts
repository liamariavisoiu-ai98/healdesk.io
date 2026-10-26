import { slackInteractionWebhook } from "@/lib/support/slack-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/webhooks/slack: the Slack app's interactivity URL, for the buttons
 * and dialogs of a support reply's message (lane P7i). POST only; the whole
 * of it is lib/support/slack-actions.ts, which checks Slack's signature and
 * says what it answers. 404 while a SLACK_ setting is missing: the feature
 * is off.
 */
export async function POST(request: Request): Promise<Response> {
  return slackInteractionWebhook(request);
}
