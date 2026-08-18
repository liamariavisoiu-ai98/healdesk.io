import type { Queryable, Transaction } from "@/db";
import { auditLog, securityEvents } from "@/db/schema";

/**
 * Audit logging.
 *
 * HIPAA §164.312(b) requires recording every PHI access — reads included, not
 * just writes. That is the requirement people skip, and it is the first thing
 * an auditor asks for.
 *
 * Two rules shape this file:
 *
 *   1. **Never log PHI to record that PHI was accessed.** An audit trail that
 *      itself leaks patient data is worse than none. assertNoPhi() enforces
 *      this at runtime rather than trusting reviewers to catch it.
 *   2. **A bulk read is one row, not N.** Listing 400 contacts records one
 *      entry with a capped id list and a count. Otherwise the audit log grows
 *      faster than the data it describes and becomes unreadable.
 */

/** Beyond this, we store the count and a truncation marker instead of every id. */
export const MAX_AUDITED_IDS = 50;

/**
 * Keys that must never appear in audit metadata. Not exhaustive — it can't be —
 * but it catches the mistakes people actually make when adding "just a bit of
 * context" to a log line.
 */
const PHI_KEY_DENYLIST = new Set([
  "phone",
  "phonenumber",
  "email",
  "fullname",
  "firstname",
  "lastname",
  "name",
  "dob",
  "dateofbirth",
  "birthdate",
  "ssn",
  "address",
  "transcript",
  "recording",
  "recordinguri",
  "transcripturi",
  "notes",
  "note",
  "treatment",
  "diagnosis",
  "medication",
  "symptom",
  "message",
  "content",
  "body",
]);

/** Values that look like identifiers regardless of what the key is called. */
const PHONE_LIKE = /(?:\+?\d[\d\s().-]{8,}\d)/;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;

/**
 * Canonical UUIDs, removed before the phone-number check runs.
 *
 * Our own primary keys are UUIDs and they are the most common thing to put in
 * audit metadata. Some of them — `...-5678-4901-...` — match PHONE_LIKE, so
 * without this the guard rejects roughly one write in a handful, at random,
 * with a message accusing the caller of leaking a phone number. An intermittent
 * false positive is worse than a loud one: it gets diagnosed as flakiness and
 * the guard gets weakened.
 *
 * Stripping is safe. A UUID cannot BE a phone number, and a string containing
 * both still has the phone part checked.
 */
const UUID_ANYWHERE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Long hex digests, removed for the same reason as UUIDs.
 *
 * A SHA-256 of a signed agreement is exactly the kind of thing audit metadata
 * SHOULD carry, and a digit-heavy one trips PHI_LIKE at random. 32 characters
 * is the floor deliberately: the longest possible phone number is 15 digits, so
 * nothing this strips could ever have been one.
 */
const HEX_DIGEST = /\b[0-9a-f]{32,}\b/gi;

export class PhiInAuditError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to write audit metadata: ${reason}. ` +
        `Audit records describe an access; they must never contain the data accessed. ` +
        `See docs/hipaa-compliance.md.`,
    );
    this.name = "PhiInAuditError";
  }
}

/**
 * Throws if metadata looks like it contains PHI.
 *
 * Deliberately fails the write rather than silently redacting: a silent redact
 * teaches nobody, and the caller keeps adding the field back.
 */
export function assertNoPhi(metadata: unknown, path = "metadata"): void {
  if (metadata === null || metadata === undefined) return;

  if (typeof metadata === "string") {
    if (EMAIL_LIKE.test(metadata)) {
      throw new PhiInAuditError(`${path} contains something shaped like an email`);
    }
    const withoutIdentifiers = metadata
      .replace(UUID_ANYWHERE, "")
      .replace(HEX_DIGEST, "");
    if (PHONE_LIKE.test(withoutIdentifiers)) {
      throw new PhiInAuditError(
        `${path} contains something shaped like a phone number`,
      );
    }
    return;
  }

  if (Array.isArray(metadata)) {
    metadata.forEach((item, i) => assertNoPhi(item, `${path}[${i}]`));
    return;
  }

  if (typeof metadata === "object") {
    for (const [key, value] of Object.entries(metadata)) {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
      if (PHI_KEY_DENYLIST.has(normalized)) {
        throw new PhiInAuditError(`${path}.${key} is a PHI-shaped field name`);
      }
      assertNoPhi(value, `${path}.${key}`);
    }
  }
}

export type ActorContext =
  | { type: "user"; userId: string; label: string }
  | { type: "service"; serviceName: string }
  | { type: "agent"; serviceName: string }
  | { type: "connector"; connectionId: string; label: string }
  | { type: "system" };

export type RequestContext = {
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
};

export type AuditEntry = {
  action: "read" | "create" | "update" | "delete" | "export" | "decrypt";
  resourceType: string;
  resourceId?: string;
  resourceIds?: string[];
  resultCount?: number;
  metadata?: Record<string, unknown>;
};

function labelFor(actor: ActorContext): string {
  switch (actor.type) {
    case "user":
      return actor.label;
    case "service":
    case "agent":
      return actor.serviceName;
    case "connector":
      return actor.label;
    case "system":
      return "system";
  }
}

/**
 * Buffers audit entries for one request and flushes them inside the same
 * transaction as the work they describe.
 *
 * Same transaction is the important part: if the read rolls back, so does the
 * claim that it happened. An audit row for an access that never occurred is its
 * own kind of wrong.
 */
export class AuditRecorder {
  readonly #entries: AuditEntry[] = [];

  constructor(
    private readonly clinicId: string,
    private readonly actor: ActorContext,
    private readonly request: RequestContext = {},
  ) {}

  record(entry: AuditEntry): void {
    if (entry.metadata) assertNoPhi(entry.metadata);
    this.#entries.push(entry);
  }

  get count(): number {
    return this.#entries.length;
  }

  async flush(tx: Transaction): Promise<void> {
    if (this.#entries.length === 0) return;

    const actor = this.actor;
    const rows = this.#entries.map((entry) => {
      const ids = entry.resourceIds ?? [];
      const truncated = ids.length > MAX_AUDITED_IDS;

      return {
        clinicId: this.clinicId,
        actorType: actor.type,
        actorUserId: actor.type === "user" ? actor.userId : null,
        actorServiceName:
          actor.type === "service" || actor.type === "agent"
            ? actor.serviceName
            : null,
        actorConnectionId:
          actor.type === "connector" ? actor.connectionId : null,
        actorLabel: labelFor(actor),
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        resourceIds: truncated ? ids.slice(0, MAX_AUDITED_IDS) : ids.length ? ids : null,
        resultCount: entry.resultCount ?? (ids.length || null),
        requestId: this.request.requestId ?? null,
        ipAddress: this.request.ipAddress ?? null,
        userAgent: this.request.userAgent ?? null,
        metadata: truncated
          ? { ...entry.metadata, idsTruncated: true, totalIds: ids.length }
          : (entry.metadata ?? null),
      };
    });

    await tx.insert(auditLog).values(rows);
    this.#entries.length = 0;
  }
}

/**
 * Identity-plane events: sign-in, sign-out, role changes, BAA acceptance.
 *
 * Separate table because these have no clinic to scope them by — which is
 * precisely what lets audit_log.clinicId be NOT NULL with no escape hatch in
 * its RLS policy.
 */
export async function recordSecurityEvent(
  db: Queryable,
  event: {
    event: string;
    actorLabel: string;
    userId?: string | null;
    organizationId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (event.metadata) assertNoPhi(event.metadata);

  await db.insert(securityEvents).values({
    event: event.event,
    actorLabel: event.actorLabel,
    userId: event.userId ?? null,
    organizationId: event.organizationId ?? null,
    ipAddress: event.ipAddress ?? null,
    userAgent: event.userAgent ?? null,
    metadata: event.metadata ?? null,
  });
}
