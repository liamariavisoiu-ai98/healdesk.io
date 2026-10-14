import {
  ASSISTANT_LANGUAGE_NAMES,
  ASSISTANT_TONE_OPTIONS,
  COVERAGE_MODE_OPTIONS,
  type AssistantLanguage,
  type AssistantTone,
  type Channel,
  type CoverageModeId,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics, type DepositUncollectable } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { requestPracticeQuestions } from "@/lib/engine/practice/store";
import type { PracticeSection } from "@/lib/engine/practice/types";
import { DepositSettingsError, setDepositSettings } from "@/lib/billing/deposits";
import { DIRECT_LINE_NEEDED_WHILE_LIVE, voiceIsLive } from "@/lib/billing/settings";
import {
  connectedMetaPlatforms,
  META_PLATFORM_NAMES,
  setMetaPlatformEnabled,
} from "@/lib/channels/meta-platforms";
import { ChannelSwitchError, setChannelEnabled } from "@/lib/channels/switch";
import type { MetaPlatform } from "@/lib/meta/front-door";
import { formatPhone } from "@/lib/setup/help";
import {
  saveDirectLine,
  saveSetupSettings,
  SetupSettingsError,
  toE164,
  type SetupSettingsPatch,
} from "@/lib/setup/settings";
import { readSetupState, type SetupState } from "@/lib/setup/state";
import { joinWords } from "@/lib/setup/tracker";
import { urgentHelpDefault, urgentHelpNumber } from "@/lib/setup/urgent";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { appliesWhen, CHANNEL_WORDS } from "./applies";

/**
 * Settings (plan Part F2; spec, "Every switch in the portal"): every switch
 * on one page, each saved the moment it is changed, with a toast that names
 * the consequence.
 *
 * One door for every switch, free of Next: the server action checks the
 * sign-in (requirePortal) and says whether a passkey step-up is live; this
 * validates, writes through each setting's one writer (lib/setup/settings.ts,
 * lib/billing/deposits.ts, lib/channels/switch.ts,
 * lib/channels/meta-platforms.ts) inside the clinic's tenant, and words the
 * result.
 *
 * The Meta channel has no switch of its own here: the spec gives Instagram,
 * Messenger and WhatsApp one each, and a platform's switch shows, and saves,
 * once that platform is connected. Every writer validates again on the server,
 * whatever the page sent.
 *
 * Where calls go is guarded twice over (plan Part D4): the direct line and
 * the transfer number need a passkey step-up to change once they are set
 * (the first time needs none, as in setup), keep their before and after in
 * clinic_settings_history, and email the clinic's address (O4).
 *
 * There is no setting for how long transcripts are kept. There was one
 * (Records, "Keep transcripts for", under BAA 1.3.0's "Practice may shorten
 * the period for transcripts in its portal"), until the owner decided on 13
 * October 2026 that healdesk keeps no transcript: each is emailed to the
 * clinic when its conversation ends (lib/conversations/transcript-email.ts),
 * and BAA 1.4.0 and the DPA give the clinic no period to shorten. The key is
 * gone, so a page that still sends it is refused as no setting at all; the
 * column it wrote stays (clinic_settings.transcript_retention_days), and a
 * value saved before only ever makes the purge delete sooner.
 *
 * A switch whose channels are not answering yet says so in its toast
 * ("Applies when phone opens.", lib/portal/applies.ts), so nothing claims an
 * effect "from now on" before anyone can feel it.
 */

export const SETTING_KEYS = [
  "channel_web",
  "channel_instagram",
  "channel_messenger",
  "channel_whatsapp",
  "channel_voice",
  "coverage_mode",
  "tone",
  "phone_greeting",
  "chat_greeting",
  "languages",
  "suggest_add_ons",
  "mention_promotions",
  "deposits_enabled",
  "book_voice_without_deposit",
  "book_chat_without_deposit",
  "deposit_uncollectable",
  "deposit_hold_minutes",
  "direct_line",
  "urgent_help",
  "vet_referral",
  "daily_summary",
  "transfer_live_calls",
  "transfer_number",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === "string" && (SETTING_KEYS as readonly string[]).includes(value);
}

/** The settings that change where calls go: a step-up once set, history, and O4 (Part D4). */
export const SENSITIVE_SETTINGS: ReadonlySet<SettingKey> = new Set<SettingKey>([
  "direct_line",
  "transfer_number",
]);

/** Which bought channels a setting belongs to; a clinic without any of them has no such setting. */
export const SETTING_CHANNELS: Readonly<Record<SettingKey, readonly Channel[]>> = {
  channel_web: ["web"],
  channel_instagram: ["meta"],
  channel_messenger: ["meta"],
  channel_whatsapp: ["meta"],
  channel_voice: ["voice"],
  coverage_mode: ["voice"],
  tone: ["web", "meta", "voice"],
  phone_greeting: ["voice"],
  chat_greeting: ["web", "meta"],
  languages: ["web", "meta", "voice"],
  // The signed agreement bars add-ons and promotions on the Meta channels.
  suggest_add_ons: ["web", "voice"],
  mention_promotions: ["web", "voice"],
  deposits_enabled: ["web", "meta", "voice"],
  book_voice_without_deposit: ["voice"],
  book_chat_without_deposit: ["web", "meta"],
  deposit_uncollectable: ["web", "meta"],
  deposit_hold_minutes: ["web", "meta"],
  direct_line: ["voice"],
  urgent_help: ["web", "meta", "voice"],
  vet_referral: ["web", "meta", "voice"],
  daily_summary: ["web", "meta", "voice"],
  transfer_live_calls: ["voice"],
  transfer_number: ["voice"],
};

/**
 * The settings the practice questions read (lib/engine/practice): how AYA
 * talks, and the numbers the urgent line gives. Changing one asks for the
 * questions to run again, two minutes after the last change.
 */
const PRACTICE_SETTINGS: Partial<Record<SettingKey, PracticeSection>> = {
  tone: "how_aya_talks",
  phone_greeting: "how_aya_talks",
  chat_greeting: "how_aya_talks",
  languages: "how_aya_talks",
  suggest_add_ons: "how_aya_talks",
  mention_promotions: "promotions",
  direct_line: "safety_net",
  urgent_help: "safety_net",
  vet_referral: "safety_net",
};

export type SettingContext = {
  clinicId: string;
  userId: string;
  /** The device whose passkey is live on this session, or the sign-in's own label. */
  actorLabel: string;
  /** Whether a passkey step-up is live on this session. */
  steppedUp: boolean;
};

export type SettingResult =
  { ok: true; toast: string } | { ok: false; field: string; message: string; needsStepUp?: true };

const STEP_UP_MESSAGE: Partial<Record<SettingKey, string>> = {
  direct_line:
    "Your direct line is where calls go whenever AYA can't answer, so changing it needs Face ID or your screen lock on a device you've added.",
  transfer_number:
    "The transfer number is where AYA puts live calls through, so changing it needs Face ID or your screen lock on a device you've added.",
};

/** setup's own wording for a number it can't read (lib/setup/settings.ts). */
const UNREADABLE_NUMBER =
  "Enter the number with its area code, like (415) 555-0100, or in international format starting with +.";

class Refusal extends Error {
  constructor(
    readonly field: string,
    message: string,
    readonly needsStepUp = false,
  ) {
    super(message);
    this.name = "SettingRefusal";
  }
}

export async function saveSetting(
  ctx: SettingContext,
  key: unknown,
  value: unknown,
  now: Date = new Date(),
): Promise<SettingResult> {
  if (!isSettingKey(key)) {
    return { ok: false, field: "key", message: "That isn't one of your settings." };
  }
  const actor: ActorContext = { type: "user", userId: ctx.userId, label: ctx.actorLabel };
  try {
    const toast = await withTenant({ clinicId: ctx.clinicId, actor }, async (tx) => {
      const state = await readSetupState(tx, { userId: ctx.userId, now });
      if (!state) throw new Refusal("key", "This clinic could not be found.");
      if (state.clinic.offboardingStartedAt) {
        throw new Refusal("key", "This account has closed, so its settings can't change.");
      }
      const bought = state.channels.map((c) => c.channel);
      if (!SETTING_CHANNELS[key].some((c) => bought.includes(c))) {
        throw new Refusal("key", "That setting isn't part of your plan.");
      }
      const consequence = await write(tx, state, ctx, key, value, now);
      const section = PRACTICE_SETTINGS[key];
      if (section) await requestPracticeQuestions(tx, { reason: "settings", section, now });
      const applies = appliesWhen(state.channels, SETTING_CHANNELS[key]);
      return applies ? `${consequence} ${applies}` : consequence;
    });
    return { ok: true, toast };
  } catch (error) {
    if (error instanceof Refusal) {
      return error.needsStepUp
        ? { ok: false, field: error.field, message: error.message, needsStepUp: true }
        : { ok: false, field: error.field, message: error.message };
    }
    if (
      error instanceof SetupSettingsError ||
      error instanceof ChannelSwitchError ||
      error instanceof DepositSettingsError
    ) {
      const field = "field" in error ? String(error.field) : "key";
      return { ok: false, field, message: error.message };
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// One setting's write, and the consequence it names
// -----------------------------------------------------------------------------

async function write(
  tx: TenantTx,
  state: SetupState,
  ctx: SettingContext,
  key: SettingKey,
  value: unknown,
  now: Date,
): Promise<string> {
  const label = ctx.actorLabel;
  const save = (patch: SetupSettingsPatch) => saveSetupSettings(tx, patch, label, now);

  switch (key) {
    case "channel_web":
    case "channel_voice": {
      const channel = key.slice("channel_".length) as Channel;
      const on = requireBoolean(value, key);
      await setChannelEnabled(tx, channel, on, label, now);
      return channelToast(channel, on, state.settings.directLineE164);
    }

    case "channel_instagram":
    case "channel_messenger":
    case "channel_whatsapp": {
      const platform = key.slice("channel_".length) as MetaPlatform;
      const on = requireBoolean(value, key);
      // Only a connected platform has a switch on the page; one that isn't
      // connected would be told it answers when nothing reaches it.
      if (!(await connectedMetaPlatforms(tx.db, tx.clinicId)).includes(platform)) {
        throw new Refusal(
          key,
          `${META_PLATFORM_NAMES[platform]} isn't connected yet. Its switch appears here once it is.`,
        );
      }
      await setMetaPlatformEnabled(tx, platform, on, label, now);
      return metaPlatformToast(platform, on);
    }

    case "coverage_mode": {
      const mode = COVERAGE_MODE_OPTIONS.find((o) => o.id === value);
      if (!mode) throw new Refusal(key, "Choose which calls reach AYA.");
      await save({ coverageMode: mode.id as CoverageModeId });
      return `${mode.label}: ${mode.line} Your call forwarding steps follow this choice.`;
    }

    case "tone": {
      const tone = ASSISTANT_TONE_OPTIONS.find((o) => o.id === value);
      if (!tone) throw new Refusal(key, "Choose warm or clinical.");
      await save({ tone: tone.id as AssistantTone });
      return `Tone: ${tone.label.toLowerCase()}. ${tone.line}`;
    }

    case "phone_greeting":
    case "chat_greeting": {
      if (value !== null && typeof value !== "string") {
        throw new Refusal(key, "Write the greeting as text.");
      }
      const field = key === "phone_greeting" ? "phoneGreeting" : "chatGreeting";
      const saved = await save({ [field]: value as string | null });
      const which = key === "phone_greeting" ? "Callers hear" : "People read";
      return saved[field] === null
        ? `Greeting back to the default. ${which} it after the line that says AYA is an AI assistant.`
        : `Greeting saved. ${which} it after the line that says AYA is an AI assistant.`;
    }

    case "languages": {
      if (!Array.isArray(value)) throw new Refusal(key, "Choose the languages AYA answers in.");
      const saved = await save({ languages: value as AssistantLanguage[] });
      return `AYA answers in ${joinWords(saved.languages.map((l) => ASSISTANT_LANGUAGE_NAMES[l]))}, in the language each person writes or speaks in.`;
    }

    case "suggest_add_ons": {
      const on = requireBoolean(value, key);
      await save({ suggestAddOns: on });
      return on
        ? "Add-on suggestions on. When AYA books someone she may suggest a complementary treatment, on phone and website chat."
        : "Add-on suggestions off. AYA keeps to what was asked.";
    }

    case "mention_promotions": {
      const on = requireBoolean(value, key);
      await save({ mentionPromotions: on });
      return on
        ? "Promotions on. AYA mentions what's in Knowledge → Promotions, on phone and website chat."
        : "Promotions off. AYA won't mention your promotions.";
    }

    case "deposits_enabled": {
      const on = requireBoolean(value, key);
      await setDepositSettings(tx, { depositsEnabled: on }, label, now);
      return on
        ? "Deposits on. In chat, AYA sends a secure payment link when a treatment needs a deposit; on a call she books it and flags the deposit for your team."
        : "Deposits off. AYA books without asking for a deposit.";
    }

    case "book_voice_without_deposit": {
      const on = requireBoolean(value, key);
      await setDepositSettings(tx, { bookVoiceWithoutDeposit: on }, label, now);
      return on
        ? "On a call, AYA books a treatment that needs a deposit and flags the deposit for your team to collect."
        : "On a call, AYA won't book a treatment that needs a deposit: she passes the caller to your team.";
    }

    case "book_chat_without_deposit": {
      const on = requireBoolean(value, key);
      await setDepositSettings(tx, { bookChatWithoutDeposit: on }, label, now);
      return on
        ? "In chat, AYA books without waiting for the deposit and flags it for your team."
        : "In chat, AYA sends the payment link first, so the slot is protected.";
    }

    case "deposit_uncollectable": {
      if (!isUncollectable(value)) {
        throw new Refusal(key, "Choose what happens when a deposit can't be collected.");
      }
      const saved = await setDepositSettings(tx, { depositUncollectable: value }, label, now);
      return uncollectableToast(value, saved.depositHoldMinutes);
    }

    case "deposit_hold_minutes": {
      const minutes = typeof value === "string" ? Number(value) : value;
      const saved = await setDepositSettings(
        tx,
        { depositHoldMinutes: minutes as number },
        label,
        now,
      );
      return `A slot waiting for its deposit is held for ${saved.depositHoldMinutes} minutes.`;
    }

    case "direct_line": {
      const raw = typeof value === "string" ? value.trim() : "";
      const current = state.settings.directLineE164;
      if (!raw) {
        // Never removed once set, and while phone is live, said in phone's
        // words (DIRECT_LINE_NEEDED_WHILE_LIVE, as the ops path says it).
        throw new Refusal(
          key,
          (await voiceIsLive(tx))
            ? DIRECT_LINE_NEEDED_WHILE_LIVE
            : current
              ? "Your direct line can be changed but not removed: calls need somewhere to go whenever AYA can't answer."
              : "Enter a number that reaches your team.",
        );
      }
      // A number that can't be read is refused before any step-up is asked
      // for: the step-up is for a real change, not a typo.
      const wanted = toE164(raw);
      if (!wanted) throw new Refusal(key, UNREADABLE_NUMBER);
      if (current && wanted !== current) requireStepUp(ctx, key);
      const saved = await saveDirectLine(tx, raw, label, now);
      return `Direct line: ${saved ? formatPhone(saved) : "not set"}. Calls go there whenever AYA can't answer.`;
    }

    case "urgent_help": {
      // As in setup 2.5: empty is "use the default" (the direct line, or the
      // main number without phone), resolved when the number is read, and a
      // number typed equal to the default is the default too, so it follows
      // the direct line instead of freezing a copy of it.
      const typed = typeof value === "string" ? value.trim() : "";
      const fallback = urgentHelpDefault(state);
      const sameAsDefault = typed !== "" && fallback !== null && toE164(typed) === fallback;
      const saved = await save({ urgentHelpE164: typed && !sameAsDefault ? typed : null });
      const number = urgentHelpNumber({ ...state, settings: saved });
      return number
        ? `Someone reporting something urgent is told to call 911 in an emergency, then given ${formatPhone(number)}.`
        : "Someone reporting something urgent is told to call 911 in an emergency. Add a number for urgent help so AYA can give them one.";
    }

    case "vet_referral": {
      if (state.clinic.regulatoryRegime !== "non-hipaa") {
        throw new Refusal(key, "An emergency referral clinic is for veterinary practices.");
      }
      const typed = typeof value === "string" ? value.trim() : "";
      if (!typed) {
        throw new Refusal(
          key,
          "Enter the emergency clinic you refer to. AYA gives it to anyone with an urgent problem.",
        );
      }
      const saved = await save({ vetReferralE164: typed });
      return `Someone with an urgent problem is given your emergency referral clinic, ${formatPhone(saved.vetReferralE164!)}.`;
    }

    case "daily_summary": {
      const on = requireBoolean(value, key);
      await save({ dailySummary: on });
      return on
        ? "Daily summary on. It arrives at the start of each working day."
        : "Daily summary off. Booking requests and urgent alerts still arrive the moment they happen.";
    }

    case "transfer_live_calls": {
      const on = requireBoolean(value, key);
      const saved = await save({ transferLiveCalls: on });
      const to = saved.transferE164 ?? saved.directLineE164;
      return on
        ? `Live transfers on. During opening hours AYA can put a caller through to ${to ? formatPhone(to) : "your direct line"}.`
        : "Live transfers off. When someone asks for a person, AYA takes their details for your team.";
    }

    case "transfer_number": {
      const raw = typeof value === "string" ? value.trim() : "";
      const current = state.settings.transferE164;
      const wanted = raw === "" ? null : toE164(raw);
      if (raw !== "" && !wanted) throw new Refusal(key, UNREADABLE_NUMBER);
      if (wanted) await refuseLoop(tx, wanted);
      if (current && wanted !== current) requireStepUp(ctx, key);
      const saved = await save({ transferE164: raw === "" ? null : raw });
      return saved.transferE164
        ? `Transfer number: ${formatPhone(saved.transferE164)}. Live transfers go there.`
        : "Live transfers go to your direct line.";
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Refusal(field, "Choose on or off.");
  return value;
}

/** A change to where calls go, after the value was first set, needs a live passkey step-up. */
function requireStepUp(ctx: SettingContext, key: SettingKey): void {
  if (!ctx.steppedUp) {
    throw new Refusal(
      key,
      STEP_UP_MESSAGE[key] ?? "This change needs Face ID or your screen lock.",
      true,
    );
  }
}

/**
 * A live transfer to the published number, which forwards to AYA, or to
 * AYA's own number, would come straight back to her (CLAUDE.md, "Failure"):
 * refused, as the direct line's writer refuses both (lib/billing/settings.ts).
 */
async function refuseLoop(tx: TenantTx, e164: string): Promise<void> {
  const [clinic] = await tx.db
    .select({ published: clinics.publishedPhoneE164, assistant: clinics.assistantNumberE164 })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (clinic?.published && clinic.published === e164) {
    throw new Refusal(
      "transfer_number",
      "The transfer number must be a different line from your main number: calls to your main number forward to AYA, so a transfer there would come straight back to her.",
    );
  }
  if (clinic?.assistant && clinic.assistant === e164) {
    throw new Refusal(
      "transfer_number",
      "The transfer number must be a line at the practice, not AYA's own number.",
    );
  }
}

const UNCOLLECTABLE: readonly DepositUncollectable[] = [
  "book_and_flag",
  "hold_and_alert",
  "decline_and_alert",
];

function isUncollectable(value: unknown): value is DepositUncollectable {
  return typeof value === "string" && (UNCOLLECTABLE as readonly string[]).includes(value);
}

function uncollectableToast(choice: DepositUncollectable, holdMinutes: number): string {
  switch (choice) {
    case "book_and_flag":
      return "When a deposit can't be collected, AYA books and flags it for your team.";
    case "hold_and_alert":
      return `When a deposit can't be collected, AYA holds the slot for ${holdMinutes} minutes and alerts your team.`;
    case "decline_and_alert":
      return "When a deposit can't be collected, AYA doesn't book, and alerts your team.";
  }
}

/** What switching a channel does, in one sentence (spec, Channels). */
export function channelToast(channel: Channel, on: boolean, directLine: string | null): string {
  if (on) {
    switch (channel) {
      case "voice":
        return "Phone is on. AYA answers the calls that reach her.";
      case "web":
        return "Website chat is on. AYA answers chats on your website.";
      case "meta":
        return "Instagram, Messenger & WhatsApp are on. AYA answers messages there.";
    }
  }
  switch (channel) {
    case "voice":
      return directLine
        ? `Phone is off. Calls go to your direct line, ${formatPhone(directLine)}.`
        : "Phone is off. Calls go to your direct line once you add one in Safety net.";
    case "web":
      return "Website chat is off. Your website shows a contact form instead.";
    case "meta":
      return `${capitalise(CHANNEL_WORDS.meta)} are off. Messages wait for your team in those apps.`;
  }
}

/** What switching Instagram, Messenger or WhatsApp does, in one sentence. */
export function metaPlatformToast(platform: MetaPlatform, on: boolean): string {
  const name = META_PLATFORM_NAMES[platform];
  return on
    ? `${name} is on. AYA answers messages there.`
    : `${name} is off. Messages there wait for your team in ${name}.`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
