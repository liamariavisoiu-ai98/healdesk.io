import type { Channel } from "@healdesk/catalog";

import { getDepositSettings } from "@/lib/billing/deposits";
import { setAutoConfirm } from "@/lib/booking/mode";
import { connectedMetaPlatforms, META_PLATFORM_NAMES } from "@/lib/channels/meta-platforms";
import { readChannelStates } from "@/lib/channels/state";
import { readSettingSnapshot } from "@/lib/clinic/setting-changes";
import { SETTING_ENTRIES, settingValueToken, type SwitchOption } from "@/lib/clinic/setting-words";
import { googleCalendarConnection } from "@/lib/connections/google-calendar";
import { describeError, log } from "@/lib/log";
import type { MetaPlatform } from "@/lib/meta/front-door";
import { CLINIC_ONLY_MESSAGE, saveSetting, SENSITIVE_SETTINGS, SETTING_CHANNELS, SETTING_KEYS, type SettingKey } from "@/lib/portal/settings";
import { switchRules, type SwitchReset, type SwitchRule } from "@/lib/portal/switch-rules";
import { withTenant } from "@/lib/tenant";

import { actorFor, audit, clinicById, ok, opsProblem, stringArg, type Operator, type OpsOutcome } from "./api";
import { OPS_SWITCH_LABEL } from "./calendar-ops";

/**
 * A clinic's Settings switches, from our side (owner, 28 October 2026:
 * "Operators see a clinic's switches in /admin and can set them from our side
 * through the signed ops envelope"; lane contract portal-dashboard-lanes.md).
 *
 *   - `getClinicSwitches {clinicId}`, a read: every switch and choice the
 *     clinic's plan has, in SETTING_KEYS order and then Auto-confirm, each
 *     with its plain label, kind, current value, whether it can be used now
 *     and the one plain reason when not (lib/portal/switch-rules.ts, the one
 *     place the rules live), whether an operator may change it, and a
 *     choice's options. Text settings (greetings, numbers) are not switches
 *     and are not listed.
 *   - `setClinicSwitch {clinicId, key, value}`, a write: through the clinic's
 *     own door, saveSetting (Auto-confirm through setAutoConfirm), so the
 *     same validation, writers, audit trail and clinic notices apply, and the
 *     change is recorded for ops' email and Slack post like any other. The
 *     operator acts as a service named by their address, shown to the clinic
 *     as "healdesk support" (OPS_SWITCH_LABEL); the security event names the
 *     operator. Never where calls go (the direct line, the transfer number:
 *     the clinic's passkey step-up), and never a switch whose
 *     `operatorMayChange` is false.
 *
 * Settings of the practice, never a patient. A refusal answers 200 with
 * `{ ok: false, message }`, the sentence the clinic itself would be told.
 */

export type ClinicSwitchView = {
  key: string;
  label: string;
  kind: "switch" | "choice";
  value: boolean | string;
  enabled: boolean;
  reason: string | null;
  operatorMayChange: boolean;
  /** A choice's options; absent on a switch. */
  options?: SwitchOption[];
};

export type SetClinicSwitchState =
  | { ok: true; toast: string; resets: SwitchReset[] }
  | { ok: false; message: string; field?: string };

/** The keys an operator could see: the contract's settings that exist, then Auto-confirm. */
export function switchKeys(): string[] {
  return [...(SETTING_KEYS as readonly string[]), "auto_confirm"].filter((key) => {
    const entry = SETTING_ENTRIES[key];
    return entry !== undefined && entry.kind !== "text";
  });
}

/** Which rule of switch-rules.ts governs a key, if any. */
function ruleFor(key: string, rules: ReturnType<typeof switchRules>): SwitchRule | null {
  if (key === "deposits_enabled") return rules.deposits;
  if (key === "text_payment_link") return rules.text_payment_link;
  if (key === "payment_ask") return rules.full_payment;
  return null;
}

export type SwitchFactsRead = {
  snapshot: Record<string, unknown>;
  bought: Channel[];
  connectedMeta: MetaPlatform[];
  gatewayConnected: boolean;
  hasDepositAmount: boolean;
  calendarConnected: boolean;
};

/** The rows, from what was read. Pure: exported for the tests. */
export function switchViews(read: SwitchFactsRead): ClinicSwitchView[] {
  const rules = switchRules({
    gatewayConnected: read.gatewayConnected,
    hasDepositAmount: read.hasDepositAmount,
    calendarConnected: read.calendarConnected,
    autoConfirm: read.snapshot.auto_confirm === true,
    hasVoice: read.bought.includes("voice"),
  });
  const views: ClinicSwitchView[] = [];
  for (const key of switchKeys()) {
    const entry = SETTING_ENTRIES[key]!;
    const channels = (SETTING_CHANNELS as Readonly<Record<string, readonly Channel[] | undefined>>)[key];
    if (channels && !channels.some((c) => read.bought.includes(c))) continue;
    const raw = read.snapshot[key];
    const value: boolean | string =
      entry.kind === "switch" ? raw === true : typeof raw === "string" ? raw : String(raw ?? "");
    let enabled = true;
    let reason: string | null = null;
    const rule = ruleFor(key, rules);
    if (rule && !rule.enabled) {
      enabled = false;
      reason = rule.reason;
    }
    const platform = key.startsWith("channel_") ? (key.slice("channel_".length) as MetaPlatform) : null;
    if (platform && platform in META_PLATFORM_NAMES && !read.connectedMeta.includes(platform)) {
      enabled = false;
      reason = `${META_PLATFORM_NAMES[platform]} isn't connected yet.`;
    }
    views.push({
      key,
      label: entry.label,
      kind: entry.kind as "switch" | "choice",
      value,
      enabled,
      reason,
      operatorMayChange: entry.operatorMayChange,
      ...(entry.kind === "choice" ? { options: (entry.options ?? []).map((o) => ({ ...o })) } : {}),
    });
  }
  return views;
}

export async function opGetClinicSwitches(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  try {
    const read = await withTenant(
      { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
      async (tx): Promise<SwitchFactsRead> => {
        const now = new Date();
        const snapshot = await readSettingSnapshot(tx, now);
        const bought = (await readChannelStates(tx.db, tx.clinicId, now)).map((c) => c.channel);
        const deposits = await getDepositSettings(tx);
        const calendar = await googleCalendarConnection(tx);
        const connectedMeta = bought.includes("meta") ? await connectedMetaPlatforms(tx.db, tx.clinicId) : [];
        return {
          snapshot,
          bought,
          connectedMeta,
          gatewayConnected: deposits.isConnected,
          hasDepositAmount: deposits.hasDepositAmount,
          calendarConnected: calendar?.status === "active",
        };
      },
    );
    return ok({ switches: switchViews(read) });
  } catch (error) {
    log.error("clinic switches not read", { clinicId: clinic.id, error: describeError(error) });
    return opsProblem("The clinic's switches could not be read.", 500, "failed");
  }
}

/** Why an operator cannot set this key here, in the clinic's words; null when they can. */
export function operatorRefusal(key: string): string | null {
  if ((SENSITIVE_SETTINGS as ReadonlySet<string>).has(key)) {
    return CLINIC_ONLY_MESSAGE;
  }
  const entry = SETTING_ENTRIES[key];
  if (!entry || !switchKeys().includes(key)) return "That isn't one of the clinic's switches.";
  if (key === "coverage_mode") {
    return "Which calls reach AYA is the clinic's own choice in Settings, because its call forwarding steps follow it.";
  }
  if (!entry.operatorMayChange) return "Only the clinic can change this, in its own Settings.";
  return null;
}

export async function opSetClinicSwitch(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  const key = stringArg(args, "key", 64);
  if (!key) return opsProblem("A switch's key is required.", 400, "invalid_args");
  const value = args.value;
  if (typeof value !== "boolean" && typeof value !== "string") {
    return opsProblem("A switch's value is on or off, or a choice's id.", 400, "invalid_args");
  }
  const refusal = operatorRefusal(key);
  if (refusal) return ok({ ok: false, message: refusal, field: key } satisfies SetClinicSwitchState);

  if (key === "auto_confirm") {
    if (typeof value !== "boolean") {
      return ok({ ok: false, message: "Choose on or off.", field: key } satisfies SetClinicSwitchState);
    }
    const outcome = await setAutoConfirm(clinic.id, value, actorFor(operator), {
      request: operator.request,
      label: OPS_SWITCH_LABEL,
    });
    if (outcome.changed) {
      await audit(operator, "clinic_switch_set", { clinicId: clinic.id, key, value: value ? "on" : "off" });
    }
    const resets = (outcome as { resets?: SwitchReset[] }).resets ?? [];
    return ok({
      ok: true,
      toast: outcome.autoConfirm
        ? "Auto-confirm is on. AYA's bookings go straight into the calendar where it can write them."
        : "Auto-confirm is off. Every booking AYA takes is a request the team approves.",
      resets,
    } satisfies SetClinicSwitchState);
  }

  const result = await saveSetting(
    {
      clinicId: clinic.id,
      userId: null,
      actorLabel: OPS_SWITCH_LABEL,
      steppedUp: false,
      actor: actorFor(operator) as { type: "service"; serviceName: string },
    },
    key as SettingKey,
    value,
  );
  if (!result.ok) {
    return ok({ ok: false, message: result.message, field: result.field } satisfies SetClinicSwitchState);
  }
  await audit(operator, "clinic_switch_set", {
    clinicId: clinic.id,
    key,
    value: settingValueToken(key, value) ?? null,
  });
  const resets = (result as { resets?: SwitchReset[] }).resets ?? [];
  return ok({ ok: true, toast: result.toast, resets } satisfies SetClinicSwitchState);
}
