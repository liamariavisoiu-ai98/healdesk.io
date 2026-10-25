import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { conversations, usageEvents } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { listClinics, type ClinicOverview } from "@/lib/ops/clinics";
import { withTenant } from "@/lib/tenant";

import { notifyDeadline, ownerNotifyDeadline } from "../incidents";
import { agreementReportDeadline, type ReportingRule } from "../reporting-rules";

import {
  channelsOf,
  isBatchClass,
  isScopeChannel,
  isScopeVendor,
  MAX_SCOPE_WINDOW_DAYS,
  type BatchClass,
  type ScopeChannel,
  type ScopeSource,
  type ScopeVendor,
} from "./vocab";

/**
 * `incidentScope` (design E6 §3 item 17): which clinics a vendor's incident,
 * or one of our channels', reached in a window, so the owner sees each
 * clinic's two clocks before anything is opened. Until now that mapping was
 * done by hand from the audit log (docs/incident-response.md, "Notices from
 * our vendors", point 3).
 *
 * A clinic is in scope when the service kept at least one conversation of a
 * channel the vendor carries (./vocab.ts VENDOR_CHANNELS) that started in
 * [from, to). Counted, never read: the count per channel is all that leaves
 * the clinic's tenant, with the clinic's id, name, agreement version and
 * covered-entity answer, which are the clinic's business data. Where each
 * count comes from:
 *
 *   - voice: `conversations` rows of channel `voice`, every call the voice
 *     ingest recorded, answered by AYA or passed through (each reached
 *     Retell);
 *   - web: `conversations` rows of channel `web_chat` or `web_form`;
 *   - meta: Meta keeps no conversation row (it carries nothing clinical),
 *     so the usage ledger's Meta conversations (usage_events, source `meta`,
 *     one row per conversation AYA was allowed to answer; kept under the
 *     account's billing clinic, by the location that answered), plus any
 *     `instagram_dm` or `whatsapp` conversation row. A Meta message AYA was
 *     not allowed to answer leaves no row past seven days, so it is not
 *     counted.
 *
 * healdesk's demo clinic is left out unless asked for (app_clinic_is_demo),
 * a destroyed clinic holds nothing to count, and a clinic whose rows could
 * not be read is counted in `unread` rather than silently dropped.
 *
 * When the class and the discovery time are given, each clinic also gets
 * both clocks as openIncident would stamp them: the internal 24-hour target
 * (never quoted to a clinic) and the agreement's own deadline, from the
 * version in effect, and the owner's 30-day clock for a breach at a clinic
 * that is not a covered entity.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

export type ScopeInput = {
  source: ScopeSource;
  value: ScopeVendor | ScopeChannel;
  from: Date;
  to: Date;
  incidentClass: BatchClass | null;
  discoveredAt: Date | null;
  includeDemo: boolean;
};

export type ScopeClocks = {
  /** Our own target, 24 hours from discovery: internal, never quoted to a clinic. */
  internalTarget: string;
  /** What the clinic's agreement promises. */
  agreementDeadline: string | null;
  agreementRule: ReportingRule;
  /** For a breach at a clinic that is not a covered entity: its own clock to tell the people affected. */
  ownerNoticeBy: string | null;
};

export type ScopeClinic = {
  clinicId: string;
  clinicName: string;
  /** The account's billing clinic for an added location; null for the account itself. */
  billingClinicId: string | null;
  conversations: Record<ScopeChannel, number>;
  total: number;
  agreementVersion: string | null;
  coveredEntity: boolean | null;
  demo: boolean;
  offboarding: boolean;
  clocks: ScopeClocks | null;
};

export type ScopeResult = {
  source: ScopeSource;
  value: ScopeVendor | ScopeChannel;
  channels: readonly ScopeChannel[];
  from: string;
  to: string;
  clinics: ScopeClinic[];
  /** Clinics read and found with nothing in the window. */
  clinicsWithNone: number;
  /** Clinics whose rows could not be read: the scope is incomplete while this is above 0. */
  unread: number;
};

/** The arguments, checked, or the one sentence saying what is wrong. */
export function readScopeArgs(args: Record<string, unknown>, now: Date = new Date()): ScopeInput | { problem: string } {
  const vendor = args.vendor;
  const channel = args.channel;
  if ((vendor === undefined) === (channel === undefined)) {
    return { problem: "Name a vendor or a channel, one of the two." };
  }
  let source: ScopeSource;
  let value: ScopeVendor | ScopeChannel;
  if (vendor !== undefined) {
    if (!isScopeVendor(vendor)) return { problem: "Pick the vendor from the list." };
    source = "vendor";
    value = vendor;
  } else {
    if (!isScopeChannel(channel)) return { problem: "Pick the channel from the list." };
    source = "channel";
    value = channel;
  }
  const from = instant(args.from);
  const to = instant(args.to);
  if (!from || !to) return { problem: "Give the window as two times, from and to." };
  if (from.getTime() >= to.getTime()) return { problem: "The window's start must come before its end." };
  if (to.getTime() > now.getTime() + 60_000) return { problem: "The window cannot end in the future." };
  if (to.getTime() - from.getTime() > MAX_SCOPE_WINDOW_DAYS * DAY_MS) {
    return { problem: `The window is at most ${MAX_SCOPE_WINDOW_DAYS} days.` };
  }
  let incidentClass: BatchClass | null = null;
  if (args.class !== undefined) {
    if (!isBatchClass(args.class)) {
      return { problem: "Pick the class from the list: a breach, a security incident or an improper use or disclosure." };
    }
    incidentClass = args.class;
  }
  let discoveredAt: Date | null = null;
  if (args.discoveredAt !== undefined) {
    discoveredAt = instant(args.discoveredAt);
    if (!discoveredAt || discoveredAt.getTime() > now.getTime() + 60_000) {
      return { problem: "When was it discovered? A past time." };
    }
    if (discoveredAt.getTime() < from.getTime()) return { problem: "It cannot have been discovered before the window began." };
  }
  if ((incidentClass === null) !== (discoveredAt === null)) {
    return { problem: "Give the class and the discovery time together, or neither." };
  }
  if (args.includeDemo !== undefined && typeof args.includeDemo !== "boolean") {
    return { problem: "includeDemo is true or false." };
  }
  return { source, value, from, to, incidentClass, discoveredAt, includeDemo: args.includeDemo === true };
}

function instant(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Both clocks for one clinic, as openIncident stamps them. */
export function clocksFor(
  cls: BatchClass,
  discoveredAt: Date,
  agreementVersion: string | null,
  coveredEntity: boolean | null,
): ScopeClocks {
  const agreement = agreementReportDeadline(cls, discoveredAt, agreementVersion);
  return {
    internalTarget: notifyDeadline(cls, discoveredAt, coveredEntity).toISOString(),
    agreementDeadline: agreement.notifyBy?.toISOString() ?? null,
    agreementRule: agreement.rule,
    ownerNoticeBy: ownerNotifyDeadline(cls, discoveredAt, coveredEntity)?.toISOString() ?? null,
  };
}

type Ctx = { actor: ActorContext; request?: RequestContext };

type ConversationChannel = (typeof conversations.$inferSelect)["channel"];
const VOICE_ROWS: readonly ConversationChannel[] = ["voice"];
const WEB_ROWS: readonly ConversationChannel[] = ["web_chat", "web_form"];
const META_ROWS: readonly ConversationChannel[] = ["instagram_dm", "whatsapp"];

async function countClinic(
  clinic: ClinicOverview,
  channels: readonly ScopeChannel[],
  from: Date,
  to: Date,
  ctx: Ctx,
): Promise<{ demo: boolean; counts: Record<ScopeChannel, number> }> {
  const counts: Record<ScopeChannel, number> = { voice: 0, web: 0, meta: 0 };
  const demo = await withTenant({ clinicId: clinic.id, actor: ctx.actor, request: ctx.request }, async (tx) => {
    const result = await tx.db.execute<{ demo: boolean }>(sql`select app_clinic_is_demo(${tx.clinicId}) as demo`);
    const rows = async (kinds: readonly ConversationChannel[]) => {
      const [row] = await tx.db
        .select({ n: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.clinicId, tx.clinicId),
            inArray(conversations.channel, [...kinds]),
            gte(conversations.startedAt, from),
            lt(conversations.startedAt, to),
          ),
        );
      return row?.n ?? 0;
    };
    if (channels.includes("voice")) counts.voice = await rows(VOICE_ROWS);
    if (channels.includes("web")) counts.web = await rows(WEB_ROWS);
    if (channels.includes("meta")) counts.meta = await rows(META_ROWS);
    return result.rows[0]?.demo === true;
  });
  if (channels.includes("meta")) {
    // The usage ledger is the account's: kept under its billing clinic, by
    // the location that answered (lib/reporting/claims.ts countHandled).
    const account = clinic.billingClinicId ?? clinic.id;
    counts.meta += await withTenant({ clinicId: account, actor: ctx.actor, request: ctx.request }, async (tx) => {
      const [row] = await tx.db
        .select({ n: count() })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.clinicId, tx.clinicId),
            eq(usageEvents.locationClinicId, clinic.id),
            eq(usageEvents.source, "meta"),
            gte(usageEvents.occurredAt, from),
            lt(usageEvents.occurredAt, to),
          ),
        );
      return row?.n ?? 0;
    });
  }
  return { demo, counts };
}

/** The scope, read now: every clinic with at least one conversation through the scope's channels in the window. */
export async function incidentScope(input: ScopeInput, ctx: Ctx): Promise<ScopeResult> {
  const channels = channelsOf(input.source, input.value);
  const result: ScopeResult = {
    source: input.source,
    value: input.value,
    channels,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    clinics: [],
    clinicsWithNone: 0,
    unread: 0,
  };
  for (const clinic of await listClinics()) {
    if (clinic.destroyedAt) continue;
    let read: { demo: boolean; counts: Record<ScopeChannel, number> };
    try {
      read = await countClinic(clinic, channels, input.from, input.to, ctx);
    } catch (error) {
      result.unread += 1;
      log.warn("incident scope: a clinic could not be read", { clinicId: clinic.id, error: describeError(error) });
      continue;
    }
    if (read.demo && !input.includeDemo) continue;
    const total = read.counts.voice + read.counts.web + read.counts.meta;
    if (total === 0) {
      result.clinicsWithNone += 1;
      continue;
    }
    result.clinics.push({
      clinicId: clinic.id,
      clinicName: clinic.name,
      billingClinicId: clinic.billingClinicId,
      conversations: read.counts,
      total,
      agreementVersion: clinic.baaVersion,
      coveredEntity: clinic.isCoveredEntity,
      demo: read.demo,
      offboarding: clinic.offboardingStartedAt !== null,
      clocks:
        input.incidentClass && input.discoveredAt
          ? clocksFor(input.incidentClass, input.discoveredAt, clinic.baaVersion, clinic.isCoveredEntity)
          : null,
    });
  }
  // The agreement's deadline first, so the clinic whose promise comes soonest leads.
  result.clinics.sort((a, b) => {
    const da = a.clocks?.agreementDeadline ?? "";
    const db = b.clocks?.agreementDeadline ?? "";
    return da === db ? b.total - a.total || a.clinicId.localeCompare(b.clinicId) : da.localeCompare(db);
  });
  return result;
}

/** The batch key a scope opens incidents under: one incident per clinic per key, ever. */
export function batchKey(input: {
  source: ScopeSource;
  value: ScopeVendor | ScopeChannel;
  from: Date;
  to: Date;
  incidentClass: BatchClass;
}): string {
  return `${input.source}:${input.value}:${input.from.toISOString()}:${input.to.toISOString()}:${input.incidentClass}`;
}
