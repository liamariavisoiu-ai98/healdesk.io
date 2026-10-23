import { US_STATES } from "@/lib/us-places";

/**
 * The place a request came from, for the lock screen's weather
 * (components/Outcomes.tsx).
 *
 * Vercel puts what its IP lookup found on every request: `x-vercel-ip-city`
 * (percent-encoded, "San%20Jos%C3%A9"), `x-vercel-ip-country-region` and
 * `x-vercel-ip-country`. The browser's own geolocation is not an option: the
 * Permissions-Policy refuses it (lib/security-headers.ts), and a permission
 * prompt over a decorative widget would cost more trust than it earns. The
 * lookup is approximate, a town or a neighbouring one, which is all a weather
 * widget claims. Nothing is stored: the route answers and forgets.
 *
 * ## The ladder
 *
 * The finest place the lookup is sure of, and never a guess: the city; else,
 * for a visitor in the United States, the state; else the country; else
 * nothing, and the screen says "Current Location", which is the words iOS
 * itself uses and is true wherever the phone is. A time zone is deliberately
 * not a rung: it names one city for half a country, so it would sometimes be
 * confidently wrong, which the widget must never be.
 */

/** What the screen says when no rung of the ladder held. */
export const UNKNOWN_PLACE = "Current Location";

/** Longer than any real place name in the lookup's data; a header longer than this is not one. */
const MAX_LENGTH = 40;

/** Letters from any script, then spaces, apostrophes, full stops and hyphens between them: "St. John's", "Winston-Salem", "São Paulo". */
const TOWN = /^\p{L}[\p{L}\p{M} .'’-]*$/u;

function city(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed escape is not Vercel's doing; do not guess at it.
    return null;
  }
  const place = decoded.trim();
  if (place.length === 0 || place.length > MAX_LENGTH || !TOWN.test(place)) return null;
  return place;
}

const STATES = new Map<string, string>(US_STATES.map((state) => [state.code, state.name]));

/** Region codes are only unambiguous with their country ("CA" is California and a Canadian province's neighbour), so only the United States's are read. */
function usState(country: string | null | undefined, region: string | null | undefined): string | null {
  if (country?.toUpperCase() !== "US" || !region) return null;
  return STATES.get(region.toUpperCase()) ?? null;
}

function countryName(code: string | null | undefined): string | null {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return null;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase());
    // Intl answers with the code itself for one it does not know.
    return name && name.toUpperCase() !== code.toUpperCase() ? name : null;
  } catch {
    return null;
  }
}

/** The finest place the request's headers support, or null for "Current Location". */
export function placeFromHeaders(headers: Pick<Headers, "get">): string | null {
  const country = headers.get("x-vercel-ip-country");
  return (
    city(headers.get("x-vercel-ip-city")) ??
    usState(country, headers.get("x-vercel-ip-country-region")) ??
    countryName(country)
  );
}
