import { CHANNELS, type Channel } from "@healdesk/catalog";
import { sql } from "drizzle-orm";

import type { Queryable } from "@/db";
import { platformCompliance, type PlatformComplianceRow } from "@/db/schema";
import { notifyOps } from "@/lib/ops/notify";

import {
  CHANNEL_SUBJECTS,
  CLINIC_WIDE_SUBJECTS,
  DOCUMENT_REF_MAX,
  isPlatformSubject,
  isVendorSubject,
  PLATFORM_SUBJECTS,
  type PlatformAction,
  type PlatformSubject,
} from "./subjects";

/**
 * The platform's attestations (platform_compliance, drizzle/0090): what an
 * operator has said is in place before any clinic answers a patient, read
 * by go-live (lib/onboarding/go-live.ts) and by each channel's `live`
 * (lib/channels/events.ts), and written from the ops envelope
 * (lib/ops/compliance-ops.ts) after apps/web has checked the operator's
 * fresh authenticator code.
 *
 * A subject counts while its latest row attests it and has not lapsed; the
 * database's app_platform_attested() says the same, and tests/go-live.test.ts
 * holds the two together. Platform-wide, ops-only, no patient data.
 */

export type PlatformEntry = {
  action: PlatformAction;
  documentRef: string;
  /** YYYY-MM-DD, UTC. */
  effectiveOn: string;
  /** YYYY-MM-DD, UTC, or null when it does not lapse. */
  expiresOn: string | null;
  actorLabel: string;
  recordedAt: Date;
};

export type PlatformSubjectStatus = {
  subject: PlatformSubject;
  attested: boolean;
  /** Attested, and past its expiry: no longer counts. */
  lapsed: boolean;
  latest: PlatformEntry | null;
};

export type PlatformStatus = Readonly<Record<PlatformSubject, PlatformSubjectStatus>>;

/** The UTC day of an instant, as the database's `(now() AT TIME ZONE 'UTC')::date`. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Pure: each subject's standing from its latest row. */
export function decidePlatform(
  latest: ReadonlyMap<PlatformSubject, PlatformEntry>,
  now: Date,
): PlatformStatus {
  const today = utcDay(now);
  const out = {} as Record<PlatformSubject, PlatformSubjectStatus>;
  for (const subject of PLATFORM_SUBJECTS) {
    const entry = latest.get(subject) ?? null;
    const attestedRow = entry?.action === "attested";
    const lapsed = attestedRow && entry.expiresOn !== null && entry.expiresOn < today;
    out[subject] = { subject, attested: attestedRow && !lapsed, lapsed, latest: entry };
  }
  return out;
}

/** Nothing attested: what a fresh deployment holds. */
export const NOTHING_ATTESTED: PlatformStatus = decidePlatform(new Map(), new Date(0));

function entryOf(
  row: Pick<
    PlatformComplianceRow,
    "action" | "documentRef" | "effectiveOn" | "expiresOn" | "actorLabel" | "recordedAt"
  >,
): PlatformEntry {
  return {
    action: row.action,
    documentRef: row.documentRef,
    effectiveOn: row.effectiveOn,
    expiresOn: row.expiresOn,
    actorLabel: row.actorLabel,
    recordedAt: row.recordedAt,
  };
}

/** Every subject's standing, from the latest row of each. Readable inside a tenant or outside one. */
export async function readPlatformCompliance(
  db: Queryable,
  now: Date = new Date(),
): Promise<PlatformStatus> {
  const result = await db.execute<{
    subject: string;
    action: PlatformAction;
    document_ref: string;
    effective_on: string;
    expires_on: string | null;
    actor_label: string;
    recorded_at: Date | string;
  }>(
    sql`select distinct on (subject) subject, action, document_ref, effective_on::text as effective_on,
               expires_on::text as expires_on, actor_label, recorded_at
          from platform_compliance
         order by subject, recorded_at desc, id desc`,
  );
  const latest = new Map<PlatformSubject, PlatformEntry>();
  for (const row of result.rows) {
    if (!isPlatformSubject(row.subject)) continue;
    latest.set(row.subject, {
      action: row.action,
      documentRef: row.document_ref,
      effectiveOn: row.effective_on,
      expiresOn: row.expires_on,
      actorLabel: row.actor_label,
      recordedAt: new Date(row.recorded_at),
    });
  }
  return decidePlatform(latest, now);
}

/** What a channel needs attested besides what every channel needs; for null, what every channel needs. */
export function subjectsFor(channel: Channel | null): readonly PlatformSubject[] {
  return channel === null ? CLINIC_WIDE_SUBJECTS : CHANNEL_SUBJECTS[channel];
}

/** The subjects in `subjectsFor(channel)` not attested now, in their order. */
export function platformMissing(
  status: PlatformStatus,
  channel: Channel | null,
): PlatformSubject[] {
  return subjectsFor(channel).filter((s) => !status[s].attested);
}

/** What every channel, and each channel, still waits on: the readiness facts carry it. */
export type PlatformMissing = {
  clinic: readonly PlatformSubject[];
  channel: Readonly<Record<Channel, readonly PlatformSubject[]>>;
};

export function platformMissingAll(status: PlatformStatus): PlatformMissing {
  const channel = {} as Record<Channel, PlatformSubject[]>;
  for (const c of CHANNELS) channel[c] = platformMissing(status, c);
  return { clinic: platformMissing(status, null), channel };
}

/** The operator's words for each subject: what it is, and what attesting it says. */
export const SUBJECT_WORDS: Readonly<
  Record<PlatformSubject, { label: string; attests: string; needs: string }>
> = {
  anthropic: {
    label: "Anthropic (the model provider)",
    attests:
      "Its business associate agreement is countersigned and in force for the organisation key AYA uses.",
    needs: "Every channel",
  },
  database_host: {
    label: "The database host",
    attests:
      "The database's host has a business associate agreement in force for the database AYA's data is in (RDS, under the AWS agreement, since 7 October 2026).",
    needs: "Every channel",
  },
  aws: {
    label: "AWS",
    attests:
      "The AWS account apps/app runs in is designated under the AWS business associate agreement (docs/policies/aws-hipaa-account.md).",
    needs: "Every channel",
  },
  retell: {
    label: "Retell (phone)",
    attests: "Retell's business associate agreement is countersigned and in force.",
    needs: "Phone",
  },
  launch_promises: {
    label: "Launch promises",
    attests:
      'Every item on the launch list at /admin/compliance#launch that blocks go-live is on (CLAUDE.md, "Copy first, then the switch"). The console refuses this while one is open.',
    needs: "Every channel",
  },
  runtime_web: {
    label: "Website chat's runtime",
    attests:
      "Website chat's API is deployed on the host and answered a synthetic clinic's chat there.",
    needs: "Website chat",
  },
  runtime_meta: {
    label: "The Meta runtime",
    attests:
      "The Meta webhooks and send adapters are deployed on the host and answered a synthetic clinic's message there.",
    needs: "Instagram, Messenger and WhatsApp",
  },
  runtime_voice: {
    label: "Phone's runtime",
    attests:
      "The Retell endpoint is on (enable_voice) with its secret, and took a test call on a synthetic clinic.",
    needs: "Phone",
  },
  voice_pass_through: {
    label: "Phone's pass-through test",
    attests:
      "With AYA off, a call to a synthetic clinic reached its direct line (Gate B: calls reach your direct line when AYA is off).",
    needs: "Phone",
  },
};

export class PlatformAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformAttestationError";
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function validDay(value: string | undefined | null): value is string {
  if (!value || !DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export type AttestationInput = {
  subject: unknown;
  action: PlatformAction;
  documentRef: unknown;
  effectiveOn: unknown;
  expiresOn?: unknown;
  actorLabel: string;
  now?: Date;
};

/**
 * Record an attestation, or the withdrawal of one, outside any tenant (the
 * table's trigger refuses one made inside). Validated here first so the
 * operator reads a sentence rather than a CHECK's name:
 *
 *   - a subject from the closed list;
 *   - a reference to the document, short and on one line, never its text;
 *   - the day it took effect, no later than today (UTC);
 *   - for an attestation, an optional expiry no earlier than today;
 *   - a withdrawal only of a subject attested now.
 *
 * Withdrawing never takes a live channel offline: a live channel is not asked
 * again. It holds back what has not gone live yet. Withdrawing a vendor's
 * agreement also stops AYA answering where that vendor serves, until a
 * renewed attestation (the answer gate, lib/compliance/vendor-coverage.ts),
 * and tells ops at once, to open an incident.
 */
export async function recordPlatformAttestation(
  db: Queryable,
  input: AttestationInput,
): Promise<{ subject: PlatformSubject; status: PlatformStatus }> {
  const now = input.now ?? new Date();
  const today = utcDay(now);
  if (!isPlatformSubject(input.subject)) {
    throw new PlatformAttestationError("That isn't something the platform attests.");
  }
  const subject = input.subject;
  const ref = typeof input.documentRef === "string" ? input.documentRef.trim() : "";
  if (!ref) {
    throw new PlatformAttestationError(
      input.action === "attested"
        ? "Say where the document is kept, or what the check was."
        : "Say why it no longer holds.",
    );
  }
  if (ref.length > DOCUMENT_REF_MAX || /[\u0000-\u001f\u007f]/.test(ref)) {
    throw new PlatformAttestationError(
      `Keep the reference to one line of at most ${DOCUMENT_REF_MAX} characters: where the document is, not the document.`,
    );
  }
  const effectiveOn = typeof input.effectiveOn === "string" ? input.effectiveOn : "";
  if (!validDay(effectiveOn) || effectiveOn > today || effectiveOn < "2020-01-01") {
    throw new PlatformAttestationError(
      "Give the day it took effect, as YYYY-MM-DD, no later than today (UTC).",
    );
  }
  let expiresOn: string | null = null;
  if (input.expiresOn !== undefined && input.expiresOn !== null && input.expiresOn !== "") {
    if (input.action !== "attested") {
      throw new PlatformAttestationError("A withdrawal has no expiry.");
    }
    const raw = typeof input.expiresOn === "string" ? input.expiresOn : "";
    if (!validDay(raw) || raw < today || raw < effectiveOn) {
      throw new PlatformAttestationError(
        "The expiry is a day, as YYYY-MM-DD, no earlier than today.",
      );
    }
    expiresOn = raw;
  }
  const before = await readPlatformCompliance(db, now);
  if (input.action === "withdrawn" && !before[subject].attested && !before[subject].lapsed) {
    throw new PlatformAttestationError("It isn't attested, so there is nothing to withdraw.");
  }
  await db.insert(platformCompliance).values({
    subject,
    action: input.action,
    documentRef: ref,
    effectiveOn,
    expiresOn,
    actorLabel: input.actorLabel.slice(0, 200),
  });
  // A vendor's agreement withdrawn while it counted: the answer gate stops
  // AYA where that vendor serves from now on, and ops opens an incident.
  if (input.action === "withdrawn" && before[subject].attested && isVendorSubject(subject)) {
    await notifyOps("vendor_agreement_lapsed", { code: subject, phase: "withdrawn" });
  }
  return { subject, status: await readPlatformCompliance(db, now) };
}

/** The newest rows, for the console's history. Ids, subjects, dates, references and the operator. */
export async function listPlatformHistory(
  db: Queryable,
  limit = 50,
): Promise<(PlatformEntry & { subject: PlatformSubject })[]> {
  const result = await db.execute<{
    subject: string;
    action: PlatformAction;
    document_ref: string;
    effective_on: string;
    expires_on: string | null;
    actor_label: string;
    recorded_at: Date | string;
  }>(
    sql`select subject, action, document_ref, effective_on::text as effective_on,
               expires_on::text as expires_on, actor_label, recorded_at
          from platform_compliance
         order by recorded_at desc, id desc
         limit ${Math.max(1, Math.min(limit, 200))}`,
  );
  return result.rows
    .filter((r) => isPlatformSubject(r.subject))
    .map((r) => ({
      subject: r.subject as PlatformSubject,
      ...entryOf({
        action: r.action,
        documentRef: r.document_ref,
        effectiveOn: r.effective_on,
        expiresOn: r.expires_on,
        actorLabel: r.actor_label,
        recordedAt: new Date(r.recorded_at),
      }),
    }));
}
