import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { SETTING_CHANGE_LABELS, SETTING_ENTRIES } from "@/lib/clinic/setting-words";
import { describeError, log } from "@/lib/log";
import type { ActionStatus } from "@/lib/support/actions/tiers";

import { alertWording } from "./alert-wording";
import { allowedAlertFields, wordingValues } from "./alert-wording/allow-list";
import { sharedFacts } from "./alert-wording/facts";
import { parseMarkup, plainText, toSlack } from "./alert-wording/markup";
import { layoutAlert } from "./alert-wording/render";
import { consoleLinkLabel } from "./alert-wording/tabs";
import { URGENCY_LOOK } from "./alert-wording/urgency";
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
 * allow-list (lib/ops/alert-wording/allow-list.ts, the one the wording's
 * placeholders draw from too): the alert's wording, filled from the
 * allow-listed values by the same function the email uses, so Slack carries
 * the same full text and every numbered step (owner, 23 October 2026, lane
 * N1); the event name; the clinic's name and id, or a setup requester's
 * business name; the alert's counts and closed words; the console link its
 * email carries (opsConsoleLink), and nothing more. Never a patient, an
 * address, a phone number, a conversation, a notice or a request id, never
 * free text; a field not on the list is left out whatever it holds. The webhook's address is never logged or recorded:
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

export type SlackAlert = {
  event: OpsEvent;
  fields: Readonly<Record<string, string | number | boolean | null>>;
  clinicName: string | null;
  /** The alert's ops_alerts row id: the anchor in its console link. */
  alertId?: string | null;
};

/** Slack's mrkdwn treats these three as control characters. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A clinic's or a business's name as Slack may print it: mrkdwn has no
 * escape for its formatting characters, so `*`, `_`, `~` and backticks in a
 * name become spaces rather than bold, italic, struck or code text.
 */
export function slackName(name: string): string {
  return name.replace(/[*_~`]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The fields Slack may carry, and nothing else (lib/ops/alert-wording/allow-list.ts).
 * Exported for the test that holds it to that.
 */
export const slackFields = allowedAlertFields;

/** Slack refuses a section block's text over this many characters. */
export const SLACK_SECTION_MAX = 3000;

/** Between the part read first and the detail: a line Slack shows as a rule. */
export const SLACK_DIVIDER = "——————————";

/**
 * The message as groups of lines, in order (lane N4: an alert scanned in
 * three seconds): the urgency's emoji, the tag and the headline in bold;
 * "Do this first:" with step 1 and the console link; a divider; then the
 * detail: the rest of what happened, who it is about, the facts, why it
 * matters, the remaining steps numbered from 2, and the event's code. Every
 * line is escaped mrkdwn; emphasis comes from the same markup the email
 * parses (lib/ops/alert-wording/markup.ts), bold here for all three kinds.
 */
function slackGroups(alert: SlackAlert): string[][] {
  const fields = slackFields(alert.fields);
  const clinicName = alert.clinicName ? slackName(alert.clinicName) || null : null;
  const business = typeof fields.business === "string" ? slackName(fields.business) : null;
  const named = { ...alert.fields, ...(business !== null ? { business } : {}) };
  const raw = alertWording(alert.event, alert.fields);
  const layout = layoutAlert(raw, wordingValues(named, clinicName));
  const look = URGENCY_LOOK[layout.urgency];
  const rich = (text: string) => toSlack(parseMarkup(text), escapeSlack);
  // The same console link the email carries (opsConsoleLink, decision D3).
  const link = opsConsoleLink(alert.event, fields, alert.alertId);

  const top = [`${look.emoji} ${SLACK_TAG} *${escapeSlack(plainText(layout.headline))}*`];
  if (layout.doFirst) top.push(`*Do this first:* ${rich(layout.doFirst)}`);
  if (link) top.push(`<${link}|${escapeSlack(consoleLinkLabel(link))}>`);

  const detail: string[] = [];
  if (layout.detail) detail.push(rich(layout.detail));
  if (fields.clinicId) {
    const name = clinicName ? `${escapeSlack(clinicName)}, ` : "";
    detail.push(`${name}clinic id \`${fields.clinicId}\``);
  } else if (business) {
    detail.push(`Business: ${escapeSlack(business)}`);
  }
  // The same facts the email prints (lib/ops/alert-wording/facts.ts).
  const facts = sharedFacts(alert.fields, raw).map(([label, value]) => `${escapeSlack(label)}: ${escapeSlack(slackName(value))}`);
  if (facts.length > 0) detail.push(facts.join(" · "));
  if (layout.whyItMatters) detail.push(`*Why it matters:* ${rich(layout.whyItMatters)}`);

  const then = layout.then.length > 0 ? ["*Then:*", ...layout.then.map((step, i) => `${i + 2}. ${rich(step)}`)] : [];
  return [top, [SLACK_DIVIDER], detail, then, [`_${alert.event}_`]].filter((group) => group.length > 0);
}

// -----------------------------------------------------------------------------
// The support reply's proposed change (lane D): closed words only
// -----------------------------------------------------------------------------

/**
 * The lead of the one line a support reply's Slack message
 * (lib/support/slack-reply.ts) may add about the Settings change its draft
 * proposed, by where the change stands. Fixed words.
 */
export const SUPPORT_ACTION_SLACK_LEADS: Readonly<Record<ActionStatus, string>> = {
  pending: ":gear: Proposed change, made when you approve:",
  running: ":hourglass_flowing_sand: Change being made:",
  done: ":white_check_mark: Change made:",
  already: ":white_circle: Already set, nothing to change:",
  refused: ":x: Change not made:",
  unavailable: ":x: Change not made:",
  not_run: ":x: Change not made:",
};

/**
 * That line, on the allow-list: the lead for its status, the switch's label
 * (lib/clinic/setting-words.ts SETTING_CHANGE_LABELS) and the value as on,
 * off or the choice's own label. Anything else (a label or a value not on
 * those lists, a reason, the clinic's email) is refused: null, no line.
 */
export function supportActionSlackLine(action: { label: string; value: string; status: string } | null): string | null {
  if (!action) return null;
  const lead = (SUPPORT_ACTION_SLACK_LEADS as Readonly<Record<string, string>>)[action.status];
  if (!lead) return null;
  if (!Object.values(SETTING_CHANGE_LABELS).includes(action.label)) return null;
  const values = new Set(["on", "off", ...Object.values(SETTING_ENTRIES).flatMap((e) => (e.options ?? []).map((o) => o.label))]);
  if (!values.has(action.value)) return null;
  return `${lead} *${escapeSlack(slackName(action.label))}* → *${escapeSlack(slackName(action.value))}*`;
}

/** The whole message as one mrkdwn text: the post's `text`, and its notification. */
export function slackText(alert: SlackAlert): string {
  return slackGroups(alert).flat().join("\n");
}

type SectionBlock = { type: "section"; text: { type: "mrkdwn"; text: string } };

/**
 * Lines packed into sections of at most SLACK_SECTION_MAX characters, never
 * splitting a line that fits in one; a line longer than a whole section (no
 * wording has one) is split at spaces across sections, never cut short.
 */
export function packSections(lines: readonly string[], max = SLACK_SECTION_MAX): string[] {
  const pieces: string[] = [];
  for (const line of lines) {
    if (line.length <= max) {
      pieces.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > max) {
      const space = rest.lastIndexOf(" ", max);
      const at = space > 0 ? space : max;
      pieces.push(rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    if (rest) pieces.push(rest);
  }
  const sections: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const next = current ? `${current}\n${piece}` : piece;
    if (next.length <= max) current = next;
    else {
      sections.push(current);
      current = piece;
    }
  }
  if (current) sections.push(current);
  return sections;
}

/** The post's body: the full text, and the same text as section blocks within Slack's limit. */
export function slackPayload(alert: SlackAlert): { text: string; blocks: SectionBlock[] } {
  const groups = slackGroups(alert);
  const blocks = groups.flatMap((group) =>
    packSections(group).map((text): SectionBlock => ({ type: "section", text: { type: "mrkdwn", text } })),
  );
  return { text: slackText(alert), blocks };
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
export async function postToSlack(
  url: string,
  message: string | { text: string; blocks?: readonly unknown[] },
): Promise<SlackPostResult> {
  if (!WEBHOOK.test(url)) {
    return { ok: false, throttled: false, error: "SLACK_WEBHOOK_URL is not a Slack Incoming Webhook address" };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(typeof message === "string" ? { text: message } : message),
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

/**
 * Alerts that are never posted to Slack. The weekly compliance pack's
 * pointer is for the owner only (owner decision D20; lib/compliance-pack/
 * job.ts): it goes to the ops address by email and nowhere else.
 */
export const SLACK_EXCLUDED_EVENTS: readonly string[] = ["compliance_pack_ready"];

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
          and event not in (${sql.join(SLACK_EXCLUDED_EVENTS.map((e) => sql`${e}`), sql`, `)})
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
    const message = slackPayload({ event: row.event as OpsEvent, fields: row.fields, clinicName, alertId: row.id });
    const result = await postToSlack(url, message);
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
