import { cache } from "react";

import { composeClinicRows, type ClinicRow } from "@/lib/admin/clinic-rows";
import * as ops from "@/lib/admin/ops-client";
import type { ClinicCards, ClinicHealth, OpsClinics, OpsResult } from "@/lib/admin/ops-client";
import type { ClinicStripRow, OpsInbox } from "@/lib/admin/strip-types";

/**
 * The two reads the redone admin draws from, behind one adapter each
 * (E1 steps 2 and 4): `listClinicStrip` for the Clinics table and `opsInbox`
 * for Home. Lane A2 adds `fetchClinicStrip` and `fetchOpsInbox` to
 * ops-client.ts; this file does not touch that file (it is another lane's)
 * and asks it, at run time, whether it has them yet. Until it has, each read
 * answers `null`, which the screens draw as "not measured yet" and never as
 * a quiet zero, so the lead merging the two lanes has nothing to wire: the
 * day the readers land, the columns fill.
 *
 * Server-only, like ops-client: it signs nothing itself, but it imports the
 * module that does.
 */

type Readers = {
  fetchClinicStrip?: () => Promise<OpsResult<ClinicStripRow[]>>;
  fetchOpsInbox?: () => Promise<OpsResult<OpsInbox>>;
};

const readers = ops as unknown as Readers;

/** The strip, or null while ops-client has no reader for it. */
export function readClinicStrip(): Promise<OpsResult<ClinicStripRow[]> | null> {
  return typeof readers.fetchClinicStrip === "function" ? readers.fetchClinicStrip() : Promise.resolve(null);
}

/** The inbox apps/app builds, or null while ops-client has no reader for it. */
export function readOpsInbox(): Promise<OpsResult<OpsInbox> | null> {
  return typeof readers.fetchOpsInbox === "function" ? readers.fetchOpsInbox() : Promise.resolve(null);
}

/** Whether the strip reader has landed: the page says which columns wait on it. */
export function stripReaderPresent(): boolean {
  return typeof readers.fetchClinicStrip === "function";
}

export type ClinicReads = {
  clinics: OpsResult<OpsClinics>;
  cards: OpsResult<ClinicCards>;
  health: OpsResult<ClinicHealth[]>;
  strip: OpsResult<ClinicStripRow[]> | null;
  rows: ClinicRow[];
};

/**
 * The four reads behind the Clinics table and the clinic panel's header,
 * settled independently: one that fails costs its columns, never the rest.
 * Memoised per request (React `cache`), so the panel's layout and the tab
 * beneath it, which both need a clinic's row, make the reads once.
 */
export const loadClinicRows = cache(async (): Promise<ClinicReads> => {
  const [clinics, cards, health, strip] = await Promise.all([ops.fetchClinics(), ops.fetchClinicCards(), ops.fetchClinicHealth(), readClinicStrip()]);
  return { clinics, cards, health, strip, rows: composeClinicRows({ clinics, cards, health, strip }) };
});
