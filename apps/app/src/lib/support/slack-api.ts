/**
 * Slack's Web API, for support replies only (ops automation Phase 7, lane
 * P7i; the owner's decision of 26 October 2026: "Show the draft reply text
 * in Slack so I can read and approve it there with the passcode. I accept
 * that Slack has no BAA.").
 *
 * The ops alerts' Incoming Webhook (lib/ops/slack.ts) cannot open a dialog
 * or edit a message it posted, so support replies use a Slack app's bot
 * token instead. Four values, all in Parameter Store (infra/aws/ssm.tf),
 * read at use time:
 *
 *   SLACK_BOT_TOKEN       the app's bot token (xoxb-…), scope chat:write;
 *   SLACK_SIGNING_SECRET  the app's signing secret: every request Slack
 *                         sends to /api/webhooks/slack is checked with it;
 *   SLACK_SUPPORT_CHANNEL the channel id (C…) the replies are posted to,
 *                         with the bot invited;
 *   SLACK_OPERATOR_IDS    the Slack user ids (U…, comma separated) allowed
 *                         to press a button; anyone else is refused.
 *
 * All four set (and well formed): on. Any one missing: off, nothing is
 * posted, the route answers 404, and the console works as before. Neither
 * the token nor the secret is ever logged or recorded: a failure is kept as
 * Slack's error code or an HTTP status.
 */

const UNSET = "__unset__";

function setting(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw && raw !== UNSET ? raw : null;
}

const TOKEN = /^xoxb-[A-Za-z0-9-]{10,250}$/;
const CHANNEL = /^[CG][A-Z0-9]{2,30}$/;
const USER = /^[UW][A-Z0-9]{2,30}$/;
const SECRET = /^[A-Za-z0-9]{16,128}$/;

export type SlackSupportConfig = {
  token: string;
  signingSecret: string;
  channel: string;
  operators: ReadonlySet<string>;
};

/** The operator ids, or null when the list is empty or any entry is not a Slack user id. */
export function parseOperatorIds(raw: string | null): ReadonlySet<string> | null {
  if (!raw) return null;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0 || ids.length > 20 || !ids.every((id) => USER.test(id))) return null;
  return new Set(ids);
}

/** The feature's settings, or null when it is off (any one missing or malformed). */
export function slackSupportConfig(): SlackSupportConfig | null {
  const token = setting("SLACK_BOT_TOKEN");
  const signingSecret = setting("SLACK_SIGNING_SECRET");
  const channel = setting("SLACK_SUPPORT_CHANNEL");
  const operators = parseOperatorIds(setting("SLACK_OPERATOR_IDS"));
  if (!token || !TOKEN.test(token)) return null;
  if (!signingSecret || !SECRET.test(signingSecret)) return null;
  if (!channel || !CHANNEL.test(channel)) return null;
  if (!operators) return null;
  return { token, signingSecret, channel, operators };
}

export type SlackApiResult =
  | { ok: true; ts?: string; channel?: string }
  | { ok: false; error: string; retryAfterMs?: number };

const API = "https://slack.com/api/";
const TIMEOUT_MS = 2_500;

/** Slack's error codes are lower-case words; anything else becomes a closed word. */
function errorWord(raw: unknown): string {
  return typeof raw === "string" && /^[a-z0-9_]{1,80}$/.test(raw) ? raw : "slack_error";
}

/**
 * One Web API call. Never throws; the answer is Slack's `ok`, the message's
 * ts and channel, or Slack's error code (an HTTP status, or the error's name,
 * when there is no answer). The timeout is short: views.open must land
 * within Slack's three seconds of the click.
 */
export async function slackApi(
  method: "chat.postMessage" | "chat.update" | "views.open" | "chat.postEphemeral",
  token: string,
  body: Record<string, unknown>,
): Promise<SlackApiResult> {
  try {
    const response = await fetch(`${API}${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      return { ok: false, error: "http 429", retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) * 1000 : 60_000 };
    }
    if (!response.ok) return { ok: false, error: `http ${response.status}` };
    const data = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown; ts?: unknown; channel?: unknown } | null;
    if (!data || data.ok !== true) return { ok: false, error: errorWord(data?.error) };
    return {
      ok: true,
      ...(typeof data.ts === "string" ? { ts: data.ts } : {}),
      ...(typeof data.channel === "string" ? { channel: data.channel } : {}),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60) || "unknown" : "unknown" };
  }
}
