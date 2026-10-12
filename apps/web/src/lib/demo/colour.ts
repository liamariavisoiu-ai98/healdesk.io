/**
 * The text colour to put on a brand colour: dark ink on a light one, white on
 * a dark one, by relative luminance (WCAG's formula, so the cut-off tracks how
 * the eye sees yellow and blue rather than how bright the hex looks).
 *
 * The personalised demo page dresses the clinic's header in its colour and
 * the homepage's live preview dresses AYA's chat widget in the visitor's, and
 * both need a title they can read. Pure, so a client component can import it.
 */
export function readableOn(hex: string): "#172a3a" | "#ffffff" {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  // Not a colour we can read: the page behind it is white.
  if (!match) return "#172a3a";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(match[1]!.slice(i, i + 2), 16) / 255) as [number, number, number];
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.45 ? "#172a3a" : "#ffffff";
}
