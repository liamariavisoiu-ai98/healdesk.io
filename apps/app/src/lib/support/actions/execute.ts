import { and, eq, inArray, sql } from "drizzle-orm";

import { unsafeDb, type Transaction } from "@/db";
import { supportCases, supportMessages } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { setAutoConfirm } from "@/lib/booking/mode";
import { connectedMetaPlatforms } from "@/lib/channels/meta-platforms";
import { readChannelStates } from "@/lib/channels/state";
import { SUPPORT_ACTION_SERVICE } from "@/lib/clinic/change-events";
import { readSettingSnapshot } from "@/lib/clinic/setting-changes";
import { readPaymentFacts } from "@/lib/portal/switch-resets";
import { SETTING_ENTRIES } from "@/lib/clinic/setting-words";
import { describeError, log } from "@/lib/log";
import type { ClinicSwitchView } from "@/lib/ops/switch-ops";
import { saveSetting, type SettingKey } from "@/lib/portal/settings";
import { clinicSignIn } from "@/lib/sign-in/address-change";
import { withTenant } from "@/lib/tenant";

import { senderRef } from "../inbound/facts";
import { actionOfFacts, keptReason, tierOf, typedValue, valueToken, type SupportAction } from "./tiers";

/**
 * Support email to action, run in code, never by the model (lane D; the list
 * and the tiers are ./tiers.ts). Every change goes through the clinic's own
 * Settings door, `saveSetting` (Auto-confirm through `setAutoConfirm`, the
 * calendar card's), acting as the support-action service: so the same
 * validation, writers, audit trail and clinic notices apply, the change is
 * recorded as source support_action, and ops is emailed and told in Slack
 * by the change sweep, like any other (lib/clinic/setting-changes.ts).
 * The clinic can switch it straight back in its own Settings.
 *
 *   - assessAction: before anything runs, what the switch is now and whether
 *     its rule lets it change (lib/ops/switch-ops.ts switchViews, which reads
 *     lib/portal/switch-rules.ts, the one place the rules live), so the
 *     drafter's reply can say what is missing in the rule's own words;
 *   - senderIsClinic: whether every email the drafter read came from the
 *     case clinic's ONE sign-in address, authenticated: recorded so when it
 *     arrived (fromClinic), and its sender reference still that of the
 *     clinic's sign-in now. Otherwise a DIRECT change is proposed as APPROVAL;
 *   - runSupportAction: run a draft's pending change once per case. Claimed
 *     under the case's row lock (status `running`), so a retried job, a
 *     redraft or a second approval never repeats it; a case that already
 *     made a change makes no other. A refusal is kept with its own words and
 *     never retried.
 */

/** The change's actor: recorded as source support_action, actor support (lib/clinic/change-events.ts). */
export const SUPPORT_ACTION_ACTOR: Extract<ActorContext, { type: "service" }> = { type: "service", serviceName: SUPPORT_ACTION_SERVICE };
/** Who the clinic sees made the change: the operator console's own label (lib/ops/calendar-ops.ts OPS_SWITCH_LABEL). */
export const SUPPORT_ACTION_LABEL = "healdesk support";

export const NOT_IN_PLAN = "That setting isn't part of the practice's plan.";
export const ONE_PER_CASE = "This case already made a change, so no other change is made from it.";
export const COULD_NOT_RUN = "The change could not be made just now.";

const META_SWITCHES: readonly string[] = ["channel_instagram", "channel_messenger", "channel_whatsapp"];

/** The clinic's switches as the operator console reads them: value, plan, connection and rule. */
export async function readSwitchViews(clinicId: string, now: Date, actor: ActorContext = SUPPORT_ACTION_ACTOR): Promise<ClinicSwitchView[]> {
  const read = await withTenant({ clinicId, actor }, async (tx) => {
    const snapshot = await readSettingSnapshot(tx, now);
    const bought = (await readChannelStates(tx.db, tx.clinicId, now)).map((c) => c.channel);
    const connectedMeta = bought.includes("meta") ? await connectedMetaPlatforms(tx.db, tx.clinicId) : [];
    return {
      snapshot,
      bought,
      connectedMeta,
      // The one reading the Settings page, the wizard and the console use.
      facts: await readPaymentFacts(tx),
    };
  });
  // Loaded here, not at the top: lib/ops/switch-ops.ts reaches lib/ops/api.ts,
  // which loads the support send path, which loads the drafter that loads this.
  const { switchViews } = await import("@/lib/ops/switch-ops");
  return switchViews(read);
}

export type Assessment = { status: "pending" | "already" | "unavailable"; reason: string | null };

/**
 * Whether a listed change can run now, from the switches as read. Pure.
 * Turning a switch off, or a choice back to its plain option, is never held
 * by a rule; a Meta platform that is not connected has no switch either way.
 */
export function assessAction(views: readonly ClinicSwitchView[], key: string, value: string): Assessment {
  const view = views.find((v) => v.key === key);
  if (!view) return { status: "unavailable", reason: NOT_IN_PLAN };
  if (valueToken(key, view.value) === value) return { status: "already", reason: null };
  const kind = SETTING_ENTRIES[key]?.kind;
  const held = META_SWITCHES.includes(key) || (kind === "switch" ? value === "on" : value === "full_payment");
  if (!view.enabled && held) return { status: "unavailable", reason: keptReason(view.reason) ?? COULD_NOT_RUN };
  return { status: "pending", reason: null };
}

/**
 * Whether every email row named came from the case clinic's one sign-in
 * address: authenticated and matched to the clinic when it arrived
 * (fields_json.fromClinic), and its sender reference that of the clinic's
 * sign-in now. False when any row is not, when none is named, or when the
 * sign-in cannot be read.
 */
export async function senderIsClinic(input: { caseId: string; clinicId: string; messageIds: readonly string[] }): Promise<boolean> {
  if (input.messageIds.length === 0) return false;
  const rows = await unsafeDb
    .select({ id: supportMessages.id, fields: supportMessages.fieldsJson, sender: supportMessages.senderRef })
    .from(supportMessages)
    .innerJoin(supportCases, eq(supportCases.id, supportMessages.caseId))
    .where(
      and(
        eq(supportMessages.caseId, input.caseId),
        eq(supportCases.subjectClinicId, input.clinicId),
        eq(supportMessages.kind, "email"),
        eq(supportMessages.direction, "in"),
        inArray(supportMessages.id, [...input.messageIds]),
      ),
    );
  if (rows.length !== new Set(input.messageIds).size) return false;
  if (!rows.every((r) => r.fields?.fromClinic === "yes" && r.fields?.authenticated === "yes" && typeof r.sender === "string")) return false;
  try {
    const signIn = await withTenant({ clinicId: input.clinicId, actor: SUPPORT_ACTION_ACTOR }, (tx) => clinicSignIn(tx));
    if (!signIn) return false;
    const ref = senderRef(signIn.email);
    return rows.every((r) => r.sender === ref);
  } catch (error) {
    log.warn("support action: the sign-in was not read", { clinicId: input.clinicId, error: describeError(error) });
    return false;
  }
}

/** The email rows whose objects the drafter reads, by their keys. */
export async function emailRowsForKeys(caseId: string, keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await unsafeDb
    .select({ id: supportMessages.id })
    .from(supportMessages)
    .where(and(eq(supportMessages.caseId, caseId), eq(supportMessages.kind, "email"), inArray(supportMessages.inboundObjectKey, [...keys])));
  return rows.map((r) => r.id);
}

/** The change any reply row of the case already made or is making, other than `except`'s. */
export async function caseChange(caseId: string, except?: string, db: Transaction | typeof unsafeDb = unsafeDb): Promise<SupportAction | null> {
  const rows = await db
    .select({ id: supportMessages.id, facts: supportMessages.factsJson })
    .from(supportMessages)
    .where(and(eq(supportMessages.caseId, caseId), eq(supportMessages.kind, "reply"), eq(supportMessages.direction, "out")));
  for (const row of rows) {
    if (row.id === except) continue;
    const action = actionOfFacts(row.facts);
    if (action && (action.status === "done" || action.status === "running")) return action;
  }
  return null;
}

/** Write a row's action in place; nothing else of the row changes. */
export async function setRowAction(db: Transaction | typeof unsafeDb, messageId: string, action: SupportAction): Promise<void> {
  await db
    .update(supportMessages)
    .set({ factsJson: sql`jsonb_set(coalesce(${supportMessages.factsJson}, '{}'::jsonb), '{action}', ${JSON.stringify(action)}::jsonb)` })
    .where(eq(supportMessages.id, messageId));
}

/** Make the change through the clinic's own door. A refusal comes back in its own words. */
async function makeChange(clinicId: string, action: SupportAction, now: Date): Promise<{ ok: true } | { ok: false; reason: string }> {
  // The kept row is read strictly already; this is the last look before a write.
  if (tierOf(action.key, action.value) === "never") return { ok: false, reason: COULD_NOT_RUN };
  if (action.key === "auto_confirm") {
    await setAutoConfirm(clinicId, action.value === "on", SUPPORT_ACTION_ACTOR, { label: SUPPORT_ACTION_LABEL, now });
    return { ok: true };
  }
  const result = await saveSetting(
    { clinicId, userId: null, actorLabel: SUPPORT_ACTION_LABEL, steppedUp: false, actor: SUPPORT_ACTION_ACTOR },
    action.key as SettingKey,
    typedValue(action.key, action.value),
    now,
  );
  return result.ok ? { ok: true } : { ok: false, reason: result.message };
}

/**
 * Run the pending change on reply row `messageId`, once per case. Returns
 * the action as it then stands (unchanged when it was not pending), or null
 * when the row carries none. Never throws for a refusal or a failed write:
 * both are kept as `refused`, with the door's words or COULD_NOT_RUN.
 */
export async function runSupportAction(input: { caseId: string; messageId: string; now: Date }): Promise<SupportAction | null> {
  const at = input.now.toISOString();
  const claim = await unsafeDb.transaction(async (tx) => {
    const [c] = await tx
      .select({ clinicId: supportCases.subjectClinicId, state: supportCases.state })
      .from(supportCases)
      .where(eq(supportCases.id, input.caseId))
      .limit(1)
      .for("update");
    const [row] = await tx
      .select({ facts: supportMessages.factsJson })
      .from(supportMessages)
      .where(and(eq(supportMessages.id, input.messageId), eq(supportMessages.caseId, input.caseId), eq(supportMessages.kind, "reply")))
      .limit(1);
    const action = row ? actionOfFacts(row.facts) : null;
    if (!c || !c.clinicId || c.state === "closed" || !action || action.status !== "pending") return { run: false as const, action };
    const earlier = await caseChange(input.caseId, input.messageId, tx);
    if (earlier) {
      const same = earlier.status === "done" && earlier.key === action.key && earlier.value === action.value;
      const next: SupportAction = same
        ? { ...action, status: "already", reason: null, at }
        : { ...action, status: "not_run", reason: ONE_PER_CASE, at };
      await setRowAction(tx, input.messageId, next);
      return { run: false as const, action: next };
    }
    const running: SupportAction = { ...action, status: "running", reason: null, at };
    await setRowAction(tx, input.messageId, running);
    return { run: true as const, action: running, clinicId: c.clinicId };
  });
  if (!claim.run) return claim.action;

  let outcome: { ok: true } | { ok: false; reason: string };
  try {
    outcome = await makeChange(claim.clinicId, claim.action, input.now);
  } catch (error) {
    log.error("support action failed", { clinicId: claim.clinicId, field: claim.action.key, error: describeError(error) });
    outcome = { ok: false, reason: COULD_NOT_RUN };
  }
  const settled: SupportAction = outcome.ok
    ? { ...claim.action, status: "done", reason: null, at }
    : { ...claim.action, status: "refused", reason: keptReason(outcome.reason) ?? COULD_NOT_RUN, at };
  await setRowAction(unsafeDb, input.messageId, settled);
  log.info("support action run", { clinicId: claim.clinicId, field: settled.key, code: settled.status });
  return settled;
}
