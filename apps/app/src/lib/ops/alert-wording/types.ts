import type { OpsEvent } from "@/lib/ops/notify";

/**
 * What an ops alert says, in plain English (owner, 23 October 2026: "enough
 * context that the ops person understands the whole situation from the
 * message alone; short, plain, non-technical English; very detailed numbered
 * steps for what to do next"). The email (lib/email/templates/ops_alert.ts)
 * and the Slack copy (lib/ops/slack.ts) both render from one of these, through
 * the one substitution in ./render.ts, so the two never say different things.
 *
 * Text may name `{placeholders}`, drawn only from the alert's allow-listed
 * values (./allow-list.ts `wordingValues`): the clinic's or the requester's
 * business name, counts, days, the closed words. The syntax, all of it:
 *
 *   {key}          the value, formatted for reading (a day as "22 Oct", a
 *                  meter as "voice minutes"); when missing, the key's safe
 *                  fallback ("the clinic"), never `undefined`
 *   {key:noun}     a count with its noun, pluralised: "1 day", "8 days"
 *   [ ... ]        an optional clause, dropped whole when any placeholder in
 *                  it has no value
 *
 * `title` is at most 70 characters with the "healdesk ops: " subject prefix
 * (tests/ops-alert-wording.test.ts) and takes no placeholders: it is the
 * subject line and the inbox's one-glance name for the alert.
 */
export type AlertWording = {
  readonly title: string;
  /** Who or what is affected, by name, and since when. */
  readonly whatHappened: string;
  /** What goes wrong if nobody acts, and by when. Empty only while the event is in LEGACY_WORDING. */
  readonly whyItMatters: string;
  /** Numbered steps, safest first, each naming the console page or button; the last says what done looks like. */
  readonly steps: readonly string[];
  /**
   * One line, at most 90 characters, read first (lane N4): the clinic's name
   * when there is one, then what is wrong with the one fact that matters. It
   * replaces the first sentence of `whatHappened`, which then is not printed,
   * so it must carry what that sentence says. Placeholders as in the rest.
   * Without one, the renderer uses the title with the clinic's name.
   */
  readonly headline?: string;
  /** The event it was looked up for (./index.ts alertWording): the facts' labels can depend on it. */
  readonly event?: OpsEvent;
};

/**
 * A wording carried over unchanged from before the plain-English rewrite:
 * the old title, and the old one-paragraph action as what happened, so the
 * alert reads exactly as it did. Every event built this way is listed in
 * LEGACY_WORDING (./index.ts) until lane N2 rewrites it.
 */
export function legacy(title: string, action: string): AlertWording {
  return { title, whatHappened: action, whyItMatters: "", steps: [] };
}
