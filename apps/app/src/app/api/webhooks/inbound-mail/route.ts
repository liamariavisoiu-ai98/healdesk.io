import { inboundMailWebhook } from "@/lib/support/inbound/webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/webhooks/inbound-mail: SES's receipt notices for support mail, from
 * SNS (infra/aws/ses-inbound.tf; ops automation lane P7g). POST only; the
 * whole of it is lib/support/inbound/webhook.ts, which says what it answers.
 * 404 while HEALDESK_INBOUND_MAIL_TOPIC_ARN is unset: the feature is off.
 */
export async function POST(request: Request): Promise<Response> {
  return inboundMailWebhook(request);
}
