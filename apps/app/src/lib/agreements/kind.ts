import {
  agreementKindOfVersion,
  getDpaTemplate,
  isBaaVersionAcceptable,
  type AgreementKind,
} from "@healdesk/catalog";
import { eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { baaAcceptances } from "@/db/schema";

/**
 * The kind of agreement a clinic is under, and whether it covers the clinic
 * (plan Part L).
 *
 * The database decides both: `clinics.agreement_kind` and
 * `clinics.regulatory_regime` are gate columns the runtime role cannot update,
 * and app_agreement_kind_sufficient() (drizzle/0051) is what the PHI gate
 * asks on every write. This module is the TypeScript side of the same rules,
 * for code that has to answer before it writes: provisioning, and whatever
 * offers the re-sign. tests/agreement-kinds.test.ts runs every combination
 * through this mirror and the SQL function and fails if they ever disagree.
 */

// The mirror of app_agreement_kind_sufficient() is pure and in the catalog
// since 14 October 2026 (packages/catalog/src/agreement-match.ts), because
// apps/web asks it too, when the buyer presses Pay, against the agreement
// record it holds. Re-exported so every reader here, and
// tests/agreement-kinds.test.ts, which holds the mirror against the SQL, keeps
// its import.
export { agreementKindSufficient } from "@healdesk/catalog";

/**
 * Whether a stored acceptance may be put in force: a released DPA template,
 * or a BAA version go-live accepts (isBaaVersionAcceptable, the TypeScript
 * twin of 0048's app_baa_version_acceptable), so released but superseded BAA
 * versions are refused as the database refuses them.
 *
 * The catalog holds the same rule (`agreementTemplateReleased`, for apps/web's
 * check at Pay). This one is kept here, reading the catalogue through its
 * exports, because provisioning's tests stand in for the owner's release of
 * the DPA by changing what `getDpaTemplate` reports, and only a call through
 * the module reaches that stand-in; tests/checkout-agreement-match.test.ts
 * holds the two equal for every version the catalogue knows.
 */
export function agreementTemplateReleased(version: string): boolean {
  if (agreementKindOfVersion(version) === "dpa") {
    return getDpaTemplate(version)?.approvedByCounsel === true;
  }
  return isBaaVersionAcceptable(version);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SupersedeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupersedeError";
  }
}

export type Superseded = {
  supersededAgreementId: string;
  supersededKind: AgreementKind;
  supersedingAgreementId: string;
  supersedingKind: AgreementKind;
  /** The instant the replaced agreement stopped being in effect: the end of the UTC day. */
  terminatedAt: Date;
};

/**
 * Put a clinic's organisation under a newly signed agreement: a DPA replaced
 * by a BAA, or a BAA by a later BAA. app_supersede_agreement() does the work
 * and refuses everything else (a DPA replacing anything, an agreement that
 * would not cover every location, a signature older than the one it
 * replaces), and writes the `agreement_superseded` security event in the same
 * transaction. What it cannot know is checked here first: that the new
 * agreement's template is released.
 *
 * Nothing calls this yet. The re-sign screen (AgreementStep through a signed
 * one-time link) and the operator's covered-entity flow are to, once they are
 * built.
 */
export async function supersedeAgreement(
  clinicId: string,
  supersedingAgreementId: string,
  actorLabel: string,
): Promise<Superseded> {
  if (!UUID.test(clinicId) || !UUID.test(supersedingAgreementId)) {
    throw new SupersedeError("That is not a clinic and an agreement.");
  }
  const [row] = await unsafeDb
    .select({ version: baaAcceptances.documentVersion })
    .from(baaAcceptances)
    .where(eq(baaAcceptances.id, supersedingAgreementId))
    .limit(1);
  if (!row) throw new SupersedeError("That agreement was not found.");
  if (!agreementTemplateReleased(row.version)) {
    throw new SupersedeError(
      `Agreement version ${row.version} is not released; nothing may be put in force under it.`,
    );
  }

  const result = await unsafeDb.execute<{ result: Record<string, string> }>(
    sql`select app_supersede_agreement(${clinicId}::uuid, ${supersedingAgreementId}::uuid, ${actorLabel}) as result`,
  );
  const out = (result as unknown as { rows?: { result: Record<string, string> }[] }).rows?.[0]
    ?.result;
  if (!out) throw new SupersedeError("The database returned no result for the supersede.");
  return {
    supersededAgreementId: out.supersededAgreementId!,
    supersededKind: out.supersededKind as AgreementKind,
    supersedingAgreementId: out.supersedingAgreementId!,
    supersedingKind: out.supersedingKind as AgreementKind,
    terminatedAt: new Date(out.terminatedAt!),
  };
}
