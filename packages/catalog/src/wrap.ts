/**
 * Wrap at 78 columns so a document reads the same in a browser and a text
 * file — the downloadable copy is plain text, and a contract that reflows
 * differently depending on where you opened it is a contract people mistrust.
 *
 * `hanging` indents continuation lines past a list marker. Without it,
 * "a. It holds the consents…" wraps back under the "a.", and the reader cannot
 * see where one lettered warranty ends and the next begins. In a clause that
 * imposes obligations on the SIGNER, that is not a cosmetic problem.
 *
 * Shared by the BAA (baa.ts) and the direct-booking addendum
 * (direct-booking-addendum.ts), whose clause body the BAA also renders, so
 * the same sentence wraps to the same bytes in both documents. It sits in its
 * own module because baa.ts imports the addendum's clause body; the addendum
 * importing baa.ts back would be a cycle.
 *
 * Never change the algorithm. Every signed hash in apps/app/tests/
 * baa-golden.test.ts reproduces through it, and the golden test is what turns
 * a "harmless" tweak here into a failing build instead of an invalidated
 * signature.
 */
export function wrap(text: string, indent = "  ", hanging = indent): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = indent;
  let prefix = indent;

  for (const word of words) {
    if (line.length + word.length + 1 > 78 && line.trim() !== prefix.trim()) {
      lines.push(line);
      prefix = hanging;
      line = hanging + word;
    } else {
      line = line.trim() ? `${line} ${word}` : prefix + word;
    }
  }
  if (line.trim()) lines.push(line);
  return lines.join("\n");
}
