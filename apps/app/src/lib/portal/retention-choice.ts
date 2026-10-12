/**
 * What picking one of the Records card's choices does (BAA 1.3.0 clause 11),
 * decided when it is picked, against the value saved at that moment rather
 * than the one the page loaded with (the branch review's R9): load at 30,
 * lengthen to 90 and pick 30 again, and the pick shortens, so it asks first.
 *
 * Nothing when the pick is what is saved; a save at once when it lengthens;
 * and a sentence to confirm when it shortens. Kept apart from the control so
 * a test can drive it without a browser.
 */

export type RetentionChoice =
  { kind: "none" } | { kind: "save" } | { kind: "confirm"; sentence: string };

export function retentionChoice(
  saved: string,
  next: string,
  options: readonly { id: string; confirm: string | null }[],
): RetentionChoice {
  if (next === saved) return { kind: "none" };
  if (Number(next) > Number(saved)) return { kind: "save" };
  // Every shorter choice carries its sentence (recordsOptions); one that
  // somehow doesn't still asks rather than saving unseen.
  const sentence =
    options.find((option) => option.id === next)?.confirm ?? `Shorten to ${next} days?`;
  return { kind: "confirm", sentence };
}
