import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/db";
import { clinics, providerConnections } from "@/db/schema";
import { open, seal } from "@/lib/crypto/envelope";
import { clinicLockLabel } from "@/lib/crypto/kms";

/**
 * Storing and reading a clinic's third-party credentials.
 *
 * Two rules shape this file:
 *
 *   1. **The credential bag never leaves.** `getConnection()` returns metadata
 *      and status; `withCredentials()` hands the decrypted bag to a callback and
 *      does not return it. That is the difference between a decrypt appearing
 *      in one audited place and appearing wherever someone found it convenient.
 *
 *   2. **Every decrypt is audited.** Reading a clinic's credential is exactly
 *      the kind of access §164.312(b) exists for, and it is the one an
 *      investigator will ask about first.
 *
 * The AAD binding in envelope.ts means ciphertext moved to another clinic's row
 * simply won't open — see tests/envelope.test.ts.
 *
 * Each credential's data key is also locked to the label `{ clinic: the
 * clinic's client number, login: the row's provider }` (crypto/kms.ts), so on
 * AWS a moved row is refused by KMS before its payload is reached. The client
 * number is read from the database at the seal and at every open; the provider
 * is the one the seal writes into the row and every open reads back from it;
 * and neither can change afterwards (the google_calendar migration's
 * triggers).
 */

export type ConnectionSummary = {
  id: string;
  provider: string;
  status: string;
  capabilities: Record<string, boolean> | null;
  metadata: unknown;
  expiresAt: Date | null;
  lastVerifiedAt: Date | null;
  lastError: string | null;
};

export async function listConnections(
  tx: Transaction,
  clinicId: string,
): Promise<ConnectionSummary[]> {
  return tx
    .select({
      id: providerConnections.id,
      provider: providerConnections.provider,
      status: providerConnections.status,
      capabilities: providerConnections.capabilities,
      metadata: providerConnections.metadata,
      expiresAt: providerConnections.expiresAt,
      lastVerifiedAt: providerConnections.lastVerifiedAt,
      lastError: providerConnections.lastError,
    })
    .from(providerConnections)
    .where(eq(providerConnections.clinicId, clinicId));
}

/**
 * Create or replace a clinic's credential for one provider.
 *
 * The row id is generated up front because the AAD is bound to it — the
 * ciphertext cannot be produced without knowing which row it will live in,
 * which is precisely what stops it being moved to another.
 *
 * The lock label is the clinic's client number, read here, and `provider`,
 * which becomes the row's own and can never change after: the same two values
 * withCredentials() reads back to open it.
 *
 * Every save clears `phi_basis`. A basis is recorded for one vendor account
 * (ops setConnectionPhiBasis, after someone has looked at that account's
 * agreement), and a re-save may be another account's credential: kept, the
 * old basis would let the legacy write path send names to an account nobody
 * looked at. A new credential is read-only to us until its basis is
 * recorded again. Google Calendar rows never carry one at all; their basis
 * is the location's calendar terms.
 */
export async function saveConnection(
  tx: Transaction,
  input: {
    clinicId: string;
    provider: string;
    /** Whatever that platform needs. Sealed as one blob. */
    credentials: Record<string, string>;
    metadata?: Record<string, unknown>;
    /**
     * Which account at the provider this credential belongs to, as a digest:
     * for Google, sha256 hex of "google:" plus the ID token's subject, which
     * keeps one Google account live on one clinic (drizzle/0053). Never the
     * raw subject. Null, the default, for a provider with no such reference.
     */
    accountRef?: string | null;
  },
): Promise<string> {
  // Under a tenant, RLS shows the tenant's own clinic and no other, so a
  // clinic id that is not this transaction's finds nothing and seals nothing.
  const [clinic] = await tx
    .select({ clientNumber: clinics.clientNumber })
    .from(clinics)
    .where(eq(clinics.id, input.clinicId))
    .limit(1);

  if (!clinic) throw new Error("Clinic not found.");

  const [existing] = await tx
    .select({ id: providerConnections.id })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.clinicId, input.clinicId),
        eq(providerConnections.provider, input.provider),
      ),
    )
    .limit(1);

  const id = existing?.id ?? crypto.randomUUID();

  const sealed = await seal(
    JSON.stringify(input.credentials),
    { clinicId: input.clinicId, credentialId: id },
    clinicLockLabel(clinic.clientNumber, input.provider),
  );

  const values = {
    id,
    clinicId: input.clinicId,
    provider: input.provider,
    status: "pending" as const,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    authTag: sealed.authTag,
    wrappedDek: sealed.wrappedDek,
    keyVersion: sealed.keyVersion,
    aadVersion: sealed.aadVersion,
    metadata: input.metadata ?? null,
    accountRef: input.accountRef ?? null,
    phiBasis: null,
    updatedAt: new Date(),
  };

  if (existing) {
    await tx
      .update(providerConnections)
      .set(values)
      .where(eq(providerConnections.id, id));
  } else {
    await tx.insert(providerConnections).values(values);
  }

  return id;
}

/**
 * Run `fn` with the decrypted credentials, then let them go.
 *
 * Deliberately does not return them. A `getCredentials()` that handed back a
 * plaintext bag would end up called from a dozen places, each one an unaudited
 * decrypt, and the secret would eventually be logged by something well-meaning.
 *
 * The lock label comes from the row's own provider and its clinic's client
 * number, as the row is now: never from the caller, who names only which row.
 */
export async function withCredentials<T>(
  tx: Transaction,
  input: { clinicId: string; connectionId: string },
  fn: (credentials: Record<string, string>) => Promise<T>,
): Promise<T> {
  const [row] = await tx
    .select({
      ciphertext: providerConnections.ciphertext,
      iv: providerConnections.iv,
      authTag: providerConnections.authTag,
      wrappedDek: providerConnections.wrappedDek,
      keyVersion: providerConnections.keyVersion,
      aadVersion: providerConnections.aadVersion,
      provider: providerConnections.provider,
      clientNumber: clinics.clientNumber,
    })
    .from(providerConnections)
    .innerJoin(clinics, eq(clinics.id, providerConnections.clinicId))
    .where(
      and(
        eq(providerConnections.id, input.connectionId),
        eq(providerConnections.clinicId, input.clinicId),
      ),
    )
    .limit(1);

  if (!row) throw new Error("Connection not found.");

  const plaintext = await open(
    row,
    { clinicId: input.clinicId, credentialId: input.connectionId },
    clinicLockLabel(row.clientNumber, row.provider),
  );

  return fn(JSON.parse(plaintext) as Record<string, string>);
}

export async function markVerified(
  tx: Transaction,
  input: {
    clinicId: string;
    connectionId: string;
    capabilities: Record<string, boolean>;
    error?: string;
  },
): Promise<void> {
  await tx
    .update(providerConnections)
    .set({
      status: input.error ? "error" : "active",
      capabilities: input.capabilities,
      lastVerifiedAt: new Date(),
      lastError: input.error ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(providerConnections.id, input.connectionId),
        eq(providerConnections.clinicId, input.clinicId),
      ),
    );
}

/** last_error after an erasure: a short code naming why, never free text. */
const ERASE_REASON = /^[a-z0-9_]{1,40}$/;

/**
 * Erase a stored credential: seal an empty bag over it, mark the row revoked
 * and say why in `last_error` (plan §4.12). True if the row existed.
 *
 * Erased rather than deleted. The row is the evidence that the clinic
 * connected, when, and to which account (`account_ref` stays, so revocation
 * at Google can still be keyed by it and the live-account index frees it),
 * and it is what a later reconnect overwrites. Re-sealing rather than
 * blanking keeps every row openable under its own label, so nothing that
 * reads a revoked row meets a ciphertext it cannot account for: it opens to
 * `{}`. The old payload and its data key are overwritten in the same
 * statement; nothing of the secret remains in the row.
 *
 * The caller decides what an erasure means and writes the audit row; the
 * Google Calendar paths (disconnect, an election that ends the terms, access
 * removed at Google) also release the location's holds in the same
 * transaction (lib/connections/google-calendar.ts).
 */
export async function eraseCredentials(
  tx: Transaction,
  input: { clinicId: string; connectionId: string; reason: string },
): Promise<boolean> {
  if (!ERASE_REASON.test(input.reason)) {
    throw new Error("An erasure's reason is a short code: lower case, digits and underscores.");
  }
  const [row] = await tx
    .select({ provider: providerConnections.provider, clientNumber: clinics.clientNumber })
    .from(providerConnections)
    .innerJoin(clinics, eq(clinics.id, providerConnections.clinicId))
    .where(
      and(
        eq(providerConnections.id, input.connectionId),
        eq(providerConnections.clinicId, input.clinicId),
      ),
    )
    .limit(1);
  if (!row) return false;

  const sealed = await seal(
    JSON.stringify({}),
    { clinicId: input.clinicId, credentialId: input.connectionId },
    clinicLockLabel(row.clientNumber, row.provider),
  );
  await tx
    .update(providerConnections)
    .set({
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
      wrappedDek: sealed.wrappedDek,
      keyVersion: sealed.keyVersion,
      aadVersion: sealed.aadVersion,
      status: "revoked",
      lastError: input.reason,
      phiBasis: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(providerConnections.id, input.connectionId),
        eq(providerConnections.clinicId, input.clinicId),
      ),
    );
  return true;
}

export async function revokeConnection(
  tx: Transaction,
  input: { clinicId: string; connectionId: string },
): Promise<void> {
  await tx
    .update(providerConnections)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(
      and(
        eq(providerConnections.id, input.connectionId),
        eq(providerConnections.clinicId, input.clinicId),
      ),
    );
}
