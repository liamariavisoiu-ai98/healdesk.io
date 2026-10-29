import { and, eq, inArray, sql } from "drizzle-orm";

import { channelEvents, clinicChannels } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { notifyOpsOnce } from "@/lib/ops/notify";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { evaluateChannelsSafely } from "./events";

/**
 * Website chat confirms its own line (WEBCHAT-2, owner's decisions of
 * 29 October 2026): the widget opened from a host of the clinic's own
 * website is a sighting, and two sightings at least SIGHTING_GAP_MINUTES
 * apart record `runtime_seen` by 'origin_seen', the clinic's step for
 * website chat (lib/channels/events.ts decideChannel). drizzle/0137's
 * app_web_widget_seen holds the rule and is the only writer: it re-checks
 * the host against the clinic's website, records the first sighting once,
 * and writes nothing for a sighting sooner than the gap, so a replay or a
 * flood costs a read and never a row.
 *
 * What a sighting is evidence of. A browser sets Origin itself, so no page
 * on another site can be seen as this clinic's: a hostile page is only ever
 * its own host, and the 403 in lib/chat/widget-http.ts refuses it first. A
 * script outside a browser that knows the public slug and the public website
 * can forge both opens; the owner accepted that (decision 1), because live
 * still waits on the audit, setup, the platform's attestations and go-live,
 * and billing starts at the first answer, not at live.
 *
 * The operator's "The line is on their website" (ops confirmWebWidget,
 * `confirmWidgetOnSite`) stays as the fallback and the override, and the
 * first sighting while the channel waits on its line still asks an operator
 * once (`web_widget_to_confirm`).
 *
 * Tenant plane: a host name, ids and times. Nothing from the visitor: the
 * widget's start request carries an empty body.
 */

/** The least time between the two opens that confirm the line; drizzle/0137 says the same. */
export const SIGHTING_GAP_MINUTES = 5;

/** What app_web_widget_seen did with one open, or `throttled` when this process skipped asking. */
export type SightingOutcome =
  | "first"
  | "too_soon"
  | "confirmed"
  | "already"
  | "not_waiting"
  | "wrong_host"
  | "throttled"
  | "failed";

const THROTTLE_MS = 60_000;
const lastAsked = new Map<string, number>();

/**
 * At most one question to the database per clinic a minute, in this process,
 * on top of the per-address limit in widget-http.ts: a flood of opens from
 * many addresses costs one read a minute. It can only delay a sighting by
 * a minute, never lose the confirmation, since the gap is five.
 */
export function sightingThrottled(clinicId: string, nowMs: number): boolean {
  const last = lastAsked.get(clinicId);
  if (last !== undefined && nowMs - last >= 0 && nowMs - last < THROTTLE_MS) return true;
  if (lastAsked.size > 10_000) lastAsked.clear();
  lastAsked.set(clinicId, nowMs);
  return false;
}

/** Tests only: forget every clinic's last question. */
export function __resetSightingThrottleForTests(): void {
  lastAsked.clear();
}

/**
 * One widget open from `host`, already checked by lib/chat/web-chat.ts
 * sightingHost. Records what the definer allows, moves website chat on when
 * the line is confirmed, and asks an operator once on a sighting that has
 * not confirmed it. Never throws: a failure here never costs the visitor
 * the chat's answer.
 */
export async function noteWidgetSighting(
  clinicId: string,
  host: string,
  input: { actor: ActorContext; now?: Date },
): Promise<SightingOutcome> {
  try {
    if (sightingThrottled(clinicId, (input.now ?? new Date()).getTime())) return "throttled";
    const { outcome, waitingOnLine } = await withTenant({ clinicId, actor: input.actor }, async (tx) => {
      const result = await tx.db.execute<{ outcome: string }>(
        sql`select app_web_widget_seen(${host}) as outcome`,
      );
      const outcome = (result.rows[0]?.outcome ?? "failed") as SightingOutcome;
      if (outcome === "confirmed") {
        tx.audit.record({
          action: "update",
          resourceType: "clinic_channel",
          resourceId: tx.clinicId,
          metadata: { channel: "web", input: "runtime_seen", via: "origin_seen", host },
        });
        await evaluateChannelsSafely(tx, { only: "web", actor: "system" });
      }
      return {
        outcome,
        waitingOnLine:
          (outcome === "first" || outcome === "too_soon") && (await waitsOnLine(tx)),
      };
    });
    if (waitingOnLine) await notifyOpsOnce("web_widget_to_confirm", { clinicId, channel: "web" });
    return outcome;
  } catch (error) {
    log.error("widget sighting not noted", { clinicId, channel: "web", error: describeError(error) });
    return "failed";
  }
}

async function waitsOnLine(tx: TenantTx): Promise<boolean> {
  const [row] = await tx.db
    .select({ liveAt: clinicChannels.liveAt, waitingOn: clinicChannels.waitingOn })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, "web")))
    .limit(1);
  return row !== undefined && row.liveAt === null && row.waitingOn === "snippet";
}

/** What the portal says about website chat's line: three states, in plain words. */
export type WidgetSighting =
  | { state: "waiting" }
  | { state: "seen"; host: string }
  | { state: "confirmed"; by: "sighting"; host: string }
  | { state: "confirmed"; by: "team" };

/** Read website chat's sighting state for the clinic in `tx`. */
export async function readWidgetSighting(tx: TenantTx): Promise<WidgetSighting> {
  const rows = await tx.db
    .select({ kind: channelEvents.kind, detail: channelEvents.detail })
    .from(channelEvents)
    .where(
      and(
        eq(channelEvents.clinicId, tx.clinicId),
        eq(channelEvents.channel, "web"),
        inArray(channelEvents.kind, ["widget_seen", "runtime_seen"]),
      ),
    );
  const hostOf = (kind: string): string | null => {
    const value = rows.find((r) => r.kind === kind)?.detail?.host;
    return typeof value === "string" ? value : null;
  };
  const confirmed = rows.find((r) => r.kind === "runtime_seen");
  if (confirmed) {
    // Either way satisfies website chat's step: the widget's own two opens
    // ('origin_seen') or an operator's tick ('ops_confirmed').
    const host = hostOf("runtime_seen");
    return confirmed.detail?.via === "origin_seen" && host
      ? { state: "confirmed", by: "sighting", host }
      : { state: "confirmed", by: "team" };
  }
  const seen = hostOf("widget_seen");
  return seen ? { state: "seen", host: seen } : { state: "waiting" };
}

/** The portal's sentence for each state, under the line to paste. */
export function sightingLine(sighting: WidgetSighting): string {
  switch (sighting.state) {
    case "waiting":
      return `We haven't seen the chat on your website yet. Once the line is in, open your website and click the chat bubble, then click it again at least ${SIGHTING_GAP_MINUTES} minutes later. Until then, the bubble asks visitors to call you.`;
    case "seen":
      return `We saw the chat on ${sighting.host}. Click the chat bubble there once more, at least ${SIGHTING_GAP_MINUTES} minutes after the first time, to finish. Until then, the bubble asks visitors to call you.`;
    case "confirmed":
      return sighting.by === "sighting"
        ? `Done: we saw the chat on ${sighting.host}.`
        : "Done: our team confirmed the chat is on your website.";
  }
}
