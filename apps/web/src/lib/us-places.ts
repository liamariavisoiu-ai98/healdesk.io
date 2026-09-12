/**
 * US states, and the city list behind the review form's location picker.
 *
 * ## Where the cities come from
 *
 * src/lib/us-cities.json is built from the Census Bureau's 2023 national
 * Gazetteer places file, which is public domain. Every place in it is kept, not
 * just the incorporated ones: leaving the census-designated places out drops
 * Honolulu, Silver Spring, Paradise and most of Hawaii, which are addresses
 * clinics actually have. The census suffixes ("city", "town", "CDP",
 * "municipality") are stripped, the result is deduplicated, and it is grouped
 * by state so the state abbreviation is stored once instead of 32,000 times.
 *
 * Honolulu is the one hand-added name. The Gazetteer calls it "Urban Honolulu
 * CDP" and nobody else on earth does.
 *
 * The file is around 130KB gzipped, which is why nothing imports it at the top
 * of a module. `loadCities()` is a dynamic import, called the first time the
 * review dialog opens, so a visitor who never leaves a review never pays for
 * it and the homepage bundle does not change size at all.
 */

export type StateOption = { code: string; name: string };

/**
 * Fifty states, DC and Puerto Rico. Matches the keys in us-cities.json.
 *
 * Ordered by code rather than by name, because the picker shows codes. A list
 * labelled AL, AK, AZ reads as unsorted; AK, AL, AR reads as a list.
 */
export const US_STATES: readonly StateOption[] = [
  { code: "AK", name: "Alaska" },
  { code: "AL", name: "Alabama" },
  { code: "AR", name: "Arkansas" },
  { code: "AZ", name: "Arizona" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DC", name: "District of Columbia" },
  { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "IA", name: "Iowa" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "MA", name: "Massachusetts" },
  { code: "MD", name: "Maryland" },
  { code: "ME", name: "Maine" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MO", name: "Missouri" },
  { code: "MS", name: "Mississippi" },
  { code: "MT", name: "Montana" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "NE", name: "Nebraska" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NV", name: "Nevada" },
  { code: "NY", name: "New York" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "PR", name: "Puerto Rico" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VA", name: "Virginia" },
  { code: "VT", name: "Vermont" },
  { code: "WA", name: "Washington" },
  { code: "WI", name: "Wisconsin" },
  { code: "WV", name: "West Virginia" },
  { code: "WY", name: "Wyoming" },
];

const BY_CODE = new Map(US_STATES.map((state) => [state.code, state.name]));

/** "AZ" to "Arizona". Falls back to the code, which is better than nothing. */
export function stateName(code: string): string {
  return BY_CODE.get(code.toUpperCase()) ?? code;
}

export function isStateCode(value: string): boolean {
  return BY_CODE.has(value.toUpperCase());
}

/** Every place in the country, keyed by state code. */
export type CitiesByState = Record<string, readonly string[]>;

let pending: Promise<CitiesByState> | null = null;

/**
 * Fetch the city list, once.
 *
 * The promise is cached rather than the result, so two components opening at
 * the same time share one request instead of racing to start two. A failure
 * clears the cache so the next attempt can retry rather than being stuck with
 * a rejected promise forever.
 */
export function loadCities(): Promise<CitiesByState> {
  pending ??= import("@/lib/us-cities.json")
    .then((module) => module.default as CitiesByState)
    .catch((error) => {
      pending = null;
      throw error;
    });
  return pending;
}
