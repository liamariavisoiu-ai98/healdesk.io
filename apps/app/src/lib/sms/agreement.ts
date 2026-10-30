import { agreementKindOfVersion, BAA_TEMPLATES, getDpaTemplate } from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import { agreementInEffect } from "@/lib/agreements/in-effect";
import type { TenantTx } from "@/lib/tenant";

/**
 * Whether the clinic's accepted agreement carries the payment-link text's
 * exception (spec, "Payment by text after a call", "Only under an agreement
 * that covers it"; owner, 29 and 30 October 2026).
 *
 * BAA 1.6.0 and DPA 1.1.0 are the first versions that say the assistant may
 * offer a caller one text. A clinic on an older version, BAA 1.5.x or
 * DPA 1.0.0, never has a caller texted: the DPA has no re-sign path, so a
 * DPA 1.0.0 clinic stays without the text. The answer is read from the
 * agreement in effect (app_agreement_in_effect, through agreementInEffect),
 * never from the clinic's agreement kind alone, and it fails closed: no
 * agreement, a kind that disagrees with the clinic's, a draft, a version
 * the catalogue does not know as released, or one that does not parse, is
 * "not covered".
 */

/** The first version of each kind that carries the text's exception. */
export const TEXT_AGREEMENT_FLOOR = { baa: [1, 6, 0], dpa: [1, 1, 0] } as const;

function parse(version: string): [number, number, number] | null {
  const m = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v: readonly number[], floor: readonly number[]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (v[i]! !== floor[i]!) return v[i]! > floor[i]!;
  }
  return true;
}

/** Pure: whether an accepted document version covers the text. Unknown or malformed: false. */
export function agreementVersionCoversText(version: string | null | undefined): boolean {
  if (typeof version !== "string" || version.length === 0) return false;
  const kind = agreementKindOfVersion(version);
  if (kind === "dpa") {
    const semver = parse(version.slice("dpa/".length));
    return semver !== null && getDpaTemplate(version)?.approvedByCounsel === true && atLeast(semver, TEXT_AGREEMENT_FLOOR.dpa);
  }
  const semver = parse(version);
  return semver !== null && BAA_TEMPLATES.some((t) => t.version === version) && atLeast(semver, TEXT_AGREEMENT_FLOOR.baa);
}

/**
 * The tenant clinic's agreement in effect covers the text. Read fresh, in
 * the caller's transaction; any doubt is no.
 */
export async function agreementCoversText(tx: TenantTx): Promise<boolean> {
  const agreement = await agreementInEffect(tx);
  if (!agreement) return false;
  const [clinic] = await tx.db
    .select({ kind: clinics.agreementKind })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic?.kind || clinic.kind !== agreement.agreementKind) return false;
  return agreementVersionCoversText(agreement.documentVersion);
}
