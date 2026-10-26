/**
 * Words a clinic's name ends with that say what kind of place it is, not
 * which one: dropped from the end for the short name a person would use
 * after the greeting (shortClinicName).
 */
const GENERIC_NAME_WORDS = new Set([
  "aesthetic", "aesthetics", "wellness", "spa", "spas", "medspa", "medispa", "med", "medical", "clinic", "clinics", "center", "centre",
  "studio", "studios", "lounge", "institute", "group", "beauty", "laser", "lasers", "skin", "skincare", "care", "dermatology", "derm",
  "cosmetic", "cosmetics", "surgery", "surgical", "plastic", "plastics", "health", "rejuvenation", "body", "face", "bar", "boutique",
  "collective", "co", "company", "llc", "inc", "pllc", "pc", "ltd", "and", "&", "+",
]);

/**
 * The short name a person uses for a clinic once its full name has been
 * said (owner, 26 October 2026, 6i): "Lumen Aesthetics & Wellness" is
 * "Lumen", "Glow Med Spa of Austin" is "Glow", "Skin Deep Med Spa" is "Skin
 * Deep". A place after "of", "at", "in" or "by", or after a dash, bar or
 * comma, goes; a leading "The" goes; then generic words from the end. A name
 * with nothing left, or a single word under three letters, stays whole.
 * A demo call uses it on the scraped public name; a clinic's call uses the
 * clinic's own setting when it has one (clinic_settings.short_name, Settings
 * › "What patients call you"), and this when it has none.
 */
export function shortClinicName(fullName: string): string {
  const full = fullName.trim();
  const head = full.split(/\s+(?:of|at|in|by)\s+|\s[-–—|]\s|,/i)[0]!.trim();
  const words = head.split(/\s+/).filter(Boolean);
  if (words[0]?.toLowerCase() === "the") words.shift();
  while (words.length > 0 && GENERIC_NAME_WORDS.has(words[words.length - 1]!.toLowerCase().replace(/[^a-z&+]/g, ""))) words.pop();
  const short = words.join(" ").replace(/[\s&+,-]+$/, "");
  if (!short || (words.length === 1 && short.length < 3)) return full;
  return short;
}

