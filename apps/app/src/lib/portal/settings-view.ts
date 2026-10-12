import {
  ASSISTANT_LANGUAGE_NAMES,
  ASSISTANT_LANGUAGES,
  ASSISTANT_TONE_OPTIONS,
  CARRIERS,
  CHANNEL_NAMES,
  COVERAGE_MODE_OPTIONS,
  AFTER_HOURS_ONLY_LANDLINE_NOTE,
  audienceFor,
  FORWARDING_PASS_THROUGH_DAYS,
  forwardingInstructions,
  isCarrier,
  type CallRouting,
  type Carrier,
  type Channel,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics, type DepositUncollectable } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { connectConfigured } from "@/lib/billing/connect";
import { getDepositSettings } from "@/lib/billing/deposits";
import { GRACE_DAYS } from "@/lib/billing/events";
import { getBillingSummary } from "@/lib/billing/summary";
import { disclosureFor } from "@/lib/compliance/disclosure";
import { channelNextStep, channelStatusWord, setupSentence } from "@/lib/setup/channels";
import { defaultChatGreeting, defaultPhoneGreeting } from "@/lib/setup/greetings";
import { formatPhone } from "@/lib/setup/help";
import { wizardFinished } from "@/lib/setup/screens";
import type { SetupState } from "@/lib/setup/state";
import { urgentHelpField } from "@/lib/setup/urgent";
import { withTenant } from "@/lib/tenant";

import { appliesWhen } from "./applies";
import { SETTING_CHANNELS, type SettingKey } from "./settings";

/**
 * What the Settings page shows (plan Part F2), as plain data for its cards:
 * every switch with its current value, its one line and, while the channels
 * it governs are not answering, "Applies when … opens". Read from the setup
 * state the page already has and one tenant transaction for the deposit
 * switches and the phone line's carrier. Business data only. The Calendar
 * card reads its own (settings-calendar.ts).
 */

export type SettingsView = {
  slug: string;
  audience: "patients" | "clients";
  channels: {
    channel: Channel;
    key: SettingKey;
    name: string;
    on: boolean;
    statusWord: string;
    line: string;
    switchLine: string;
    applies: string | null;
  }[];
  bought: { web: boolean; meta: boolean; voice: boolean };
  /** Each setting's "Applies when …" line, or null once its channels answer. */
  applies: Partial<Record<SettingKey, string | null>>;
  coverage: {
    mode: string;
    options: readonly { id: string; label: string; line: string }[];
    landlineNote: string;
  };
  talk: {
    tone: string;
    toneOptions: readonly { id: string; label: string; line: string }[];
    greetings: {
      key: "phone_greeting" | "chat_greeting";
      lockedLine: string;
      text: string;
      isDefault: boolean;
    }[];
    languages: string[];
    languageOptions: { id: string; label: string }[];
    suggestAddOns: boolean;
    mentionPromotions: boolean;
  };
  payments: {
    connectAvailable: boolean;
    isConnected: boolean;
    depositsEnabled: boolean;
    canEnable: boolean;
    hasDepositAmount: boolean;
    bookVoiceWithoutDeposit: boolean;
    bookChatWithoutDeposit: boolean;
    uncollectable: DepositUncollectable;
    holdMinutes: number;
    servicesWithDeposit: number;
  };
  safety: {
    directLine: string;
    directLineIsSet: boolean;
    urgent: { value: string; placeholder: string; hint: string };
    vet: boolean;
    vetReferral: string;
    /** "Keep going" or "Stop and fall back", as Billing has it; null without a billing row. */
    allowance: "allow" | "hard_cap" | null;
    failures: { when: string; then: string }[];
    undo: { carrier: string; steps: { label: string; dial: string }[] }[];
  };
  alerts: {
    address: string | null;
    dailySummary: boolean;
    transferLiveCalls: boolean;
    transferNumber: string;
    transferIsSet: boolean;
    transferPlaceholder: string;
  };
};

export async function readSettingsView(input: {
  slug: string;
  state: SetupState;
  actor: ActorContext;
  now?: Date;
}): Promise<SettingsView> {
  const { state, slug } = input;
  const now = input.now ?? new Date();
  const bought = {
    web: state.channels.some((c) => c.channel === "web"),
    meta: state.channels.some((c) => c.channel === "meta"),
    voice: state.channels.some((c) => c.channel === "voice"),
  };

  const tenant = await withTenant({ clinicId: state.clinic.id, actor: input.actor }, async (tx) => {
    const deposits = await getDepositSettings(tx);
    const [phone] = await tx.db
      .select({ carrier: clinics.carrier, phoneSystem: clinics.phoneSystemType })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    return { deposits, carrier: phone?.carrier ?? null, phoneSystem: phone?.phoneSystem ?? null };
  });
  const summary = await getBillingSummary(state.clinic.id, { now });
  const finished = wizardFinished(state.screens, state.progress);
  const { settings, clinic, knowledge } = state;

  const applies: Partial<Record<SettingKey, string | null>> = {};
  for (const key of Object.keys(SETTING_CHANNELS) as SettingKey[]) {
    applies[key] = appliesWhen(state.channels, SETTING_CHANNELS[key]);
  }

  const greetings: SettingsView["talk"]["greetings"] = [];
  if (bought.voice) {
    greetings.push({
      key: "phone_greeting",
      lockedLine: disclosureFor({ clinicName: clinic.name, channel: "voice" }),
      text: settings.phoneGreeting ?? defaultPhoneGreeting(clinic.name),
      isDefault: settings.phoneGreeting === null,
    });
  }
  if (bought.web || bought.meta) {
    greetings.push({
      key: "chat_greeting",
      lockedLine: disclosureFor({
        clinicName: clinic.name,
        channel: bought.web ? "web_chat" : "instagram_dm",
      }),
      text: settings.chatGreeting ?? defaultChatGreeting(),
      isDefault: settings.chatGreeting === null,
    });
  }

  const urgent = urgentHelpField(state);
  return {
    slug,
    audience: audienceFor(clinic.specialty),
    bought,
    applies,
    channels: state.channels.map((c) => {
      const key = `channel_${c.channel}` as SettingKey;
      return {
        channel: c.channel,
        key,
        name: CHANNEL_NAMES[c.channel],
        on: c.enabled,
        statusWord: channelStatusWord(c.status),
        line: setupSentence(c.channel, channelNextStep(c, finished)),
        switchLine: SWITCH_LINES[c.channel],
        applies: applies[key] ?? null,
      };
    }),
    coverage: {
      mode: settings.coverageMode,
      options: COVERAGE_MODE_OPTIONS,
      landlineNote: AFTER_HOURS_ONLY_LANDLINE_NOTE,
    },
    talk: {
      tone: settings.tone,
      toneOptions: ASSISTANT_TONE_OPTIONS,
      greetings,
      languages: [...settings.languages],
      languageOptions: ASSISTANT_LANGUAGES.map((id) => ({
        id,
        label: ASSISTANT_LANGUAGE_NAMES[id],
      })),
      suggestAddOns: settings.suggestAddOns,
      mentionPromotions: settings.mentionPromotions,
    },
    payments: {
      connectAvailable: connectConfigured(),
      isConnected: tenant.deposits.isConnected,
      depositsEnabled: tenant.deposits.depositsEnabled,
      canEnable: tenant.deposits.canEnable,
      hasDepositAmount: tenant.deposits.hasDepositAmount,
      bookVoiceWithoutDeposit: tenant.deposits.bookVoiceWithoutDeposit,
      bookChatWithoutDeposit: tenant.deposits.bookChatWithoutDeposit,
      uncollectable: tenant.deposits.depositUncollectable,
      holdMinutes: tenant.deposits.depositHoldMinutes,
      servicesWithDeposit: knowledge.services.filter((s) => (s.depositUsd ?? 0) > 0).length,
    },
    safety: {
      directLine: settings.directLineE164 ? formatPhone(settings.directLineE164) : "",
      directLineIsSet: settings.directLineE164 !== null,
      urgent,
      vet: clinic.regulatoryRegime === "non-hipaa",
      vetReferral: settings.vetReferralE164 ? formatPhone(settings.vetReferralE164) : "",
      allowance: summary?.overageMode ?? null,
      failures: failureLines({ bought, allowance: summary?.overageMode ?? null }),
      undo: bought.voice
        ? undoSteps(
            isCarrier(tenant.carrier) ? tenant.carrier : null,
            tenant.phoneSystem === "voip" ? "voip" : "landline",
            settings.coverageMode === "all_calls" ? "always" : "conditional",
          )
        : [],
    },
    alerts: {
      address: state.address,
      dailySummary: settings.dailySummary,
      transferLiveCalls: settings.transferLiveCalls,
      transferNumber: settings.transferE164 ? formatPhone(settings.transferE164) : "",
      transferIsSet: settings.transferE164 !== null,
      transferPlaceholder: settings.directLineE164 ? formatPhone(settings.directLineE164) : "",
    },
  };
}

/** Each channel switch's one line: what Off does (spec, "Every switch in the portal"). */
const SWITCH_LINES: Record<Channel, string> = {
  voice: "Off sends calls to your direct line.",
  web: "Off shows a contact form on your website instead.",
  meta: "Off leaves messages for your team to answer in the apps.",
};

/**
 * Safety net's read-only list (plan Part F2): what AYA does when something
 * stops her, in the clinic's words. Every path ends with a person: calls go
 * to the direct line, website chat becomes a contact form (CLAUDE.md,
 * "Failure").
 */
export function failureLines(input: {
  bought: { web: boolean; meta: boolean; voice: boolean };
  allowance: "allow" | "hard_cap" | null;
}): { when: string; then: string }[] {
  const { bought } = input;
  const calls = bought.voice ? "calls go to your direct line" : null;
  const chat = bought.web ? "website chat shows a contact form" : null;
  const dms = bought.meta ? "messages wait for your team in the apps" : null;
  const everywhere = sentence([calls, chat, dms]);
  const lines: { when: string; then: string }[] = [{ when: "AYA is paused", then: everywhere }];
  if (bought.voice)
    lines.push({ when: "Phone is switched off", then: "Calls go to your direct line." });
  lines.push(
    {
      when: "Your calendar disconnects",
      then: "Bookings arrive as requests your team confirms, until you reconnect it. We email you.",
    },
    {
      when: "Our system or one of our providers fails",
      then: `${everywhere.slice(0, -1)}, and we email you.`,
    },
    {
      when: "A payment fails",
      then: `We email you, and AYA keeps answering for ${GRACE_DAYS} days while it's put right. After that, ${lowerFirst(everywhere)}`,
    },
    {
      when: "Your plan ends",
      then: bought.voice
        ? `For ${FORWARDING_PASS_THROUGH_DAYS} days calls still reach your direct line through us, while you undo call forwarding.${chat ? " Website chat shows a contact form until you remove its line from your site." : ""}`
        : `${everywhere}`,
    },
  );
  if (input.allowance) {
    lines.push({
      when: "Your monthly allowance runs out",
      then:
        input.allowance === "hard_cap"
          ? `${everywhere.slice(0, -1)} until the next month's allowance starts. (You chose "Stop and fall back" in Billing.)`
          : 'AYA keeps answering, and the extra is billed in blocks of 100. (You chose "Keep going" in Billing.)',
    });
  }
  return lines;
}

function sentence(parts: (string | null)[]): string {
  const kept = parts.filter((p): p is string => p !== null);
  if (kept.length === 0) return "Nothing changes for anyone.";
  const joined =
    kept.length === 1 ? kept[0]! : `${kept.slice(0, -1).join(", ")} and ${kept.at(-1)}`;
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/**
 * "How to undo call forwarding" (plan Part F2): the codes for the clinic's
 * own carrier when we know it, otherwise for each carrier, matching how its
 * calls are forwarded (every call, or the busy and no-answer pair). Undoing
 * needs no number, so these are right whatever AYA's number is.
 */
function undoSteps(
  carrier: Carrier | null,
  phoneSystem: "landline" | "voip",
  routing: CallRouting,
): SettingsView["safety"]["undo"] {
  const carriers = carrier ? CARRIERS.filter((c) => c.id === carrier) : CARRIERS;
  return carriers.map((c) => ({
    carrier: c.name,
    steps: forwardingInstructions({
      carrier: c.id,
      phoneSystemType: phoneSystem,
      routing,
      destinationE164: "",
    }).undo,
  }));
}
