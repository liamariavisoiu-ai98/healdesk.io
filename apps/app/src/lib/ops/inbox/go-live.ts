import { readGoLiveCheck } from "@/lib/channels/events";
import { describeError, log } from "@/lib/log";
import type { GoLiveCheck, GoLiveCode } from "@/lib/onboarding/go-live";
import { withTenant } from "@/lib/tenant";

import { listClinics } from "../clinics";

import type { InboxContext, InboxRow } from "./types";

/**
 * Go-live (lane P5d, item 7): Home had no row for a clinic that has done its
 * part and is not live. The go_live_held alert is raised once per clinic and
 * reason (lib/channels/events.ts goLiveIfReady), so after its day on Home it
 * was gone while the clinic still waited. This source reads each clinic's
 * go-live check (readGoLiveCheck, the operator's go-live view's own read, no
 * patient and no access row) and says, as two rows at most:
 *
 *   - ready: not live, and everything left is ours (the platform's
 *     attestations, Gate B's unbuilt items, a channel's runtime), or nothing
 *     is left at all;
 *   - held: not live, something is still the clinic's, and go_live_held's
 *     own rule says ops should hear of it (the clinic's part of a channel is
 *     done, or its agreement is what stands in the way).
 *
 * healdesk's demo clinic and a leaving clinic never go live and are never
 * counted. Each row opens the first clinic's Setup tab, where the go-live
 * view is.
 *
 * NOT REGISTERED YET: the row kind `go_live` needs its line in INBOX_KINDS
 * (./types.ts) and this source its line in ./sources.ts; types.ts is not this
 * lane's file, so the lead adds both (lane P5d's report).
 */

export type GoLiveRow = Omit<InboxRow, "kind"> & { kind: "go_live" };

/** The refusals that are the practice's agreement: go_live_held alerts on these whatever else is ready. */
const AGREEMENT_CODES: ReadonlySet<GoLiveCode> = new Set([
  "no_agreement",
  "agreement_version",
  "agreement_kind_mismatch",
  "agreement_insufficient",
]);

export type GoLiveStanding = "ready" | "held" | null;

/** Where one clinic stands, by the rule above; null when it is live, never goes live, or is still setting up. */
export function goLiveStanding(read: { production: boolean; check: GoLiveCheck }): GoLiveStanding {
  if (read.production) return null;
  const codes = read.check.missing.map((m) => m.code);
  if (codes.includes("leaving") || codes.includes("demo")) return null;
  const clinicSide = read.check.missing.filter((m) => m.side === "clinic");
  if (clinicSide.length === 0) return "ready";
  // gate_b is missing as the clinic's when no channel has its own part done.
  const clinicPartDone = !clinicSide.some((m) => m.code === "gate_b");
  if (clinicPartDone || codes.some((c) => AGREEMENT_CODES.has(c))) return "held";
  return null;
}

export function goLiveHref(clinicId: string): string {
  return `/admin/clinics/${clinicId.toLowerCase()}/setup`;
}

function clinics(n: number): string {
  return n === 1 ? "1 clinic is" : `${n} clinics are`;
}

export const goLiveSource = {
  name: "go-live",
  async read(ctx: InboxContext): Promise<{ rows: GoLiveRow[]; partial?: string }> {
    const found: Record<"ready" | "held", { id: string; name: string }[]> = { ready: [], held: [] };
    let failed = 0;
    for (const clinic of await listClinics()) {
      if (clinic.destroyedAt) continue;
      try {
        const read = await withTenant(
          { clinicId: clinic.id, actor: ctx.actor, request: ctx.request },
          (tx) => readGoLiveCheck(tx, ctx.now),
        );
        const standing = read ? goLiveStanding(read) : null;
        if (standing) found[standing].push({ id: clinic.id, name: clinic.name });
      } catch (error) {
        failed += 1;
        log.warn("go-live check not read", { clinicId: clinic.id, error: describeError(error) });
      }
    }
    const rows: GoLiveRow[] = [];
    // Only the clinics that wait on us become a row. One held by something
    // only the clinic can put right asks nothing of the operator (go_live_held
    // already tells ops once per reason), and a row that asks nothing is the
    // noise the owner asked Home not to have.
    for (const standing of ["ready"] as const) {
      const list = found[standing].sort((a, b) => a.name.localeCompare(b.name));
      const first = list[0];
      if (!first) continue;
      rows.push({
        id: `go_live:${standing}`,
        kind: "go_live",
        count: list.length,
        sentence:
          standing === "ready"
            ? `${clinics(list.length)} ready to go live: the clinic's part is done and what is left is ours.`
            : `${clinics(list.length)} held at go-live by something only the clinic can put right.`,
        clinic: { id: first.id, name: first.name },
        button: { label: "Open Setup", kind: "link", href: goLiveHref(first.id) },
        tone: standing === "ready" ? "warn" : "info",
        dueAt: null,
      });
    }
    return { rows, partial: failed > 0 ? `${failed} clinic(s) could not be read.` : undefined };
  },
};
