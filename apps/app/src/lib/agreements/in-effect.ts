import { agreementKindOfVersion, type AgreementKind } from "@healdesk/catalog";
import { eq, sql } from "drizzle-orm";

import { unsafeDb, type Queryable } from "@/db";
import { baaAcceptances } from "@/db/schema";
import type { IntentRequest } from "@/lib/checkout/intents";
import type { TenantTx } from "@/lib/tenant";

/**
 * The agreement a clinic is on, read the one way the database reads it.
 *
 * "The agreement in effect" has one definition, app_agreement_in_effect()
 * (drizzle/0048): the organisation's newest bound, unterminated acceptance by
 * accepted_at. Go-live, the console's clinic card, the calendar election
 * guard and app_calendar_write_permitted() (drizzle/0053) all read it there,
 * so this is a wrapper over that function and never a second query of
 * baa_acceptances: a TypeScript answer that ordered by bound_at, as the plan
 * of 5 October first had it, could name one agreement while the database's
 * guards judged against another. The signed variables are read afterwards,
 * by the id the function chose.
 *
 * baa_acceptances is FORCE ROW LEVEL SECURITY (0031): inside a tenant the
 * function sees that tenant's organisation and no other, and from a service
 * context, with no tenant set, it sees every row. A terminated agreement is
 * in effect for nobody, so it voids every location's calendar terms with it.
 */

export type AgreementInEffect = {
  agreementId: string;
  documentVersion: string;
  /** From the row's own version, as the generated agreement_kind column has it. */
  agreementKind: AgreementKind;
  acceptedAt: Date;
  boundAt: Date | null;
  /**
   * What signAgreement stored beside the document: the BAA's variables, the
   * clauses the document contained (`appliedClauses`) and the answers as sent
   * (`bookingSystem`, `calendarAccount`, `platformId`). Contract metadata,
   * never patient data.
   */
  variables: Record<string, unknown>;
};

type Row = {
  agreement_id: string;
  document_version: string;
  accepted_at: Date | string;
  bound_at: Date | string | null;
  variables: Record<string, unknown> | null;
};

function fromRow(row: Row | undefined): AgreementInEffect | null {
  if (!row) return null;
  return {
    agreementId: row.agreement_id,
    documentVersion: row.document_version,
    agreementKind: agreementKindOfVersion(row.document_version),
    acceptedAt: new Date(row.accepted_at),
    boundAt: row.bound_at === null ? null : new Date(row.bound_at),
    variables: row.variables ?? {},
  };
}

/** The agreement the tenant's own clinic is on, through its organisation, or null. */
export async function agreementInEffect(tx: TenantTx): Promise<AgreementInEffect | null> {
  const result = await tx.db.execute<Row>(sql`
    select a.agreement_id, a.document_version, a.accepted_at, b.bound_at, b.variables
      from clinics c
     cross join lateral app_agreement_in_effect(c.organization_id) a
      join baa_acceptances b on b.id = a.agreement_id
     where c.id = ${tx.clinicId}`);
  return fromRow(result.rows[0]);
}

/**
 * The agreement an organisation is on, or null. For a caller with no tenant:
 * the ops console, which reads every organisation's agreements, as
 * app_clinics_overview() does. Inside a tenant it answers only for that
 * tenant's own organisation.
 */
export async function agreementInEffectFor(
  db: Queryable,
  organizationId: string,
): Promise<AgreementInEffect | null> {
  const result = await db.execute<Row>(sql`
    select a.agreement_id, a.document_version, a.accepted_at, b.bound_at, b.variables
      from app_agreement_in_effect(${organizationId}::text) a
      join baa_acceptances b on b.id = a.agreement_id`);
  return fromRow(result.rows[0]);
}

// -----------------------------------------------------------------------------
// The purchase and the signature
// -----------------------------------------------------------------------------

/** Every answer that names or selects the document, as the purchase carries it. */
export type AgreementPurchase = Pick<
  IntentRequest,
  "clinicName" | "specialty" | "platform" | "isCoveredEntity" | "bookingSystem" | "calendarAccount"
>;

export class AgreementMismatchError extends Error {
  readonly field = "agreementId";

  constructor(message: string) {
    super(message);
    this.name = "AgreementMismatchError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refuse a purchase whose signed agreement is not the document it describes:
 * the platform or booking system it names (and from 1.3.0 the kind of Google
 * account), and with them the practice, specialty and covered-entity answer
 * that select the rest (plan §2.7, the seam §14.3 left for the purchase).
 *
 * Not a second definition of a matching agreement. The checkout intent
 * already refuses a mismatch before payment through `agreementMismatch`
 * (lib/checkout/intents.ts, the funnel's), and this asks exactly that
 * function about the signed row, so the two cannot disagree; the design
 * record (docs/design/google-calendar-2026-10-05.md §6) drops the plan's own
 * comparison for that reason. The message is agreementMismatch's, which tells
 * the buyer to sign again.
 *
 * The intents module is loaded when this is called, not when this file is.
 * It imports provisioning, and with it the billing lifecycle; statically
 * imported here, all of that would load with every reader of the agreement
 * in effect, and should provisioning ever read the agreement in effect from
 * this file, the three would form an import cycle, which breaks whichever
 * module of it is evaluated first.
 */
export async function assertPlatformMatchesAgreement(
  agreementId: string,
  purchase: AgreementPurchase,
): Promise<void> {
  const { agreementMismatch } = await import("@/lib/checkout/intents");
  const [row] = UUID.test(agreementId)
    ? await unsafeDb
        .select({ version: baaAcceptances.documentVersion, variables: baaAcceptances.variables })
        .from(baaAcceptances)
        .where(eq(baaAcceptances.id, agreementId))
        .limit(1)
    : [];
  if (!row) throw new AgreementMismatchError("That agreement wasn't found. Please sign it again.");
  const mismatch = agreementMismatch(row.version, row.variables, purchase);
  if (mismatch) throw new AgreementMismatchError(mismatch);
}
