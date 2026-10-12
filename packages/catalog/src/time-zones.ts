/**
 * A clinic's time zone, from the address it gives (plan Part C2: "the time
 * zone comes from the chosen location's address, then the browser, then New
 * York").
 *
 * Every hour a clinic keeps, every closure and the end of its setup window
 * are read in this zone, so a wrong guess moves all of them. The address is
 * the best first answer because it is where the front desk is; the buyer's
 * browser is where the buyer was sitting, which is often but not always the
 * same place. The wizard shows the result and asks when the browser
 * disagrees, so this only has to be right for the common case and never
 * confidently wrong: an address it cannot place gives null, not a guess.
 *
 * By state, to the zone most of the state's people keep. A handful of states
 * span two zones (Texas's El Paso, Florida's panhandle, the two halves of
 * Tennessee, Kentucky and the Dakotas, northern Idaho); a clinic on the other
 * side of the line corrects it in the wizard, and the wizard tells it so.
 */

/** The zones the wizard offers, in the order a US clinic expects them. */
export const US_TIME_ZONES: readonly { id: string; label: string }[] = [
  { id: "America/New_York", label: "Eastern" },
  { id: "America/Chicago", label: "Central" },
  { id: "America/Denver", label: "Mountain" },
  { id: "America/Phoenix", label: "Arizona (no daylight saving)" },
  { id: "America/Los_Angeles", label: "Pacific" },
  { id: "America/Anchorage", label: "Alaska" },
  { id: "Pacific/Honolulu", label: "Hawaii" },
  { id: "America/Puerto_Rico", label: "Atlantic (Puerto Rico)" },
];

/** The last fallback: no address we can place and no browser zone. */
export const DEFAULT_CLINIC_TIME_ZONE = "America/New_York";

const ET = "America/New_York";
const CT = "America/Chicago";
const MT = "America/Denver";
const PT = "America/Los_Angeles";

/** USPS abbreviation → the zone most of the state keeps. */
const STATE_ZONES: Readonly<Record<string, string>> = {
  AL: CT,
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  AR: CT,
  CA: PT,
  CO: MT,
  CT: ET,
  DE: ET,
  DC: ET,
  FL: ET,
  GA: ET,
  HI: "Pacific/Honolulu",
  ID: MT,
  IL: CT,
  IN: ET,
  IA: CT,
  KS: CT,
  KY: ET,
  LA: CT,
  ME: ET,
  MD: ET,
  MA: ET,
  MI: ET,
  MN: CT,
  MS: CT,
  MO: CT,
  MT: MT,
  NE: CT,
  NV: PT,
  NH: ET,
  NJ: ET,
  NM: MT,
  NY: ET,
  NC: ET,
  ND: CT,
  OH: ET,
  OK: CT,
  OR: PT,
  PA: ET,
  RI: ET,
  SC: ET,
  SD: CT,
  TN: CT,
  TX: CT,
  UT: MT,
  VT: ET,
  VA: ET,
  WA: PT,
  WV: ET,
  WI: CT,
  WY: MT,
  PR: "America/Puerto_Rico",
};

/** Full state names, for an address written out in words. */
const STATE_NAMES: Readonly<Record<string, string>> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "puerto rico": "PR",
};

const ABBREVIATIONS = Object.keys(STATE_ZONES).join("|");
/** "TX 78701", "TX, 78701-1234": the form almost every US address ends in. */
const ABBREVIATION_AND_ZIP = new RegExp(`\\b(${ABBREVIATIONS})\\b[\\s,.]*\\d{5}(?:-\\d{4})?\\b`);
/** ", TX" at the very end, with no ZIP. */
const TRAILING_ABBREVIATION = new RegExp(`,\\s*(${ABBREVIATIONS})\\.?\\s*$`);
const NAMES = Object.keys(STATE_NAMES)
  .sort((a, b) => b.length - a.length)
  .join("|");
/** "Austin, Texas 78701" or "Austin, Texas": a state's name, last in the address. */
const TRAILING_NAME = new RegExp(
  `(?:^|[\\s,])(${NAMES})[\\s,.]*(?:\\d{5}(?:-\\d{4})?)?[\\s.]*$`,
  "i",
);

/**
 * The IANA zone for a US street address, or null when the address names no
 * state we can read. Case matters for the two-letter form (", in" is a word,
 * ", IN" is Indiana); a written-out state name is matched in any case.
 */
export function timeZoneForUsAddress(address: string | null | undefined): string | null {
  if (typeof address !== "string") return null;
  const text = address.replace(/\s+/g, " ").trim();
  if (!text || text.length > 400) return null;

  const coded = ABBREVIATION_AND_ZIP.exec(text) ?? TRAILING_ABBREVIATION.exec(text);
  if (coded?.[1]) return STATE_ZONES[coded[1]] ?? null;

  const named = TRAILING_NAME.exec(text);
  if (named?.[1]) {
    const code = STATE_NAMES[named[1].toLowerCase()];
    return code ? (STATE_ZONES[code] ?? null) : null;
  }
  return null;
}

/** Whether a string names a time zone this runtime knows. */
export function isKnownTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The clinic's zone at provisioning: the address's, else the buyer's
 * browser's, else New York. A browser zone this runtime does not know is
 * passed over rather than stored.
 */
export function clinicTimeZone(input: {
  address?: string | null;
  browserTimeZone?: string | null;
}): string {
  return (
    timeZoneForUsAddress(input.address) ??
    (isKnownTimeZone(input.browserTimeZone) ? input.browserTimeZone : null) ??
    DEFAULT_CLINIC_TIME_ZONE
  );
}
