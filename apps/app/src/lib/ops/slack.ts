import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { isCountKey } from "@/lib/email/lint";
import { opsAlertTitle, opsFieldLabel } from "@/lib/email/templates/ops_alert";
import { describeError, log } from "@/lib/log";

import { opsClinicName, opsConsoleLink, type OpsEvent } from "./notify";

/**
 * Ops alerts in Slack (owner decisions D1 and D2 of the ops automation plan,
 * 23 October 2026; designs E2 and E3).
 *
 * notifyOps records every alert in ops_alerts and emails it; this posts the
 * same alert to the owner's Slack channel through an Incoming Webhook, from
 * the worker's every-minute sweep, so the web tier, the worker and the voice
 * process need no Slack code and one alert is one post, however many
 * processes raised it. The webhook's address is SLACK_OPS_WEBHOOK_URL, a
 * secret in Parameter Store (infra/aws/ssm.tf); while it is unset, or still
 * the "__unset__" placeholder, Slack is simply off and the sweep touches no
 * row. apps/web's demo alerts use their own webhook on Vercel
 * (SLACK_WEBHOOK_URL), which this never reads.
 *
 * Slack signs no business associate agreement, so what it is sent is an
 * allow-list, built here and nowhere else: the alert's title (our fixed
 * wording) and event name, the clinic's name and id, the alert's counts, the
 * console link its email carries (opsConsoleLink), and nothing more. Never a patient, an address, a phone number, a conversation,
 * a notice or a request id, never free text; a field not on the list is left
 * out whatever it holds. The webhook's address is never logged or recorded:
 * a failure is kept as an HTTP status or an error's name.
 */

/** Read at use time. A value that is not a Slack Incoming Webhook is refused, never posted to. */
export function slackWebhookUrl(): string | null {
  const raw = process.env.SLACK_OPS_WEBHOOK_URL?.trim();
  if (!raw || raw === "__unset__") return null;
  return raw;
}

const WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{10,200}$/;

/** Only these reach Slack, besides the alert's title, its event and the clinic's name. */
const METERS: ReadonlySet<string> = new Set(["voice_minutes", "chat_conversations"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SlackAlert = {
  event: OpsEvent;
  fields: Readonly<Record<string, string | number | boolean | null>>;
  clinicName: string | null;
};

/** Slack's mrkdwn treats these three as control characters. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The fields Slack may carry, and nothing else: the clinic's id when it is a
 * uuid, the usage meter when it is one of the two, and every count that is a
 * finite, non-negative number. Exported for the test that holds it to that.
 */
export function slackFields(
  fields: Readonly<Record<string, unknown>>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "clinicId") {
      if (typeof value === "string" && UUID.test(value)) out.clinicId = value;
    } else if (key === "meter") {
      if (typeof value === "string" && METERS.has(value)) out.meter = value;
    } else if (isCountKey(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[key] = value;
    }
  }
  return out;
}

/** The message: one bold title line, then the clinic, then the counts. */
export function slackText(alert: SlackAlert): string {
  const fields = slackFields(alert.fields);
  const title = opsAlertTitle({ ...alert.fields, event: alert.event });
  const lines = [`*${escapeSlack(title)}*`];
  if (fields.clinicId) {
    const name = alert.clinicName ? `${escapeSlack(alert.clinicName)}, ` : "";
    lines.push(`${name}clinic id \`${fields.clinicId}\``);
  }
  const facts = Object.entries(fields)
    .filter(([key]) => key !== "clinicId")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${escapeSlack(opsFieldLabel(key))}: ${value}`);
  if (facts.length > 0) lines.push(facts.join(" · "));
  // The same console link the email carries (opsConsoleLink, decision D3).
  const link = opsConsoleLink(alert.event, fields);
  lines.push(link ? `_${alert.event}_ · <${link}|Open in the console>` : `_${alert.event}_`);
  return lines.join("\n");
}

export type SlackPostResult = { ok: true } | { ok: false; error: string };

const POST_TIMEOUT_MS = 5_000;

/** One post. Never throws; the error is a status or an error's name, never the address. */
export async function postToSlack(url: string, text: string): Promise<SlackPostResult> {
  if (!WEBHOOK.test(url)) {
    return { ok: false, error: "SLACK_OPS_WEBHOOK_URL is not a Slack Incoming Webhook address" };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      redirect: "error",
    });
    if (response.ok) return { ok: true };
    return { ok: false, error: `http ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : "unknown" };
  }
}

/**
 * Tries per alert, and the wait before each retry: 1, 5 and 30 minutes, so a
 * Slack outage of up to half an hour still delivers, and an alert Slack never
 * takes is given up after about 36 minutes. The email carried it anyway.
 */
export const SLACK_MAX_ATTEMPTS = 4;
const RETRY_AFTER_MS = [60_000, 5 * 60_000, 30 * 60_000];
/** How long a try holds its alert: longer than a batch of posts can take. */
const LEASE_MS = 2 * 60_000;
/**
 * Only alerts raised within this are posted, so pasting the key, or a
 * restore, never floods the channel with old alerts. Each is still in the
 * ops log and was emailed when raised.
 */
export const SLACK_LOOKBACK_MS = 24 * 60 * 60_000;
const BATCH = 10;

export type SlackSweepResult = { status: "ok" | "failed"; note: string };

/**
 * The `ops-slack` sweep: every minute from the worker's billing-minute clock,
 * and hourly from the tick as its backstop. Claims a batch of alerts owed to
 * Slack in one statement that also leases them (so two workers never post one
 * alert twice), posts each, and records the outcome on its row. Not a
 * switched job: the key is the switch.
 */
export async function runOpsSlackSweep(now: Date = new Date()): Promise<SlackSweepResult> {
  const url = slackWebhookUrl();
  if (!url) return { status: "ok", note: "Slack is off: SLACK_OPS_WEBHOOK_URL is not set." };

  const claimed = await unsafeDb.execute<{
    id: string;
    event: string;
    fields: Record<string, string | number | boolean | null>;
    slack_attempts: number;
    raised_at: Date | string;
  }>(sql`
    update ops_alerts
       set slack_attempts = slack_attempts + 1,
           slack_next_at = ${new Date(now.getTime() + LEASE_MS)}
     where id in (
       select id from ops_alerts
        where slack_posted_at is null
          and slack_attempts < ${SLACK_MAX_ATTEMPTS}
          and raised_at > ${new Date(now.getTime() - SLACK_LOOKBACK_MS)}
          and (slack_next_at is null or slack_next_at <= ${now})
        order by raised_at
        limit ${BATCH}
        for update skip locked
     )
    returning id, event, fields, slack_attempts, raised_at
  `);

  let posted = 0;
  let failed = 0;
  // Oldest first, as the channel should read: RETURNING keeps no order.
  const rows = [...claimed.rows].sort(
    (a, b) => new Date(a.raised_at).getTime() - new Date(b.raised_at).getTime(),
  );
  for (const row of rows) {
    const clinicName = await opsClinicName(row.fields.clinicId);
    const text = slackText({ event: row.event as OpsEvent, fields: row.fields, clinicName });
    const result = await postToSlack(url, text);
    try {
      if (result.ok) {
        posted += 1;
        await unsafeDb.execute(sql`
          update ops_alerts
             set slack_posted_at = ${now}, slack_error = null, slack_next_at = null
           where id = ${row.id}
        `);
      } else {
        failed += 1;
        const wait = RETRY_AFTER_MS[row.slack_attempts - 1];
        await unsafeDb.execute(sql`
          update ops_alerts
             set slack_error = ${result.error.slice(0, 200)},
                 slack_next_at = ${wait === undefined ? null : new Date(now.getTime() + wait)}
           where id = ${row.id}
        `);
        log.warn("ops alert not posted to Slack", {
          event: row.event,
          attempt: row.slack_attempts,
          reason: result.error,
        });
      }
    } catch (error) {
      // The lease runs out and the next minute's sweep tries again.
      log.warn("ops alert Slack outcome not recorded", { event: row.event, error: describeError(error) });
    }
  }

  const note = `${claimed.rows.length} claimed, ${posted} posted${failed ? `, ${failed} failed` : ""}`;
  return { status: failed > 0 && posted === 0 ? "failed" : "ok", note };
}
