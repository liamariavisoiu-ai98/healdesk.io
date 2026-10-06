import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";

import { NO_PLATFORM_ID } from "@healdesk/catalog";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { clinics, connectionLinks } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { withTenant, type TenantTx } from "@/lib/tenant";

/**
 * The single-use link a clinic uses to hand us booking credentials, once.
 *
 * A clinic never creates an account, never sets a password and never signs in.
 * healdesk is a service, not software they operate — docs/launch-plan.md says
 * "Login? None" and means it. So the one thing we genuinely need from them, a
 * read-only booking credential, arrives through a link in an email. They click
 * it, follow their platform's wizard, paste one credential, and are finished
 * forever.
 *
 * The link is therefore the entire authentication story for a route that writes
 * a credential, exactly as a payload signature is for /api/webhooks. Four
 * properties make that defensible, and each is here because the obvious
 * implementation loses it.
 *
 * ## 1. What we store cannot be used
 *
 * The token is 32 bytes of `randomBytes`, base64url. What lands in Postgres is
 * SHA-256 of it. The obvious version — store the token, compare it on arrival —
 * makes a database dump a folder of working links into other people's booking
 * systems, and it fails in the only direction that matters: everything keeps
 * working perfectly while the secret sits in a backup. The column is
 * constrained to 32 bytes in drizzle/0024 so that regression fails the INSERT
 * instead of passing every test.
 *
 * No stretching (bcrypt, argon2) and no HMAC. Both exist to defend a *guessable*
 * secret; this one carries 256 bits of CSPRNG entropy, so an offline attack on
 * the digest is not the threat, and a plain digest keeps the lookup a single
 * indexed equality.
 *
 * ## 2. Consumption is a conditional UPDATE, never read-then-write
 *
 * `UPDATE ... WHERE used_at IS NULL RETURNING` is atomic. Two submissions
 * arriving together take the row lock in turn; the loser re-evaluates the
 * predicate against the committed row, matches nothing, and is told no. The
 * read-then-write version — SELECT, check, UPDATE — has both readers seeing
 * NULL and both proceeding, which is one link and two stored credentials. It
 * passes every sequential test anyone writes.
 *
 * ## 3. Every failure looks the same from outside
 *
 * Expired, already used, unknown and malformed all return `null` (or `false`).
 * The caller cannot tell them apart, so it cannot leak the difference, and an
 * anonymous visitor never learns whether a token ever existed or which clinic
 * it belonged to. The distinction is recorded in the audit log, where it is
 * useful and where only we can read it.
 *
 * ## 4. Reading requires a tenant we do not have yet
 *
 * connection_links is FORCE RLS like every table with a clinic_id, and the
 * holder of a link has no session. A query issued with no tenant declared
 * returns zero rows and is indistinguishable from "no such link" — that is
 * precisely the bug that made the old console look broken, and it is the one
 * thing to get right here.
 *
 * So the tenant comes from the token. `app_connection_link_clinic()` (0024)
 * puts the presented digest into a transaction-local setting and reads the one
 * row a bootstrap RLS policy then admits — no elevated rights anywhere, because
 * holding the digest IS the authorisation. It answers with one uuid, and every
 * statement after that runs inside `withTenant()` under the ordinary policy.
 * Nothing in this file reads a tenant table outside one of those two paths.
 *
 * Worth knowing before "simplifying" it: SECURITY DEFINER does NOT bypass RLS
 * here. The definer would be the table's owner, and the table is FORCEd, so a
 * definer function returns NULL for a perfectly good token — a broken feature
 * that reports itself as "link not found". 0024 has the long version.
 *
 * ## 5. One table, two pages, and a purpose column between them
 *
 * The setup link (design of 23 September 2026, §H) reuses this table, token
 * discipline and bootstrap policy, with `purpose = 'setup'`. Resolution and
 * consumption both filter on purpose, so a token issued for one page is
 * inert on the other, and the refusal is the same null as an unknown token.
 * No new RLS bootstrap: `app_connection_link_clinic()` answers with the
 * clinic for any purpose, and the purpose is checked inside the tenant
 * transaction that follows.
 *
 * ⚠️ No PHI on this surface, ever. The most it yields is a clinic's own name,
 * slug, specialty and booking platform. See docs/hipaa-compliance.md.
 */

/**
 * How long a link stays good.
 *
 * Fourteen days comes from the wizard content, not from taste. Several
 * platforms cannot be connected on the day the email arrives: Vagaro reviews
 * API access requests manually and takes up to seven business days, Zenoti
 * needs an account manager to enable an API package, PatientNow issues the key
 * themselves on request (packages/catalog/src/connection-steps.ts). A window
 * that closes before the vendor replies turns "paste one credential" into
 * "email us for a third link", which is the friction this flow exists to remove.
 *
 * It is not longer because the risk grows with the window: an unclicked link
 * sits in an inbox that gets forwarded to a bookkeeper, an agency, a departing
 * office manager. Fourteen days covers the slowest documented vendor with days
 * to spare, and nothing beyond that is bought by more.
 */
export const CONNECTION_LINK_TTL_DAYS = 14;

/**
 * The ceiling on a caller-supplied expiry.
 *
 * `issueConnectionLink` takes an override so ops can shorten a link for a
 * clinic that is on the phone right now. It is clamped because an override is a
 * number a human types, and a link good for a year is not a link — it is a
 * password with extra steps.
 */
export const MAX_CONNECTION_LINK_TTL_DAYS = 30;

/** 32 bytes of CSPRNG output. base64url of that is exactly 43 characters. */
const TOKEN_BYTES = 32;
const TOKEN_LENGTH = 43;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Who the audit log records for an anonymous redemption.
 *
 * There is deliberately no identity to attach: not knowing who holds the link
 * is the product decision, not an oversight, and inventing an actor would make
 * the audit trail claim something we cannot support. The consuming IP goes into
 * the request context, which is the only honest trace we have.
 */
const LINK_ACTOR: ActorContext = {
  type: "service",
  serviceName: "connection-link",
};

/**
 * What a link is for.
 *
 * `connect` hands us a booking credential; `setup` confirms the booking
 * requirement set (design of 23 September 2026, §A.9 and §H). `meta` connects
 * a clinic's Facebook Page and its linked Instagram account through Facebook
 * Login for Business, and `whatsapp` its WhatsApp number through Embedded
 * Signup (launch plan 1.6 and 2.5, docs/meta-app-review.md). They are two
 * purposes rather than one "channels" link because every link here is single
 * use, burned in the transaction that stores what it bought, and a clinic
 * connecting both would otherwise spend its link on the first. Same table,
 * same token, same bootstrap policy — the purpose is a column checked inside
 * the tenant transaction by resolution and by consumption, so a setup token
 * cannot be spent on /connect and a connect token cannot be spent on /setup.
 * A mismatch resolves to nothing, indistinguishable from an unknown token
 * (property 3), because "this is a real link for a different page" is exactly
 * the kind of confirmation a stranger holding a URL should not get.
 */
export type LinkPurpose = "connect" | "setup" | "meta" | "whatsapp";

/** What the wizard (or the setup page) needs to render, and nothing else. */
export type ResolvedLink = {
  clinicId: string;
  /** Shown so the clinic can see the link is genuinely theirs. */
  clinicName: string;
  /**
   * Needed for `connectEmailFor()` — the wizard's copyable steps ask them to
   * add `connect+<slug>@healdesk.io` as a read-only user, so the slug is part
   * of "enough to render the wizard". It discloses nothing the clinic name has
   * not already, to the one visitor who is by definition that clinic.
   */
  clinicSlug: string;
  /** Catalog platform id. `NO_PLATFORM_ID` when there is nothing to connect. */
  platformId: string;
  attributionMode: "estimated" | "verified";
  /**
   * The clinic's specialty id. The setup page pre-selects the specialty's
   * booking-field defaults from it; the connect wizard ignores it. A
   * `purpose: "setup"` resolve returns this superset rather than its own
   * shape so there is one resolver, one projection and one anti-oracle rule.
   */
  specialty: string;
  purpose: LinkPurpose;
};

export type IssueLinkOptions = {
  /** Defaults to CONNECTION_LINK_TTL_DAYS. Clamped to [1, MAX]. */
  expiresInDays?: number;
  /** Defaults to "connect". Set at issue and never changed. */
  purpose?: LinkPurpose;
};

export type IssueLinkContext = {
  /** The ops user or job issuing this. Recorded in the audit log. */
  actor: ActorContext;
  request?: RequestContext;
};

/**
 * A fresh token and the digest to store.
 *
 * Both halves come from one place on purpose: the encoding used to hash and the
 * encoding that goes in the URL must agree forever, or every link issued after
 * the change resolves to nothing with no error anywhere. Hashing the string we
 * actually mail — rather than the bytes behind it — makes that impossible to
 * get wrong, because resolution only ever has the string.
 *
 * The token is returned once. It is never written to this table, to an audit
 * row, or to a log.
 */
export function generateLinkToken(): { token: string; hash: Buffer } {
  const raw = randomBytes(TOKEN_BYTES);
  const token = raw.toString("base64url");
  // Best-effort: don't leave the seed sitting in a reachable buffer.
  raw.fill(0);

  return { token, hash: hashToken(token) };
}

/**
 * Mint a link for one clinic.
 *
 * The token comes back exactly once, to be put into exactly one email. There is
 * no way to recover it afterwards — that is the point of storing a digest — so
 * a lost link is reissued, never retrieved.
 *
 * Existing unused links are deliberately left alone. Superseding them would
 * kill a link that may already be open in a browser tab halfway through the
 * wizard, and every outstanding link is single-use and short-lived regardless.
 */
export async function issueConnectionLink(
  clinicId: string,
  opts: IssueLinkOptions,
  ctx: IssueLinkContext,
): Promise<{ token: string; expiresAt: Date }> {
  const days = clampTtlDays(opts.expiresInDays);
  const purpose: LinkPurpose = opts.purpose ?? "connect";
  const { token, hash } = generateLinkToken();

  // Attribution is taken from the audit actor rather than accepted as its own
  // argument, so the row and the audit entry cannot disagree about who did this.
  const issuedBy = ctx.actor.type === "user" ? ctx.actor.userId : null;

  const expiresAt = await withTenant(
    { clinicId, actor: ctx.actor, request: ctx.request },
    async (tx) => {
      const [row] = await tx.db
        .insert(connectionLinks)
        .values({
          clinicId,
          tokenHash: hash,
          // Computed by Postgres, against the same clock that later decides the
          // link has expired. An app-side Date would let skew between the web
          // process and the database silently shorten or extend the window.
          expiresAt: sql`now() + make_interval(days => ${days})`,
          issuedBy,
          purpose,
        })
        .returning({
          id: connectionLinks.id,
          expiresAt: connectionLinks.expiresAt,
        });

      if (!row) {
        throw new Error("Failed to issue a connection link: no row returned.");
      }

      tx.audit.record({
        action: "create",
        resourceType: "connection_link",
        resourceId: row.id,
        // No token, no digest, no clinic name. Only the shape of the grant.
        metadata: { expiresInDays: days, purpose },
      });

      return row.expiresAt;
    },
  );

  return { token, expiresAt };
}

/**
 * What this token entitles the holder to see, or null.
 *
 * Null covers expired, already used, unknown and malformed without
 * distinguishing them — property 3. It does NOT cover infrastructure failure: a
 * database error throws, because rendering "ask us for a new link" when the
 * link is fine sends the clinic round a loop that cannot end.
 *
 * Records the open in the audit log, rejected opens included, which is how a
 * link still circulating after it was redeemed becomes visible to us.
 *
 * `request` carries whatever the route could tell about the caller. It is
 * optional so this stays callable without a request store, and it is worth
 * supplying wherever there is one: the rejected-open row is the trail's only
 * sighting of a link being replayed, and a sighting that names no address
 * records that it happened while answering none of the questions it was written
 * to answer. It is a trace and not an identity — the values come from proxy
 * headers, and the token is the only thing that authenticates here.
 */
export async function resolveConnectionLink(
  token: string,
  request?: RequestContext,
  purpose: LinkPurpose = "connect",
): Promise<ResolvedLink | null> {
  const hash = hashIfWellFormed(token);
  if (!hash) return null;

  const clinicId = await clinicForTokenHash(hash);
  if (!clinicId) return null;

  return withTenant({ clinicId, actor: LINK_ACTOR, request }, async (tx) => {
    const [row] = await tx.db
      .select({
        linkId: connectionLinks.id,
        usedAt: connectionLinks.usedAt,
        purpose: connectionLinks.purpose,
        // Evaluated by Postgres so expiry is judged by one clock — the same one
        // that stamped expires_at and that the consuming UPDATE will use.
        expired: sql<boolean>`${connectionLinks.expiresAt} <= now()`,
        clinicName: clinics.name,
        clinicSlug: clinics.slug,
        bookingProvider: clinics.bookingProvider,
        attributionMode: clinics.attributionMode,
        specialty: clinics.specialty,
      })
      .from(connectionLinks)
      .innerJoin(clinics, eq(clinics.id, connectionLinks.clinicId))
      .where(eq(connectionLinks.tokenHash, hash))
      .limit(1);

    // The tenant lookup said this row exists, so an empty result means RLS or
    // the join hid it. Fail closed and say nothing, as with any other miss.
    if (!row) return null;

    if (row.usedAt !== null || row.expired || row.purpose !== purpose) {
      // A purpose mismatch is recorded with its own reason — a setup token
      // presented to /connect is worth knowing about — and answered with the
      // same null as every other miss.
      tx.audit.record({
        action: "read",
        resourceType: "connection_link",
        resourceId: row.linkId,
        metadata: {
          outcome: "rejected",
          reason:
            row.usedAt !== null ? "already_used" : row.expired ? "expired" : "wrong_purpose",
          purpose,
        },
      });
      return null;
    }

    const platformId = row.bookingProvider ?? NO_PLATFORM_ID;

    tx.audit.record({
      action: "read",
      resourceType: "connection_link",
      resourceId: row.linkId,
      metadata: { outcome: "opened", platformId, purpose },
    });

    return {
      clinicId,
      clinicName: row.clinicName,
      clinicSlug: row.clinicSlug,
      platformId,
      attributionMode: row.attributionMode,
      specialty: row.specialty,
      purpose,
    };
  });
}

/**
 * Burn the link. True if this call is the one that burned it.
 *
 * ⚠️ This opens its own transaction, so the burn commits alone. Call it BEFORE
 * storing the credential and store nothing if it returns false. The reverse
 * order looks equivalent and is not: two submissions racing would both store —
 * the second overwriting the first — and only then would one of them lose the
 * burn, leaving whichever credential arrived last in place with no record of
 * the one it replaced.
 *
 * The consequence, accepted deliberately: if the credential write fails after
 * the burn, the link is spent and the clinic needs a new one. A spent link and
 * an apology is a recoverable failure. A link kept alive "just in case" so it
 * can be replayed is not.
 *
 * A caller that already has a tenant transaction open should use
 * `consumeConnectionLinkWithin()` and skip the ordering question entirely.
 */
export async function consumeConnectionLink(
  token: string,
  ip: string | null,
  purpose: LinkPurpose = "connect",
): Promise<boolean> {
  const hash = hashIfWellFormed(token);
  if (!hash) return false;

  const clinicId = await clinicForTokenHash(hash);
  if (!clinicId) return false;

  const consumedIp = normaliseIp(ip);

  return withTenant(
    {
      clinicId,
      actor: LINK_ACTOR,
      request: consumedIp ? { ipAddress: consumedIp } : undefined,
    },
    (tx) => consumeConnectionLinkWithin(tx, token, ip, purpose),
  );
}

/**
 * The same burn, inside a transaction the caller already owns.
 *
 * This exists because the ordering rule above is a rule, and rules are the
 * things people get wrong under deadline. A route that writes the credential
 * and burns the link in ONE transaction has no ordering to get wrong: if the
 * burn returns false the caller throws, the credential rolls back with it, and
 * the winner's copy is the only one ever committed. Strictly better than
 * consume-then-store, which leaves a spent link behind when the store fails.
 *
 * The link is scoped to `tx`'s tenant by RLS rather than by an argument — a
 * token belonging to another clinic simply matches no row under the policy, so
 * there is no clinic id to pass and no comparison to forget.
 */
export async function consumeConnectionLinkWithin(
  tx: TenantTx,
  token: string,
  ip: string | null,
  purpose: LinkPurpose = "connect",
): Promise<boolean> {
  const hash = hashIfWellFormed(token);
  if (!hash) return false;

  // Property 2. One statement: the predicate and the write cannot be separated
  // by another transaction, so exactly one caller ever sees a row come back.
  // The purpose is in the predicate too: the burn a route performs is the
  // burn for ITS purpose, so a setup token handed to the credential wizard
  // matches nothing here even if something upstream forgot to resolve it.
  const [row] = await tx.db
    .update(connectionLinks)
    .set({ usedAt: sql`now()`, consumedIp: normaliseIp(ip) })
    .where(
      and(
        eq(connectionLinks.tokenHash, hash),
        eq(connectionLinks.purpose, purpose),
        isNull(connectionLinks.usedAt),
        gt(connectionLinks.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: connectionLinks.id });

  if (!row) {
    // Already used, expired between the open and the submit, issued for the
    // other page, or belonging to another clinic. Worth a row either way: a
    // second submission against a spent link is exactly what we would want to
    // see afterwards.
    tx.audit.record({
      action: "update",
      resourceType: "connection_link",
      metadata: { outcome: "rejected", reason: "not_consumable", purpose },
    });
    return false;
  }

  tx.audit.record({
    action: "update",
    resourceType: "connection_link",
    resourceId: row.id,
    // The IP travels in the recorder's request context, never in metadata:
    // assertNoPhi reads a dotted quad as a phone number and would refuse the
    // write, taking the audit row down with it.
    metadata: { outcome: "consumed", purpose },
  });

  return true;
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/** The one encoding decision. Everything hashes the string we actually mail. */
function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Digest a caller-supplied token, or null if it could not be one of ours.
 *
 * The shape check is not politeness. `Buffer.from(x, "base64url")` silently
 * drops characters it does not recognise, so without a strict alphabet two
 * different URLs can decode to the same bytes; validating the exact alphabet
 * and length keeps one token meaning one link. It also means a bot spraying
 * junk at the route costs us no query and writes no audit rows.
 *
 * The runtime string check guards the boundary: route params and searchParams
 * hand back `string | string[] | undefined` at runtime whatever the signature
 * promises, and `String(["a","b"])` would otherwise be hashed quite happily.
 */
function hashIfWellFormed(token: string): Buffer | null {
  if (typeof token !== "string") return null;
  if (token.length !== TOKEN_LENGTH) return null;
  if (!TOKEN_PATTERN.test(token)) return null;
  return hashToken(token);
}

/**
 * The tenant, derived from the token.
 *
 * ⚠️ The one legitimate `unsafeDb` in this file, and the reason is structural:
 * it runs before a tenant exists, in order to find out what the tenant is.
 * Every statement that touches a row afterwards goes through `withTenant()`.
 *
 * `unsafeDb` here does not mean unguarded. The function still runs as
 * healdesk_app under RLS; what admits the read is the bootstrap policy in 0024,
 * which lets through exactly the row whose token_hash matches the digest the
 * caller presented, and only when no tenant is set. A plain SELECT from this
 * file would return zero rows and look exactly like an unknown token.
 *
 * One statement on purpose. The function sets its transaction-local setting and
 * does its read in the same implicit transaction, so the setting is gone by the
 * time the connection returns to the pool — the leak `withTenant()` exists to
 * prevent, prevented the same way.
 *
 * No constant-time comparison: the argument is a SHA-256 digest of a 256-bit
 * CSPRNG token, so there is no adjacent guess for a timing signal to steer an
 * attacker towards. Constant-time matters for secrets that can be approached
 * incrementally; this is not one.
 */
async function clinicForTokenHash(hash: Buffer): Promise<string | null> {
  const result = await unsafeDb.execute<{ clinic_id: string | null }>(
    sql`select app_connection_link_clinic(${hash}::bytea) as clinic_id`,
  );

  return result.rows[0]?.clinic_id ?? null;
}

/**
 * An address `inet` will accept, or null.
 *
 * The caller's IP comes from a proxy header, which is attacker-influenced text.
 * Handing `inet` a forwarded-for chain, an empty string or junk raises 22P02,
 * which aborts the transaction — so a strange header would refuse a clinic's
 * credential with a 500 as the only explanation.
 *
 * So it fails soft: take the first hop, validate with `isIP`, store NULL if it
 * is not an address. Losing a diagnostic field is a far better trade than
 * losing the credential grant the clinic came here to complete.
 */
function normaliseIp(ip: string | null): string | null {
  if (!ip) return null;

  const first = ip.split(",")[0]?.trim();
  if (!first) return null;

  return isIP(first) === 0 ? null : first;
}

function clampTtlDays(requested: number | undefined): number {
  if (requested === undefined) return CONNECTION_LINK_TTL_DAYS;
  if (!Number.isFinite(requested)) return CONNECTION_LINK_TTL_DAYS;

  const whole = Math.floor(requested);
  if (whole < 1) return 1;
  if (whole > MAX_CONNECTION_LINK_TTL_DAYS) return MAX_CONNECTION_LINK_TTL_DAYS;
  return whole;
}
