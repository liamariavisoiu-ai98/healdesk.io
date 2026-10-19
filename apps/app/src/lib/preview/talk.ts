import type { ActorContext } from "@/lib/audit";
import { assistantFacts, type AssistantFacts } from "@/lib/assistant/facts";
import { openingLine } from "@/lib/assistant/opening";
import {
  answerTurn,
  EMPTY_CAPTURE,
  type AssistantResponder,
  type BookingCapture,
  type TurnSource,
} from "@/lib/assistant/turn";
import { slotLabel } from "@/lib/booking/calendar";
import {
  offerTimes as engineOfferTimes,
  type OfferTimes,
  type OfferTimesInput,
} from "@/lib/booking/engine";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import type { TranscriptTurn } from "@/lib/conversations/transcript-email";
import { getCalendarConnection } from "@/lib/connections/google-calendar";
import { readPracticeState } from "@/lib/engine/practice/store";
import { describeError, log } from "@/lib/log";
import { readSetupState } from "@/lib/setup/state";
import { buildTracker, type Stage } from "@/lib/setup/tracker";
import { withTenant } from "@/lib/tenant";

import {
  PREVIEW_LIMIT_LINES,
  PREVIEW_LIMITS,
  takePreviewTurn,
  type PreviewLimitHit,
  type PreviewLimits,
} from "./limits";

/**
 * Talk to your AYA (plan Part G; spec, "Portal map", Home): the practice's
 * own preview of its assistant, at /c/<slug>/preview behind its sign-in.
 *
 * The same brain web chat answers with (answerTurn, lib/assistant/turn.ts),
 * on the web chat's channel and so its model settings
 * (lib/assistant/responder.ts, MODEL_CONFIG.web_chat), from the facts web
 * chat reads (assistantFacts, the approved script) and opening with the line
 * web chat opens with (lib/assistant/opening.ts). The urgent screen, the card
 * cut and the guard run as they do for a patient, and their fixed lines are
 * what the preview shows.
 *
 * What it does not do is everything the web chat adapter does around the
 * brain (lib/chat/web-chat.ts), because none of it is about a patient:
 *
 *   - no answer gate, no usage, no conversation row, no transcript, no
 *     booking request and no desk link: nothing here is a patient
 *     conversation, so it never counts as one, and never as a channel's
 *     first answer (the first_answer writer reads conversations a channel
 *     answered, and the preview writes none);
 *   - no alert on an urgent message: the fixed reply shows, and
 *     notifyBookingAlert is never called (this module does not import it);
 *   - dry tools only: when the person in the preview wants a booking and a
 *     calendar is connected, the calendar's real free times for that
 *     service, through the booking engine's offerTimes, which holds nothing.
 *     No hold, no write, no request. Reading them opens the calendar's
 *     credential, which the calendar layer records as it does every open.
 *
 * Nothing is stored. The browser holds the conversation, as the support chat
 * does, and sends it back with each message; this reads it, answers, and
 * forgets it. Each turn spends tokens, so it is capped per conversation, per
 * device and per practice a day (./limits.ts), with a fixed line when a cap
 * is reached.
 *
 * It opens when the build tracker is complete (lib/setup/tracker.ts) and
 * closes again while anything blocks it, such as a change still being
 * checked by the practice questions: the preview shows the assistant the
 * practice questions passed, never one they have not.
 */

/** One line of the conversation as the browser holds it, after the opening line. */
export type PreviewLine = { speaker: "person" | "assistant"; text: string };

/** What the calendar says about a booking the person in the preview asked for. */
export type PreviewAvailability =
  /** The calendar's free start times for the service, in the practice's own clock. Nothing is held. */
  | { status: "times"; service: string | null; times: string[] }
  /** The calendar is connected and the practice takes requests (its terms, its mode or a deposit). */
  | { status: "requests" }
  /** No healthy calendar connection: bookings arrive as requests. */
  | { status: "no_calendar" }
  /** Google did not answer this time. */
  | { status: "unavailable" };

export type PreviewReply =
  | {
      mode: "reply";
      reply: string;
      source: TurnSource;
      /** What AYA has collected for a booking so far: the browser keeps it and sends it back. */
      capture: BookingCapture;
      /** The urgent screen answered: the fixed reply, and in the preview no alert. */
      urgent: boolean;
      /** AYA ended the conversation. */
      ended: boolean;
      availability: PreviewAvailability | null;
    }
  | { mode: "limited"; hit: PreviewLimitHit; line: string }
  | { mode: "locked"; left: string[] }
  | { mode: "closed" }
  | { mode: "invalid"; reason: "history" | "text" };

export type PreviewAccess =
  | {
      status: "open";
      facts: AssistantFacts;
      /** The line the preview opens with: web chat's. */
      opening: string;
      calendarConnected: boolean;
    }
  | { status: "locked"; left: string[]; stages: Stage[] }
  | { status: "closed" };

export type PreviewDeps = {
  responder: AssistantResponder | null;
  /** The booking engine's offerTimes; tests pass a fake. */
  offerTimes?: (clinicId: string, input: OfferTimesInput) => Promise<OfferTimes>;
  limits?: PreviewLimits;
  now?: Date;
};

/** Who is asking: the practice, its sign-in, and the device (the SHA-256 of its session token). */
export type PreviewWho = {
  clinicId: string;
  userId: string;
  deviceKey: string;
  actor: ActorContext;
};

const MAX_TEXT = 2_000;
const MAX_FIELD = 120;
/** How many free times the preview shows. */
const TIMES_SHOWN = 5;

// -----------------------------------------------------------------------------
// The door
// -----------------------------------------------------------------------------

/**
 * Whether the preview is open for this practice, and if so what it answers
 * from. Reads only: the setup state and the practice questions (the
 * tracker's stages), whether the practice has left, the facts web chat
 * answers from, and the calendar connection.
 */
export async function previewAccess(input: {
  clinicId: string;
  userId: string;
  actor: ActorContext;
  now: Date;
}): Promise<PreviewAccess> {
  const read = await withTenant({ clinicId: input.clinicId, actor: input.actor }, async (tx) => {
    const state = await readSetupState(tx, { userId: input.userId, now: input.now });
    if (!state || state.clinic.offboardingStartedAt) return null;
    if (await clinicHasLeft(tx, { lock: false })) return null;
    return { state, practice: await readPracticeState(tx), facts: await assistantFacts(tx) };
  });
  if (!read || !read.facts) return { status: "closed" };
  const calendar = await getCalendarConnection(input.clinicId, { actor: input.actor });
  const tracker = buildTracker(read.state, calendar, read.practice);
  if (!tracker.previewUnlocked) {
    return { status: "locked", left: tracker.left, stages: tracker.stages };
  }
  return {
    status: "open",
    facts: read.facts,
    opening: openingLine(read.facts, "web_chat"),
    calendarConnected: calendar.status === "active" || calendar.status === "degraded",
  };
}

// -----------------------------------------------------------------------------
// One turn
// -----------------------------------------------------------------------------

/**
 * One message in the preview, answered. Never throws for anything the
 * browser sent: a malformed conversation is `invalid`, and a model that
 * fails answers with the brain's fixed failure line.
 */
export async function previewTurn(
  who: PreviewWho,
  input: unknown,
  deps: PreviewDeps,
): Promise<PreviewReply> {
  const now = deps.now ?? new Date();
  const limits = deps.limits ?? PREVIEW_LIMITS;
  const parsed = readPreviewInput(input, limits.sessionTurns);
  if (!parsed.ok) {
    return parsed.reason === "too_long"
      ? { mode: "limited", hit: "session", line: PREVIEW_LIMIT_LINES.session }
      : { mode: "invalid", reason: parsed.reason };
  }

  const access = await previewAccess({
    clinicId: who.clinicId,
    userId: who.userId,
    actor: who.actor,
    now,
  });
  if (access.status === "closed") return { mode: "closed" };
  if (access.status === "locked") return { mode: "locked", left: access.left };

  const taken = takePreviewTurn(
    {
      clinicId: who.clinicId,
      deviceKey: who.deviceKey,
      timeZone: access.facts.timeZone,
      priorTurns: parsed.history.filter((line) => line.speaker === "person").length,
      now,
    },
    limits,
  );
  if (!taken.ok) return { mode: "limited", hit: taken.hit, line: PREVIEW_LIMIT_LINES[taken.hit] };

  const history: TranscriptTurn[] = [
    { speaker: "assistant", text: access.opening },
    ...parsed.history,
  ];
  const turn = await answerTurn({
    facts: access.facts,
    channel: "web_chat",
    history,
    text: parsed.text,
    capture: parsed.capture,
    responder: deps.responder,
    now,
  });

  const availability =
    turn.source === "model" && asksForTimes(parsed.capture, turn.capture)
      ? await previewAvailability(
          who.clinicId,
          {
            service: turn.capture.service,
            connected: access.calendarConnected,
            holderKey: `preview:${who.deviceKey}`,
            actor: who.actor,
            now,
          },
          deps.offerTimes ?? engineOfferTimes,
        )
      : null;

  return {
    mode: "reply",
    reply: turn.reply,
    source: turn.source,
    capture: turn.capture,
    urgent: turn.urgent,
    ended: turn.end,
    availability,
  };
}

/**
 * Whether this turn is the one to show times: the person has just said they
 * want a booking, or named another service. Not every turn after, so a
 * conversation about a booking reads the calendar once per service.
 */
export function asksForTimes(before: BookingCapture, after: BookingCapture): boolean {
  if (!after.wants) return false;
  return !before.wants || (after.service ?? null) !== (before.service ?? null);
}

/**
 * The dry availability tool: the calendar's real free times for the service,
 * through the booking engine's offerTimes, which holds and writes nothing.
 * Without a healthy connection the engine is not asked.
 */
export async function previewAvailability(
  clinicId: string,
  input: {
    service: string | null;
    connected: boolean;
    holderKey: string;
    actor: ActorContext;
    now: Date;
  },
  offer: (clinicId: string, input: OfferTimesInput) => Promise<OfferTimes> = engineOfferTimes,
): Promise<PreviewAvailability> {
  if (!input.connected) return { status: "no_calendar" };
  let offered: OfferTimes;
  try {
    offered = await offer(clinicId, {
      channel: "web_chat",
      holderKey: input.holderKey,
      service: input.service,
      now: input.now,
      actor: input.actor,
    });
  } catch (error) {
    log.warn("preview could not read the calendar", { clinicId, error: describeError(error) });
    return { status: "unavailable" };
  }
  if (offered.status === "ok") {
    return {
      status: "times",
      service: offered.canonicalService,
      times: offered.slots
        .slice(0, TIMES_SHOWN)
        .map((slot) => slotLabel(slot.at, offered.timeZone)),
    };
  }
  return offered.status === "request_only" ? { status: "requests" } : { status: "unavailable" };
}

// -----------------------------------------------------------------------------
// What the browser sends
// -----------------------------------------------------------------------------

type ParsedInput =
  | { ok: true; history: PreviewLine[]; text: string; capture: BookingCapture }
  | { ok: false; reason: "history" | "text" | "too_long" };

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
  return text.length > 0 ? text : null;
}

/**
 * The browser's message: `{ history, text, capture }`. The history is what
 * the browser shows after the opening line, at most two lines a turn for
 * `sessionTurns` turns; anything longer is a conversation past its cap. The
 * capture is what AYA collected so far, cleaned as the brain cleans the
 * model's (lib/assistant/turn.ts); a missing or malformed one starts empty.
 */
export function readPreviewInput(input: unknown, sessionTurns: number): ParsedInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, reason: "text" };
  const body = input as Record<string, unknown>;
  const raw = body.history ?? [];
  if (!Array.isArray(raw)) return { ok: false, reason: "history" };
  if (raw.length > sessionTurns * 2) return { ok: false, reason: "too_long" };
  const history: PreviewLine[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { ok: false, reason: "history" };
    const { speaker, text } = entry as Record<string, unknown>;
    if (speaker !== "person" && speaker !== "assistant") return { ok: false, reason: "history" };
    const said = clean(text, MAX_TEXT);
    if (!said) return { ok: false, reason: "history" };
    history.push({ speaker, text: said });
  }
  const text = clean(body.text, MAX_TEXT);
  if (!text) return { ok: false, reason: "text" };
  return { ok: true, history, text, capture: readCapture(body.capture) };
}

function readCapture(value: unknown): BookingCapture {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_CAPTURE;
  const c = value as Record<string, unknown>;
  const fields: Record<string, string> = {};
  if (c.fields && typeof c.fields === "object" && !Array.isArray(c.fields)) {
    for (const [key, v] of Object.entries(c.fields as Record<string, unknown>).slice(0, 20)) {
      const said = clean(v, MAX_FIELD);
      if (said && /^[a-z_]{1,40}$/.test(key)) fields[key] = said;
    }
  }
  return {
    wants: c.wants === true,
    firstName: clean(c.firstName, 60),
    phone: clean(c.phone, 30),
    window: clean(c.window, MAX_FIELD),
    altWindows: Array.isArray(c.altWindows)
      ? c.altWindows
          .map((w) => clean(w, MAX_FIELD))
          .filter((w): w is string => w !== null)
          .slice(0, 2)
      : [],
    service: clean(c.service, MAX_FIELD),
    fields,
  };
}
