/**
 * The country picker and the as-you-type formatting on the voice card's
 * "Call me" field (owner, 12 October 2026).
 *
 * It only shapes what the visitor types. What it hands on is "+", the
 * country's code and the national digits, which is the international form
 * lib/phone.ts asks a non-US number to carry, and that is still what decides
 * whether a number may be dialled: this file never does.
 */

export type DialCountry = { iso: string; name: string; code: string; flag: string };

/** The clinics healdesk sells to are American first; the rest are where visitors come from. */
export const DIAL_COUNTRIES: readonly DialCountry[] = [
  { iso: "US", name: "United States", code: "1", flag: "🇺🇸" },
  { iso: "CA", name: "Canada", code: "1", flag: "🇨🇦" },
  { iso: "GB", name: "United Kingdom", code: "44", flag: "🇬🇧" },
  { iso: "IE", name: "Ireland", code: "353", flag: "🇮🇪" },
  { iso: "AU", name: "Australia", code: "61", flag: "🇦🇺" },
  { iso: "NZ", name: "New Zealand", code: "64", flag: "🇳🇿" },
  { iso: "AE", name: "United Arab Emirates", code: "971", flag: "🇦🇪" },
  { iso: "DE", name: "Germany", code: "49", flag: "🇩🇪" },
  { iso: "FR", name: "France", code: "33", flag: "🇫🇷" },
  { iso: "ES", name: "Spain", code: "34", flag: "🇪🇸" },
  { iso: "IT", name: "Italy", code: "39", flag: "🇮🇹" },
  { iso: "NL", name: "Netherlands", code: "31", flag: "🇳🇱" },
  { iso: "SG", name: "Singapore", code: "65", flag: "🇸🇬" },
  { iso: "MX", name: "Mexico", code: "52", flag: "🇲🇽" },
];

export function countryByIso(iso: string): DialCountry {
  return DIAL_COUNTRIES.find((country) => country.iso === iso) ?? DIAL_COUNTRIES[0]!;
}

/** The national digits as they are written: (415) 555-0123 for +1, groups of three and four elsewhere. */
export function formatNational(country: DialCountry, value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, country.code === "1" ? 10 : 13);
  if (country.code === "1") {
    if (digits.length <= 3) return digits.length ? `(${digits}` : "";
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  const groups: string[] = [];
  let rest = digits;
  while (rest.length > 4) {
    groups.push(rest.slice(0, 3));
    rest = rest.slice(3);
  }
  if (rest) groups.push(rest);
  return groups.join(" ");
}

/**
 * The number to send: "+", the code and the national digits. A national
 * trunk "0" is dropped, as it is when a number is dialled from abroad
 * (07911 123456 in the UK is +44 7911 123456); a US number typed with its
 * leading 1 keeps one 1. Empty when nothing has been typed.
 */
export function toInternational(country: DialCountry, value: string): string {
  let digits = value.replace(/\D/g, "");
  if (!digits) return "";
  if (country.code === "1" && digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (country.code !== "1") digits = digits.replace(/^0+/, "");
  return `+${country.code}${digits}`;
}

/** A number we were given whole, such as the operator's prefill, split into its country and national part. */
export function splitNumber(value: string | null | undefined): { iso: string; national: string } {
  const text = (value ?? "").trim();
  if (!text.startsWith("+")) return { iso: "US", national: formatNational(DIAL_COUNTRIES[0]!, text) };
  const digits = text.replace(/\D/g, "");
  const match = [...DIAL_COUNTRIES].sort((a, b) => b.code.length - a.code.length).find((country) => digits.startsWith(country.code));
  if (!match) return { iso: "US", national: text };
  return { iso: match.iso, national: formatNational(match, digits.slice(match.code.length)) };
}
