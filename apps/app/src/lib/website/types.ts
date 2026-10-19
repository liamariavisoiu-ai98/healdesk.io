/**
 * The signed website re-reads and the drift list (plan Part B, "Re-reads";
 * Part F3, "Changes on your website"), as plain lists. db/schema.ts builds
 * the CHECK constraints of `site_rereads` and `website_changes` from them,
 * so this file is pure data with no imports: drizzle-kit loads the schema,
 * and this file through it, outside the app.
 */

/**
 * Why a clinic's website is read again, on apps/web, through the signed
 * route (apps/web app/api/clinic-site):
 *
 * - `missing`: the clinic has a website and no profile, because the read at
 *   checkout failed or never ran;
 * - `corrected`: the clinic changed its website (wizard 1.1, or Knowledge's
 *   "Your practice");
 * - `drift`: the monthly check of a live clinic against its baseline;
 * - `ops`: an operator asked, from the console. Read as `missing` while the
 *   clinic has no profile, and as `drift` once it has one;
 * - `insurance`: the misclassification check (plan Part L; drizzle/0097). A
 *   practice under the Data Protection Agreement that answered "No" whose
 *   baseline does not say whether it takes insurance (the demo's read, which
 *   keeps no insurance answer, stood in for a failed checkout read, or the
 *   site said nothing) is read once more, for that alone: the read raises
 *   the signal if the site says it accepts insurance, and changes nothing
 *   else (no baseline, no drift list, no email).
 */
export const SITE_REREAD_REASONS = ["missing", "corrected", "drift", "ops", "insurance"] as const;
export type SiteRereadReason = (typeof SITE_REREAD_REASONS)[number];

/**
 * Where a re-read stands. `queued` waits for its time, `running` is leased
 * by the job; `read` came back and was recorded, `failed` gave up, and
 * `superseded` was overtaken: the clinic's website changed while it waited
 * or ran, or the clinic left.
 */
export const SITE_REREAD_STATUSES = ["queued", "running", "read", "failed", "superseded"] as const;
export type SiteRereadStatus = (typeof SITE_REREAD_STATUSES)[number];

/**
 * Why a re-read did not come back with a profile, as a category, never
 * apps/web's words:
 *
 * - `unreadable`: apps/web answered that the site could not be read
 *   (unreachable, refused, robots.txt, not HTML, or the extraction failed);
 * - `rate_limited`: apps/web's per-clinic or daily limit;
 * - `unavailable`: apps/web could not read at all just then (no key, a 5xx);
 * - `network`: no answer from apps/web, or a timeout;
 * - `refused`: apps/web refused the request itself (the signature, the body);
 * - `invalid`: an answer that did not parse, or a profile of another website.
 */
export const SITE_REREAD_FAILURES = [
  "unreadable",
  "rate_limited",
  "unavailable",
  "network",
  "refused",
  "invalid",
] as const;
export type SiteRereadFailure = (typeof SITE_REREAD_FAILURES)[number];

/**
 * The Knowledge section a change on the website belongs to, by the portal's
 * own names: the profile's services and prices are `prices`, its FAQs
 * `quick_answers`, its location's address and phone `practice` ("Your
 * practice"). Providers are not a Knowledge section: they are set up with
 * their calendars in Settings → Calendar, and a change to them is only
 * raised for a practice that books by named provider.
 */
export const WEBSITE_CHANGE_SECTIONS = [
  "practice",
  "prices",
  "hours",
  "providers",
  "policies",
  "quick_answers",
] as const;
export type WebsiteChangeSection = (typeof WEBSITE_CHANGE_SECTIONS)[number];

/** Against the baseline: on the website now and not then, then and not now, or different. */
export const WEBSITE_CHANGE_KINDS = ["added", "removed", "changed"] as const;
export type WebsiteChangeKind = (typeof WEBSITE_CHANGE_KINDS)[number];

/**
 * A change's state. `new` waits for the clinic; `confirmed` was applied into
 * Knowledge; `ignored` is remembered, so the same change is never raised
 * again; `superseded` is one a later read no longer found, which comes back
 * as `new` if a read finds it again.
 */
export const WEBSITE_CHANGE_STATES = ["new", "confirmed", "ignored", "superseded"] as const;
export type WebsiteChangeState = (typeof WEBSITE_CHANGE_STATES)[number];

/** Each section as the portal names it: on the list, on Home and in L23. */
export const WEBSITE_CHANGE_SECTION_NAMES: Readonly<Record<WebsiteChangeSection, string>> = {
  practice: "Your practice",
  prices: "Prices",
  hours: "Hours",
  providers: "Providers",
  policies: "Policies",
  quick_answers: "Quick answers",
};
