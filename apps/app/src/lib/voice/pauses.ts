/**
 * Pauses a person makes on a call (owner, 1 November 2026, approving
 * docs/design/demo-aya-simpler-2026-11-01.md section 4): after "let me pull
 * up Thursday..." a front desk takes a moment to look, and a booking lands
 * before the deposit is mentioned. Our calendar answers in milliseconds, so
 * the moment is made on purpose.
 *
 * A fixed line marks a pause with `pause(kind)`. The call (retell.ts) sends
 * the words before it, waits for them to be spoken (estimated from their
 * length, SPOKEN_WORDS_PER_SECOND) plus the pause's silence, then sends the
 * rest. A marker never reaches Retell, the transcript or the model's history
 * (withoutPauses). The urgent line and the opening line carry none.
 *
 * The silences are the owner-approved estimates of ordinary front-desk work,
 * not measurements; a hurried caller gets half (HURRIED_SHARE).
 */

export type PauseKind = "lookup" | "lookupAgain" | "hold" | "write" | "policy" | "beat" | "think";

/** Silence after the words before the marker, in milliseconds. */
export const PAUSE_MS: Readonly<Record<PauseKind, number>> = {
  // Free times for a day, or a provider's schedule.
  lookup: 1200,
  // Another day, the calendar already open.
  lookupAgain: 700,
  // Holding the time picked.
  hold: 1000,
  // Writing the booking at the end.
  write: 1500,
  // Checking a policy (deposit, cancellation).
  policy: 500,
  // After sympathy, or between the booking and the deposit.
  beat: 400,
  // After "Good question." before "I'd have to check".
  think: 300,
};

/** A hurried caller's share of each silence. */
export const HURRIED_SHARE = 0.5;

/** How fast a reply is spoken, for when its words will have finished (Retell's voice at speed 1.05: about 165 words a minute). */
export const SPOKEN_WORDS_PER_SECOND = 2.75;

const MARK = /\s*⟪(lookup|lookupAgain|hold|write|policy|beat|think)⟫\s*/g;

export function pause(kind: PauseKind): string {
  return `⟪${kind}⟫`;
}

/** The text with its markers taken out: what is said, kept and shown to the model. */
export function withoutPauses(text: string): string {
  return text.replace(MARK, " ").replace(/\s{2,}/g, " ").trim();
}

/** The text cut at its markers: each piece with the silence to leave before it (0 for the first). */
export function splitPauses(text: string): { text: string; pauseMs: number }[] {
  const pieces: { text: string; pauseMs: number }[] = [];
  let last = 0;
  let pending = 0;
  for (const m of text.matchAll(MARK)) {
    const before = text.slice(last, m.index).trim();
    if (before) pieces.push({ text: before, pauseMs: pending });
    pending = PAUSE_MS[m[1] as PauseKind];
    last = m.index! + m[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) pieces.push({ text: rest, pauseMs: pieces.length > 0 || last > 0 ? pending : 0 });
  return pieces;
}

/** How long words take to say, in milliseconds. */
export function speakingMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round((words / SPOKEN_WORDS_PER_SECOND) * 1000);
}

/**
 * A lookup line said before the times when nothing was said yet this turn
 * ("what do you have Thursday?" answered by the tool layer, or a reply the
 * tool layer replaced): never a name the clinic did not list, never the same
 * line twice in a call, and never the day, which the times line says itself.
 */
export function lookupLine(_day: string | null, said: readonly string[], again: boolean): string {
  // Never the day itself: the times line names it ("Let me pull up Thursday... Thursday the 5th, I've got" said it twice).
  const lines = again
    ? ["Let me check...", "One sec, let me look...", "Let me take another look..."]
    : ["Let me pull up our calendar...", "Let me take a look...", "Let me check what we have..."];
  return lines.find((line) => !said.some((s) => s.includes(line))) ?? lines[lines.length - 1]!;
}

/** Lines said before holding the picked time, and before writing the booking: varied, never twice in a call. */
export function holdLine(said: readonly string[]): string {
  const lines = ["Let me grab that for you...", "Okay, let me hold that...", "One sec..."];
  return lines.find((line) => !said.some((s) => s.includes(line))) ?? lines[lines.length - 1]!;
}
export function writeLine(said: readonly string[]): string {
  const lines = ["Okay, putting that in now...", "Let me pop that in...", "Just writing that in..."];
  return lines.find((line) => !said.some((s) => s.includes(line))) ?? lines[lines.length - 1]!;
}

/** withoutPauses, keeping the leading space a piece sent after others carries. */
export function withoutPausesKeepingLead(text: string): string {
  if (!text.includes("⟪")) return text;
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  const rest = withoutPauses(text);
  return rest ? `${lead}${rest}` : "";
}
