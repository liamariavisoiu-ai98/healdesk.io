import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { LIFECYCLE_DECISIONS } from "@/db/schema";
import { isCountKey } from "@/lib/email/lint";
import { opsAlertTitle, opsFieldLabel } from "@/lib/email/templates/ops_alert";
import { RECOMMENDATIONS } from "@/lib/lifecycle/recommend";
import { LIFECYCLE_ESCALATIONS } from "@/lib/lifecycle/waves";
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
 * processes raised it. The webhook's address is SLACK_WEBHOOK_URL, a
 * secret in Parameter Store (infra/aws/ssm.tf); while it is unset, or still
 * the "__unset__" placeholder, Slack is simply off and the sweep touches no
 * row. It is the same address as apps/web's SLACK_WEBHOOK_URL on Vercel,
 * the owner's #alerts channel (owner, 23 October 2026), so every post here
 * starts with SLACK_TAG, `[app]`, and apps/web's start with `[web]`
 * (apps/web lib/demo/alert.ts): the channel says which side spoke.
 *
 * Slack signs no business associate agreement, so what it is sent is an
 * allow-list, built here and nowhere else: the alert's title (our fixed
 * wording) and event name, the clinic's name and id, the alert's counts, the
 * console link its email carries (opsConsoleLink), and nothing more. Never a
 * patient, an address, a phone number, a conversation, a notice or a
 * request id, never free text; a field not on the list is left
 * out whatever it holds. The webhook's address is never logged or recorded:
 * a failure is kept as an HTTP status or an error's name.
 */

/** The first word of every post from apps/app; apps/web's start with `[web]`. */
export const SLACK_TAG = "[app]";

/** Read at use time. A value that is not a Slack Incoming Webhook is refused, never posted to. */
export function slackWebhookUrl(): string | null {
  const raw = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!raw || raw === "__unset__") return null;
  return raw;
}

const WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{10,200}$/;

/** Only these reach Slack, besides the alert's title, its event and the clinic's name. */
const METERS: ReadonlySet<string> = new Set(["voice_minutes", "chat_conversations"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The lifecycle watch's closed words (design E2): a setup's decision and the recommended action. */
const LIFECYCLE_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  decision: new Set(LIFECYCLE_DECISIONS),
  recommendation: new Set(RECOMMENDATIONS),
};

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
    } else if (Object.hasOwn(LIFECYCLE_WORDS, key)) {
      if (typeof value === "string" && LIFECYCLE_WORDS[key]!.has(value)) out[key] = value;
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
  const lines = [`${SLACK_TAG} *${escapeSlack(title)}*`];
  // A lifecycle escalation opens with a siren (design E2): the one a person must act on.
  if (LIFECYCLE_ESCALATIONS.has(alert.event)) lines[0] = `:rotating_light: ${lines[0]}`;
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

export type SlackPostResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /**
       * Slack is pushing back (429) or failing (5xx): the rest of the batch
       * waits rather than spending its tries against the same wall.
       */
      throttled: boolean;
      /** For a 429: how long Slack asked us to wait (Retry-After), bounded. */
      retryAfterMs?: number;
    };

const POST_TIMEOUT_MS = 5_000;
/** A Retry-After is honoured up to this, and taken as a minute when absent or unreadable. */
export const SLACK_MAX_RETRY_AFTER_MS = 10 * 60_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;

function retryAfterMs(header: string | null): number {
  const seconds = header === null ? NaN : Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(SLACK_MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1000));
}

/** One post. Never throws; the error is a status or an error's name, never the address. */
export async function postToSlack(url: string, text: string): Promise<SlackPostResult> {
  if (!WEBHOOK.test(url)) {
    return { ok: false, throttled: false, error: "SLACK_WEBHOOK_URL is not a Slack Incoming Webhook address" };
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
    if (response.status === 429) {
      return {
        ok: false,
        throttled: true,
        error: "http 429",
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
      };
    }
    return { ok: false, throttled: response.status >= 500, error: `http ${response.status}` };
  } catch (error) {
    return { ok: false, throttled: false, error: error instanceof Error ? error.name : "unknown" };
  }
}

/**
 * Tries per alert, and the wait before each retry: 1, 5 and 30 minutes, so a
 * Slack outage of up to half an hour still delivers, and an alert Slack never
 * takes is given up after about 36 minutes. The email carried it anyway. A
 * 429 is not a try: the alert waits as long as Slack asked (Retry-After, at
 * most SLACK_MAX_RETRY_AFTER_MS) and keeps its four.
 */
export const SLACK_MAX_ATTEMPTS = 4;
const RETRY_AFTER_MS = [60_000, 5 * 60_000, 30 * 60_000];
/**
 * How long a try holds its alert: longer than a batch of posts can take.
 * Counted from the database's clock (or `now`, when that is later), never
 * from a `now` the caller read earlier: the hourly tick used to reach this
 * sweep minutes after it started, and a lease counted from then could
 * already be over while the minute sweep, on the real clock, claimed the
 * same alert and posted it twice.
 */
const LEASE = "2 minutes";
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
 * alert twice: a row another sweep holds is skipped, and one it has leased
 * no longer matches), posts each, and records the outcome on its row. Not a
 * switched job: the key is the switch.
 *
 * Delivery is at least once, not exactly once: a post Slack took whose
 * outcome could not then be recorded (the database went away between the
 * two) is posted again when its lease runs out. A rare duplicate in #alerts
 * is the price of never losing an alert.
 */
export async function runOpsSlackSweep(now: Date = new Date()): Promise<SlackSweepResult> {
  const url = slackWebhookUrl();
  if (!url) return { status: "ok", note: "Slack is off: SLACK_WEBHOOK_URL is not set." };

  const claimed = await unsafeDb.execute<{
    id: string;
    event: string;
    fields: Record<string, string | number | boolean | null>;
    slack_attempts: number;
    raised_at: Date | string;
  }>(sql`
    update ops_alerts
       set slack_attempts = slack_attempts + 1,
           slack_next_at = greatest(clock_timestamp(), ${now}::timestamptz) + ${LEASE}::interval
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
  let held = 0;
  // Oldest first, as the channel should read: RETURNING keeps no order.
  const rows = [...claimed.rows].sort(
    (a, b) => new Date(a.raised_at).getTime() - new Date(b.raised_at).getTime(),
  );
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
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
        continue;
      }
      failed += 1;
      log.warn("ops alert not posted to Slack", {
        event: row.event,
        attempt: row.slack_attempts,
        reason: result.error,
      });
      if (result.retryAfterMs !== undefined) {
        // A 429 is not a try: the alert keeps it and waits as Slack asked.
        await unsafeDb.execute(sql`
          update ops_alerts
             set slack_attempts = greatest(slack_attempts - 1, 0),
                 slack_error = ${result.error},
                 slack_next_at = ${new Date(now.getTime() + result.retryAfterMs)}
           where id = ${row.id}
        `);
      } else {
        const wait = RETRY_AFTER_MS[row.slack_attempts - 1];
        await unsafeDb.execute(sql`
          update ops_alerts
             set slack_error = ${result.error.slice(0, 200)},
                 slack_next_at = ${wait === undefined ? null : new Date(now.getTime() + wait)}
           where id = ${row.id}
        `);
      }
      if (result.throttled) {
        // Slack is pushing back or down: the rest of the batch was never
        // tried, so each gets its claim's try back and waits with this one,
        // instead of spending all four of its tries against the same wall.
        const rest = rows.slice(index + 1).map((r) => r.id);
        if (rest.length > 0) {
          held = rest.length;
          const pause = result.retryAfterMs ?? RETRY_AFTER_MS[0]!;
          await unsafeDb.execute(sql`
            update ops_alerts
               set slack_attempts = greatest(slack_attempts - 1, 0),
                   slack_next_at = ${new Date(now.getTime() + pause)}
             where id in (${sql.join(
               rest.map((id) => sql`${id}::uuid`),
               sql`, `,
             )})
          `);
        }
        break;
      }
    } catch (error) {
      // The lease runs out and the next minute's sweep tries again.
      log.warn("ops alert Slack outcome not recorded", { event: row.event, error: describeError(error) });
    }
  }

  const note =
    `${claimed.rows.length} claimed, ${posted} posted` +
    (failed ? `, ${failed} failed` : "") +
    (held ? `, ${held} held while Slack pushes back` : "");
  return { status: failed > 0 && posted === 0 ? "failed" : "ok", note };
}
