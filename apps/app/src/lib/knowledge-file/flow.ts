import { and, eq, gt, sql } from "drizzle-orm";

import { auditLog } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { depositShown, readClinicDefaultDeposit, saveKnowledge, type KnowledgeContext } from "@/lib/portal/knowledge";
import { serviceInputOf, type ServiceInput } from "@/lib/setup/knowledge";
import { readSetupState } from "@/lib/setup/state";
import { withTenant } from "@/lib/tenant";
import { keyOf } from "@/lib/website/diff";

import { fileRows, type FileRow, type PageKnowledge } from "./proposals";
import {
  checkFile,
  FILE_LIMITS,
  FILE_REFUSAL_WORDS,
  readFileProfile,
  type FileModelClient,
  type FileRefusal,
} from "./read";

/**
 * "Add from a file", end to end (portal redesign, owner, 1 November 2026):
 * read a file into rows the clinic chooses from, then add the ones it
 * chose. Both halves run inside the clinic's own tenant.
 *
 * The daily limit is counted from the audit log: each file read writes one
 * row (resource `knowledge_file`, action `read`, the file's kind and nothing
 * else), before the model is asked, so a file that fails still counts and a
 * stuck button cannot run up the model's cost. No new table.
 */

export const FILE_AUDIT_RESOURCE = "knowledge_file";

export type FileReadOutcome =
  | { ok: true; rows: FileRow[]; message: string }
  | { ok: false; refusal: FileRefusal; message: string };

function refused(refusal: FileRefusal): FileReadOutcome {
  return { ok: false, refusal, message: FILE_REFUSAL_WORDS[refusal] };
}

/** The page's knowledge as the rows compare it. */
function pageKnowledgeOf(state: NonNullable<Awaited<ReturnType<typeof readSetupState>>>): PageKnowledge {
  return {
    services: state.knowledge.services,
    policies: state.knowledge.policies,
    quickAnswers: state.knowledge.quickAnswers,
    mostAsked: state.knowledge.mostAsked,
    hours: (state.clinic.openingHours as PageKnowledge["hours"]) ?? null,
  };
}

export async function readKnowledgeFile(input: {
  clinicId: string;
  userId: string;
  actor: ActorContext;
  bytes: Uint8Array;
  client: FileModelClient | null;
  now?: Date;
}): Promise<FileReadOutcome> {
  const now = input.now ?? new Date();
  const checked = checkFile(input.bytes);
  if ("refusal" in checked) return refused(checked.refusal);

  const allowed = await withTenant({ clinicId: input.clinicId, actor: input.actor }, async (tx) => {
    const [row] = await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.clinicId, tx.clinicId),
          eq(auditLog.resourceType, FILE_AUDIT_RESOURCE),
          eq(auditLog.action, "read"),
          gt(auditLog.occurredAt, new Date(now.getTime() - 86_400_000)),
        ),
      );
    if ((row?.n ?? 0) >= FILE_LIMITS.perDay) return false;
    tx.audit.record({
      action: "read",
      resourceType: FILE_AUDIT_RESOURCE,
      metadata: { kind: checked.kind },
    });
    return true;
  });
  if (!allowed) return refused("daily_limit");

  const read = await readFileProfile(input.bytes, checked.kind, input.client, now);
  if (!read.ok) return refused(read.refusal);

  const state = await withTenant({ clinicId: input.clinicId, actor: input.actor }, (tx) =>
    readSetupState(tx, { userId: input.userId, now }),
  );
  if (!state) return refused("unavailable");
  const rows = fileRows(read.profile, pageKnowledgeOf(state));
  if (rows.length === 0) {
    return { ok: true, rows, message: "Everything in that file is already on your page." };
  }
  return {
    ok: true,
    rows,
    message:
      rows.length === 1
        ? "AYA found one thing your page doesn't say yet."
        : `AYA found ${rows.length} things your page doesn't say yet.`,
  };
}

// -----------------------------------------------------------------------------
// Adding what the clinic chose
// -----------------------------------------------------------------------------

export type FileAddResult = { ok: true; message: string } | { ok: false; message: string };

const MAX_ROWS = 200;

function isRow(value: unknown): value is FileRow {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  switch (r.section) {
    case "prices":
      return typeof r.service === "object" && r.service !== null && typeof (r.service as { name?: unknown }).name === "string";
    case "hours":
      return typeof r.hours === "object" && r.hours !== null;
    case "policies":
      return typeof r.policy === "string";
    case "quick_answers":
      return (
        typeof r.answer === "object" &&
        r.answer !== null &&
        typeof (r.answer as { question?: unknown }).question === "string" &&
        typeof (r.answer as { answer?: unknown }).answer === "string"
      );
    default:
      return false;
  }
}

/** The deposit a row keeps, as saving the Prices form unchanged would send it (editors.tsx, servicesPayload). */
function keptDeposit(own: number | null | undefined, clinicDefault: number | null): number {
  const shown = depositShown(own, clinicDefault);
  return shown === "" ? 0 : Number(shown);
}

/**
 * Add the rows the clinic chose, each section in one save through the same
 * writer and screens as its form on Your practice (saveKnowledge), merged
 * into what the page holds now. Rows come back from the browser, so every
 * one is checked again by those writers; nothing here trusts them more than
 * a form's own fields.
 */
export async function addKnowledgeFileRows(
  ctx: KnowledgeContext,
  raw: unknown,
  now: Date = new Date(),
): Promise<FileAddResult> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, message: "Choose something to add." };
  if (raw.length > MAX_ROWS) return { ok: false, message: "That's more than can be added at once." };
  const rows = raw.filter(isRow);
  if (rows.length !== raw.length) return { ok: false, message: "Read the file again, then add from the new list." };

  const actor: ActorContext = { type: "user", userId: ctx.userId, label: ctx.actorLabel };
  const state = await withTenant({ clinicId: ctx.clinicId, actor }, (tx) =>
    readSetupState(tx, { userId: ctx.userId, now }),
  );
  if (!state) return { ok: false, message: "This clinic could not be found." };

  const saves: { section: string; input: unknown }[] = [];

  const prices = rows.filter((r): r is Extract<FileRow, { section: "prices" }> => r.section === "prices");
  if (prices.length > 0) {
    const clinicDefault = await readClinicDefaultDeposit(ctx.clinicId, actor);
    const services: ServiceInput[] = state.knowledge.services.map((s) => {
      const input = serviceInputOf(s);
      return { ...input, depositUsd: keptDeposit(input.depositUsd, clinicDefault) };
    });
    for (const row of prices) {
      const f = row.service;
      const fromFile = {
        priceKind: f.priceKind,
        price: f.priceUsd,
        maxPrice: f.maxUsd,
        unit: f.unit,
      };
      const at = services.findIndex((s) => keyOf(s.name) === keyOf(f.name));
      if (at >= 0) {
        services[at] = {
          ...services[at]!,
          ...(f.priceKind === null ? {} : fromFile),
          durationMinutes: f.durationMinutes ?? services[at]!.durationMinutes,
        };
      } else {
        services.push({ name: f.name, ...fromFile, durationMinutes: f.durationMinutes, depositUsd: 0 });
      }
    }
    saves.push({ section: "prices", input: { services } });
  }

  const hours = rows.find((r): r is Extract<FileRow, { section: "hours" }> => r.section === "hours");
  if (hours) {
    saves.push({
      section: "hours",
      input: {
        hours: hours.hours,
        closures: state.closures.map((c) => ({ closedOn: c.closedOn, label: c.label ?? "" })),
      },
    });
  }

  const policies = rows.filter((r): r is Extract<FileRow, { section: "policies" }> => r.section === "policies");
  if (policies.length > 0) {
    saves.push({ section: "policies", input: { policies: [...state.knowledge.policies, ...policies.map((r) => r.policy)] } });
  }

  const answers = rows.filter(
    (r): r is Extract<FileRow, { section: "quick_answers" }> => r.section === "quick_answers",
  );
  if (answers.length > 0) {
    saves.push({
      section: "quick_answers",
      input: {
        quickAnswers: [
          ...state.knowledge.quickAnswers.map((a) => ({
            question: a.question,
            answer: a.answer,
            ...(a.flagId ? { flagId: a.flagId } : {}),
          })),
          ...answers.map((r) => r.answer),
        ],
      },
    });
  }

  let added = 0;
  for (const save of saves) {
    const result = await saveKnowledge(ctx, save.section, save.input, now);
    if (!result.ok) {
      return {
        ok: false,
        message: added > 0 ? `Some of it was added, then: ${result.message}` : result.message,
      };
    }
    added += 1;
  }
  return {
    ok: true,
    message:
      rows.length === 1
        ? "Added to your page. AYA uses it from now on."
        : `${rows.length} things added to your page. AYA uses them from now on.`,
  };
}
