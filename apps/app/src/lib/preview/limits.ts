/**
 * How much Talk to your AYA may be used (plan Part G: "Rate-limited, not
 * stored"). Every turn of the preview asks the web chat's model, so every
 * turn spends tokens on healdesk's key; these are a bound on our own spend
 * and on one runaway browser, never an authentication check (requirePortal
 * is that).
 *
 * Three caps, all counted per turn:
 *
 *   - **a conversation** (`sessionTurns`): the person's turns in one preview
 *     conversation. The browser holds the conversation and sends it back each
 *     turn, so this is read from what it sends, and a longer one is refused.
 *     It bounds what one turn costs, because each turn sends the whole
 *     conversation to the model; a browser that drops its history to go on
 *     gets a model that has forgotten it, and the two caps below still hold.
 *   - **a device** (`device`): the browser's own sign-in session, by the
 *     SHA-256 of its session token (never the token), in a window that
 *     starts at its first turn. A shared sign-in is used from several
 *     devices, so one of them cannot spend the practice's whole day.
 *   - **a practice a day** (`clinicDay`): every device together, per day on
 *     the practice's own clock, so the day ends at its midnight.
 *
 * A turn is counted only when every cap lets it through: a refused turn asks
 * nothing of the model and costs nothing, so counting it against the others
 * would only let one device's refusals use up the practice's day.
 *
 * In memory, the same shape as lib/connections/attempt-limit.ts and the
 * widget's limiter (lib/chat/widget-http.ts), with the same ceiling on
 * windows: nothing about the preview is written anywhere, this count
 * included. The effective ceiling is therefore the limit times the web
 * tier's instances, and a deploy starts every count again; both are bounds
 * on spend we accept for a preview, and a move to a shared store is a swap
 * of this module.
 */

export type PreviewLimits = {
  /** The person's turns in one preview conversation. */
  sessionTurns: number;
  /** Turns from one device in `device.windowMs`. */
  device: { limit: number; windowMs: number };
  /** Turns from one practice on one of its days. */
  clinicDay: number;
};

export const PREVIEW_LIMITS: PreviewLimits = {
  sessionTurns: 20,
  device: { limit: 40, windowMs: 60 * 60_000 },
  clinicDay: 150,
};

export type PreviewLimitHit = "session" | "device" | "clinic";

/** What the preview shows instead of a reply when a cap is reached. Fixed lines, never the model's. */
export const PREVIEW_LIMIT_LINES: Readonly<Record<PreviewLimitHit, string>> = {
  session:
    "This preview conversation is as long as it can go. Start a new one to keep talking to AYA.",
  device: "That's a lot of messages from this device in a short time. Try again in a few minutes.",
  clinic: "Your practice has used today's preview messages. The preview opens again tomorrow.",
};

const MAX_TRACKED_WINDOWS = 10_000;
const EVICTION_BATCH = MAX_TRACKED_WINDOWS / 10;
/** A day's window is kept a little over a day: its key carries the date, so it resets at midnight anyway. */
const DAY_KEEP_MS = 26 * 60 * 60_000;

const windows = new Map<string, { count: number; resetAt: number }>();

/** The practice's date on its own clock, YYYY-MM-DD; UTC when its zone cannot be read. */
export function clinicDate(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Take one turn for this conversation, device and practice, or say which cap
 * stops it. `priorTurns` is how many turns the person has already had in the
 * conversation the browser sent. Nothing is counted when a cap stops it.
 */
export function takePreviewTurn(
  input: {
    clinicId: string;
    deviceKey: string;
    timeZone: string;
    priorTurns: number;
    now: Date;
  },
  limits: PreviewLimits = PREVIEW_LIMITS,
): { ok: true } | { ok: false; hit: PreviewLimitHit } {
  if (input.priorTurns + 1 > limits.sessionTurns) return { ok: false, hit: "session" };
  const at = input.now.getTime();
  reclaim(at);
  const deviceKey = `d:${input.clinicId}:${input.deviceKey}`;
  const clinicKey = `c:${input.clinicId}:${clinicDate(input.now, input.timeZone)}`;
  const device = live(deviceKey, at);
  const clinic = live(clinicKey, at);
  if ((device?.count ?? 0) >= limits.device.limit) return { ok: false, hit: "device" };
  if ((clinic?.count ?? 0) >= limits.clinicDay) return { ok: false, hit: "clinic" };
  // No await between the checks and the counts: one turn at a time in this process.
  count(deviceKey, device, at + limits.device.windowMs);
  count(clinicKey, clinic, at + DAY_KEEP_MS);
  return { ok: true };
}

/** Every count forgotten. Tests only: production never resets a cap early. */
export function resetPreviewLimitsForTests(): void {
  windows.clear();
}

function live(key: string, at: number): { count: number; resetAt: number } | null {
  const window = windows.get(key);
  if (!window || window.resetAt <= at) return null;
  return window;
}

function count(key: string, window: { count: number; resetAt: number } | null, resetAt: number) {
  if (window) window.count += 1;
  else windows.set(key, { count: 1, resetAt });
}

function reclaim(at: number): void {
  if (windows.size < 1_000) return;
  for (const [key, window] of windows) {
    if (window.resetAt <= at) windows.delete(key);
  }
  if (windows.size < MAX_TRACKED_WINDOWS) return;
  const oldestFirst = [...windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  for (const [key] of oldestFirst.slice(0, EVICTION_BATCH)) windows.delete(key);
}
