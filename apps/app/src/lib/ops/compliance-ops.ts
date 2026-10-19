import type { Channel } from "@healdesk/catalog";

import { unsafeDb } from "@/db";
import { gateBInCode, type GateBCodeItem } from "@/lib/compliance/gate-b";
import {
  listPlatformHistory,
  PlatformAttestationError,
  readPlatformCompliance,
  recordPlatformAttestation,
  SUBJECT_WORDS,
  utcDay,
} from "@/lib/compliance/platform";
import {
  CHANNEL_SUBJECTS,
  CLINIC_WIDE_SUBJECTS,
  isVendorSubject,
  PLATFORM_SUBJECTS,
  type PlatformAction,
  type PlatformSubject,
} from "@/lib/compliance/subjects";

import { audit, ok, stringArg, type Operator, type OpsOutcome } from "./api";

/**
 * The platform's attestations through the ops envelope (WP2; plan Part K,
 * "Platform-compliance attestation"): the view /admin/compliance shows, and
 * the two writes it enters, each after apps/web has checked the operator's
 * session and a fresh code from the operator's authenticator
 * (apps/web/src/lib/admin/fresh-code.ts). The signed envelope is the only
 * proof that crosses, as for every operation.
 *
 * What crosses: subjects from a closed list, a short reference to where a
 * document is kept, two days, and for the launch promises the ids of the
 * items apps/web holds open. No clinic, no patient. An attestation is
 * written outside any tenant (platform_compliance's trigger refuses one made
 * inside), audited as a security event naming only the subject, and never
 * takes a live channel offline when withdrawn.
 */

type EntryView = {
  action: PlatformAction;
  documentRef: string;
  effectiveOn: string;
  expiresOn: string | null;
  actorLabel: string;
  recordedAt: string;
};

export type PlatformComplianceView = {
  /** The UTC day the expiries are read against. */
  today: string;
  subjects: {
    subject: PlatformSubject;
    kind: "vendor" | "readiness";
    label: string;
    attests: string;
    needs: string;
    /** "all" when every channel needs it; otherwise the channels that do. */
    channels: "all" | Channel[];
    attested: boolean;
    lapsed: boolean;
    latest: EntryView | null;
  }[];
  history: (EntryView & { subject: PlatformSubject })[];
  /** What Gate B asks of the code, built or named as not built (lib/compliance/gate-b.ts). */
  gateB: GateBCodeItem[];
};

export type PlatformAttestationState =
  | { status: "recorded"; subject: PlatformSubject; attested: boolean; auditRecorded: boolean }
  | { status: "refused"; message: string };

function channelsNeeding(subject: PlatformSubject): "all" | Channel[] {
  if (CLINIC_WIDE_SUBJECTS.includes(subject)) return "all";
  return (Object.keys(CHANNEL_SUBJECTS) as Channel[]).filter((c) =>
    CHANNEL_SUBJECTS[c].includes(subject),
  );
}

function entryView(entry: {
  action: PlatformAction;
  documentRef: string;
  effectiveOn: string;
  expiresOn: string | null;
  actorLabel: string;
  recordedAt: Date;
}): EntryView {
  return { ...entry, recordedAt: entry.recordedAt.toISOString() };
}

export async function opListPlatformCompliance(): Promise<OpsOutcome> {
  const now = new Date();
  const status = await readPlatformCompliance(unsafeDb, now);
  const history = await listPlatformHistory(unsafeDb, 50);
  return ok({
    today: utcDay(now),
    subjects: PLATFORM_SUBJECTS.map((subject) => ({
      subject,
      kind: isVendorSubject(subject) ? ("vendor" as const) : ("readiness" as const),
      label: SUBJECT_WORDS[subject].label,
      attests: SUBJECT_WORDS[subject].attests,
      needs: SUBJECT_WORDS[subject].needs,
      channels: channelsNeeding(subject),
      attested: status[subject].attested,
      lapsed: status[subject].lapsed,
      latest: status[subject].latest ? entryView(status[subject].latest) : null,
    })),
    history: history.map((h) => ({ subject: h.subject, ...entryView(h) })),
    gateB: gateBInCode(),
  } satisfies PlatformComplianceView);
}

const refused = (message: string) =>
  ok({ status: "refused", message } satisfies PlatformAttestationState);

/**
 * The launch promises are attested only while apps/web, which holds the list
 * (apps/web/src/lib/admin/seo/launch.ts), reports none that blocks go-live
 * open: CLAUDE.md's "no clinic goes live while an item that blocks go-live is
 * open", which go-live now asks by itself.
 */
function launchPromisesProblem(args: Record<string, unknown>): string | null {
  const open = args.openLaunchPromises;
  if (!Array.isArray(open) || !open.every((id) => typeof id === "string")) {
    return "The console must say which launch promises are open; nothing was recorded.";
  }
  if (open.length > 0) {
    return `Launch promises that block go-live are still open (${open.slice(0, 20).join(", ")}): move each to on first. Nothing was recorded.`;
  }
  return null;
}

async function record(
  args: Record<string, unknown>,
  operator: Operator,
  action: PlatformAction,
): Promise<OpsOutcome> {
  const subject = stringArg(args, "subject", 64);
  if (action === "attested" && subject === "launch_promises") {
    const problem = launchPromisesProblem(args);
    if (problem) return refused(problem);
  }
  try {
    const { subject: recorded, status } = await recordPlatformAttestation(unsafeDb, {
      subject,
      action,
      documentRef: typeof args.documentRef === "string" ? args.documentRef : undefined,
      effectiveOn: stringArg(args, "effectiveOn", 32),
      expiresOn: stringArg(args, "expiresOn", 32),
      actorLabel: operator.email,
    });
    // The subject and what was done, no more: the reference and its dates are
    // the row itself, and a date's digits read as a phone number to the
    // audit scanner.
    const auditRecorded = await audit(
      operator,
      action === "attested" ? "platform_compliance_attested" : "platform_compliance_withdrawn",
      { subject: recorded },
    );
    return ok({
      status: "recorded",
      subject: recorded,
      attested: status[recorded].attested,
      auditRecorded,
    } satisfies PlatformAttestationState);
  } catch (error) {
    if (error instanceof PlatformAttestationError) return refused(error.message);
    throw error;
  }
}

export function opAttestPlatformCompliance(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  return record(args, operator, "attested");
}

export function opWithdrawPlatformCompliance(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  return record(args, operator, "withdrawn");
}
