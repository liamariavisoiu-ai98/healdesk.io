import {
  ASSISTANT_LANGUAGE_NAMES,
  isScreenedLanguage,
  SCREENED_LANGUAGES,
  ASSISTANT_TONE_OPTIONS,
  CARRIERS,
  CHANNEL_NAMES,
  COVERAGE_MODE_OPTIONS,
  AFTER_HOURS_ONLY_LANDLINE_NOTE,
  audienceFor,
  FORWARDING_PASS_THROUGH_DAYS,
  forwardingInstructions,
  isCarrier,
  shortClinicName,
  type Carrier,
  type Channel,
  type CoverageModeId,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics, type DepositUncollectable } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { connectConfigured } from "@/lib/billing/connect";
import { getDepositSettings, switchFactsOf } from "@/lib/billing/deposits";
import { GRACE_DAYS } from "@/lib/billing/events";
import {
  connectedMetaPlatforms,
  DEFAULT_META_PLATFORM_SWITCHES,
  META_PLATFORM_NAMES,
  readMetaPlatformSwitches,
} from "@/lib/channels/meta-platforms";
import { getBillingSummary } from "@/lib/billing/summary";
import { disclosureFor } from "@/lib/compliance/disclosure";
import type { MetaPlatform } from "@/lib/meta/front-door";
import { readMetaConnectView, type MetaConnectView } from "@/lib/meta/reconnect";
import { urgentAlertReadiness } from "@/lib/notices/urgent-readiness";
import { channelStatusWord } from "@/lib/setup/channels";
import { channelPresentation, metaNeedsReconnect, type ChannelPresentation } from "@/lib/setup/channel-status";
import { defaultChatGreeting, defaultPhoneGreeting } from "@/lib/setup/greetings";
import { formatPhone } from "@/lib/setup/help";
import { wizardFinished } from "@/lib/setup/screens";
import type { SetupState } from "@/lib/setup/state";
import { urgentHelpField } from "@/lib/setup/urgent";
import { withTenant } from "@/lib/tenant";

import { appliesWhen } from "./applies";
import { switchRules } from "./switch-rules";
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
    /** The channel's own switch; null for the Meta channel, whose switches are its platforms'. */
    key: SettingKey | null;
    name: string;
    on: boolean;
    /** Where the channel stands, with its time where it has one: the wizard's label (channelStatusLabel). */
    statusLabel: string;
    line: string;
    /** The channel's status, detail and one button (lib/setup/channel-status.ts), the same reading the wizard draws. */
    presentation: ChannelPresentation;
    switchLine: string;
    applies: string | null;
    /**
     * The Meta channel's Instagram, Messenger and WhatsApp switches (spec,
     * "Every switch in the portal"), one for each platform the clinic has
     * connected; empty for every other channel, and for Meta until a
     * platform is connected.
     */
    platforms: {
      platform: MetaPlatform;
      key: SettingKey;
      name: string;
      on: boolean;
      statusLabel: string;
      switchLine: string;
    }[];
  }[];
  bought: { web: boolean; meta: boolean; voice: boolean };
  /** The Facebook / Instagram / Messenger and WhatsApp connections (Connect and Reconnect); null when Meta isn't bought. */
  metaConnect: MetaConnectView | null;
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
    /** What patients call the clinic: the saved short name ("" when unset) and the one AYA works out otherwise. */
    shortName: { value: string; worked: string };
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
    /** Text the payment link after a call (clinic switch; default off). */
    textPaymentLink: boolean;
    /** What the assistant asks the patient to pay. */
    paymentAsk: "deposit_only" | "full_payment";
    /** Which payment switches can be used now, and why not: the one answer (switch-rules.ts). */
    rules: ReturnType<typeof switchRules>;
    autoConfirm: boolean;
    calendarConnected: boolean;
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
    /**
     * Whether an urgent alert raised now would reach the clinic
     * (urgentAlertReadiness, lib/notices/urgent-readiness.ts), the same read
     * the wizard's urgent screen and the urgent reply make. The card says
     * alerts arrive only while it holds, and plainly that they are not
     * switched on yet while it does not.
     */
    urgentAlertsReady: boolean;
    dailySummary: boolean;
    transferLiveCalls: boolean;
    transferNumber: string;
    transferIsSet: boolean;
    transferPlaceholder: string;
  };
  // No Records card: there is no transcript to keep (owner, 13 October 2026;
  // BAA 1.4.0 clause 11), so nothing here offers how long one is kept.
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
    const meta = bought.meta
      ? {
          switches: await readMetaPlatformSwitches(tx.db, tx.clinicId),
          connected: await connectedMetaPlatforms(tx.db, tx.clinicId),
          connect: await readMetaConnectView(tx.db, tx.clinicId),
        }
      : { switches: { ...DEFAULT_META_PLATFORM_SWITCHES }, connected: [] as MetaPlatform[], connect: null };
    // Never throws: every check inside fails closed.
    const urgentAlerts = await urgentAlertReadiness(tx);
    return {
      deposits,
      urgentAlertsReady: urgentAlerts.ready,
      carrier: phone?.carrier ?? null,
      phoneSystem: phone?.phoneSystem ?? null,
      meta,
    };
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
  // Website chat's alone: Instagram, Messenger and WhatsApp never say it.
  if (bought.web) {
    greetings.push({
      key: "chat_greeting",
      lockedLine: disclosureFor({ clinicName: clinic.name, channel: "web_chat" }),
      text: settings.chatGreeting ?? defaultChatGreeting(),
      isDefault: settings.chatGreeting === null,
    });
  }

  const urgent = urgentHelpField(state);
  return {
    slug,
    audience: audienceFor(clinic.specialty),
    bought,
    metaConnect: tenant.meta.connect,
    applies,
    channels: state.channels.map((c) => {
      const presentation = channelPresentation(c, {
        setupFinished: finished,
        timeZone: clinic.timezone,
        now,
        needsReconnect: c.channel === "meta" && metaNeedsReconnect(tenant.meta.connect),
      });
      const statusLabel = presentation.label;
      if (c.channel === "meta") {
        return {
          channel: c.channel,
          key: null,
          name: CHANNEL_NAMES[c.channel],
          on: c.enabled,
          statusLabel,
          line: presentation.detail,
          presentation,
          switchLine: SWITCH_LINES[c.channel],
          applies: applies.channel_instagram ?? null,
          platforms: tenant.meta.connected.map((platform) => {
            const on = tenant.meta.switches[platform];
            return {
              platform,
              key: `channel_${platform}` as SettingKey,
              name: META_PLATFORM_NAMES[platform],
              on,
              // Off is the platform's own. A pause is clinic-wide, so it is true of
              // every platform; but the Meta channel's live date is the first
              // platform's, and one connected later did not go live then, so a
              // live platform says only that it is live.
              statusLabel: !on
                ? channelStatusWord("off")
                : presentation.kind === "live"
                  ? channelStatusWord("live")
                  : statusLabel,
              switchLine: `Off leaves ${META_PLATFORM_NAMES[platform]} messages for your team to answer in ${META_PLATFORM_NAMES[platform]}.`,
            };
          }),
        };
      }
      const key = `channel_${c.channel}` as SettingKey;
      return {
        channel: c.channel,
        key,
        name: CHANNEL_NAMES[c.channel],
        on: c.enabled,
        statusLabel,
        line: presentation.detail,
        presentation,
        switchLine: SWITCH_LINES[c.channel],
        applies: applies[key] ?? null,
        platforms: [],
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
      shortName: { value: settings.shortName ?? "", worked: shortClinicName(clinic.name) },
      // Only the languages the screens read are offered, and shown as chosen.
      languages: settings.languages.filter(isScreenedLanguage),
      languageOptions: SCREENED_LANGUAGES.map((id) => ({
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
      // On only in effect: a stored choice the rules lock reads as off.
      textPaymentLink:
        tenant.deposits.textPaymentLink &&
        switchRules(switchFactsOf(tenant.deposits)).text_payment_link.enabled,
      paymentAsk: tenant.deposits.paymentAsk,
      autoConfirm: tenant.deposits.autoConfirm,
      calendarConnected: tenant.deposits.calendarConnected,
      // The same facts readPaymentFacts reads (switch-resets.ts), from the
      // deposit settings already read above, so the page and the writer that
      // refuses a crafted request give one answer.
      rules: switchRules(switchFactsOf(tenant.deposits)),
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
            settings.coverageMode,
          )
        : [],
    },
    alerts: {
      address: state.address,
      urgentAlertsReady: tenant.urgentAlertsReady,
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
 *
 * Except at the end of the plan. The contact form keeps a visitor's message
 * for the practice, and once the service has ended nothing new about a
 * patient may be kept (BAA clause 17: after termination healdesk uses PHI
 * only to return or destroy it; lib/chat/contact-form.ts, keepsMessages), so
 * the widget takes nothing and shows the practice's number to call instead.
 * The spec puts the contact form on the pause and the allowance cap only;
 * its failure rule for a cancellation is the direct line (spec, "Non-payment
 * never produces a dead phone line"). Until 19 October this row said the
 * chat "shows a contact form" after the plan ended, which it never did.
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
    { when: "Your plan ends", then: planEndLine(bought) },
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

/** What happens on each channel bought once the plan has ended: see failureLines. */
function planEndLine(bought: { web: boolean; meta: boolean; voice: boolean }): string {
  const parts: string[] = [];
  if (bought.voice) {
    parts.push(
      `For ${FORWARDING_PASS_THROUGH_DAYS} days calls still reach your direct line through us, while you undo call forwarding.`,
    );
  }
  if (bought.web) {
    parts.push(
      "Website chat takes no more messages: it asks visitors to call your practice instead, until you remove its line from your site.",
    );
  }
  if (bought.meta) parts.push("Messages wait for your team in the apps.");
  return parts.length ? parts.join(" ") : "Nothing changes for anyone.";
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
 * "How to undo call forwarding" (plan Part F2): the catalog's undo steps for
 * the clinic's own carrier when we know it, otherwise for each carrier,
 * matching how the clinic's coverage mode forwards its calls: all-call
 * forwarding's cancel for All calls and for After hours only (which switches
 * it on at closing), and for Overflow and after hours the cancel for each
 * condition it set, busy, no-answer and, where the line has them, not
 * reachable and AT&T's Safe Call Forwarding. A carrier that sells more than
 * one kind of line gets a step per kind, and a step with nothing to dial
 * (call or ask the carrier, a setting on the phone) has an empty `dial`.
 * Undoing needs no number, so these are right whatever AYA's number is.
 * Exported for its test.
 */
export function undoSteps(
  carrier: Carrier | null,
  phoneSystem: "landline" | "voip",
  routing: CoverageModeId,
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
