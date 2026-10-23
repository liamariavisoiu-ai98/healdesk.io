/**
 * Tell the team something happened, in the internal channel.
 *
 * A Slack incoming webhook when `SLACK_WEBHOOK_URL` is set, and the server log
 * either way. Best effort and never throws: an alert must not fail the
 * Stripe webhook that triggered it, which Stripe would then retry for three
 * days.
 *
 * Business events only (a demo claimed, a build failed): a clinic's name, a
 * plan, a link to the console. Never anything a patient said, which this
 * side of the boundary never holds anyway.
 *
 * The same #alerts address is held by apps/app on AWS, which posts its ops
 * alerts there too (owner, 23 October 2026), so every post from here starts
 * with SLACK_TAG, `[web]`, and apps/app's with `[app]`.
 */
export const SLACK_TAG = "[web]";

export async function postInternalAlert(text: string): Promise<void> {
  console.info("[healdesk] internal alert", { text });
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  if (!url.startsWith("https://hooks.slack.com/")) {
    console.error("[healdesk] SLACK_WEBHOOK_URL is not a Slack incoming-webhook URL; alert not posted");
    return;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${SLACK_TAG} ${text}` }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) console.error("[healdesk] slack alert failed", { status: response.status });
  } catch (error) {
    console.error("[healdesk] slack alert failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
