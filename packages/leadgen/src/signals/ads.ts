/**
 * Signal 3 — is this clinic buying traffic?
 *
 * The single most useful thing to know about a prospect. A clinic spending
 * $6,000 a month on Meta ads and letting the phone ring out is paying for
 * leads twice: once to the ad platform, and again in the ones that hang up.
 * That is the entire pitch, and it only lands if we know they're advertising.
 *
 * Detection runs on the rendered HTML the Stage 2 crawler already fetches, so
 * it costs nothing extra. A tag on the page is not proof of current spend —
 * pixels outlive the campaigns that installed them — but it is strong evidence
 * of intent, and it never produces a false NEGATIVE for an active advertiser,
 * because you cannot run conversion tracking without one.
 *
 * The Meta Ad Library is the authoritative source and is free and public, but
 * it needs a separate lookup per clinic. This module surfaces which prospects
 * are worth that lookup.
 */

export type AdPlatform = "meta" | "google" | "tiktok";

export type FunnelTool =
  | "unbounce"
  | "instapage"
  | "leadpages"
  | "clickfunnels"
  | "gohighlevel";

export type AdSignal = {
  /** Platforms whose tracking tags are present on the page. */
  platforms: AdPlatform[];
  /** Landing-page builders — a strong sign of a paid funnel, not just a site. */
  funnelTools: FunnelTool[];
  /** True when a conversion/remarketing tag is present, not just analytics. */
  hasConversionTracking: boolean;
  /** Which strings matched, so a surprising result can be checked by hand. */
  matched: string[];
};

/**
 * Tag signatures.
 *
 * Split by intent: plain analytics says "they measure traffic", conversion and
 * remarketing tags say "they are buying it". Only the second group justifies
 * the ad-spend pitch, so they are scored differently.
 */
const PLATFORM_SIGNATURES: Record<
  AdPlatform,
  { analytics: readonly string[]; conversion: readonly string[] }
> = {
  meta: {
    analytics: ["connect.facebook.net", "facebook-jssdk"],
    // fbq('track' and the pixel bootstrap are the actual advertising tells.
    conversion: ["fbq(", "fbevents.js", "facebook.com/tr?"],
  },
  google: {
    analytics: ["googletagmanager.com/gtag/js", "google-analytics.com"],
    // AW- is a Google Ads conversion ID; gcl* cookies are click identifiers.
    conversion: [
      "aw-",
      "googleadservices.com",
      "google_conversion",
      "gtag('config', 'aw-",
      "doubleclick.net",
    ],
  },
  tiktok: {
    analytics: ["analytics.tiktok.com"],
    conversion: ["ttq.track", "ttq.load"],
  },
};

const FUNNEL_SIGNATURES: Record<FunnelTool, readonly string[]> = {
  unbounce: ["unbounce.com", "ub-container"],
  instapage: ["instapage.com", "instapagecdn"],
  leadpages: ["leadpages.net", "lpages.co"],
  clickfunnels: ["clickfunnels.com", "cf-page"],
  gohighlevel: ["msgsndr", "leadconnectorhq"],
};

/**
 * Detect advertising signals in rendered page HTML.
 *
 * MUST be given output from a rendering crawler. Tag managers inject these
 * scripts client-side, so a plain HTTP fetch reports a false "not advertising"
 * for a clinic spending five figures a month — the exact prospect we most want
 * to find.
 */
export function detectAdSignals(html: string): AdSignal {
  const haystack = html.toLowerCase();
  const matched: string[] = [];

  const platforms: AdPlatform[] = [];
  let hasConversionTracking = false;

  for (const [platform, groups] of Object.entries(PLATFORM_SIGNATURES) as [
    AdPlatform,
    (typeof PLATFORM_SIGNATURES)[AdPlatform],
  ][]) {
    const analyticsHit = groups.analytics.filter((s) => haystack.includes(s));
    const conversionHit = groups.conversion.filter((s) => haystack.includes(s));

    if (analyticsHit.length || conversionHit.length) {
      platforms.push(platform);
      matched.push(...analyticsHit, ...conversionHit);
    }
    if (conversionHit.length) hasConversionTracking = true;
  }

  const funnelTools: FunnelTool[] = [];
  for (const [tool, needles] of Object.entries(FUNNEL_SIGNATURES) as [
    FunnelTool,
    readonly string[],
  ][]) {
    const hit = needles.filter((s) => haystack.includes(s));
    if (hit.length) {
      funnelTools.push(tool);
      matched.push(...hit);
    }
  }

  return {
    platforms,
    funnelTools,
    hasConversionTracking,
    matched: [...new Set(matched)],
  };
}

export const NO_AD_SIGNAL: AdSignal = {
  platforms: [],
  funnelTools: [],
  hasConversionTracking: false,
  matched: [],
};

/**
 * Where to verify a detection by hand.
 *
 * The Ad Library is free, public, and authoritative — it shows every active ad
 * with a first-seen date, which is also how you spot a clinic that just
 * launched a GLP-1 campaign. Worth opening before any outreach that leads with
 * ad spend, because being wrong about it is embarrassing in a specific way.
 */
export function adLibraryUrl(clinicName: string): string {
  const params = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country: "US",
    q: clinicName,
    search_type: "keyword_unordered",
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

export function googleAdsTransparencyUrl(domain: string): string {
  return `https://adstransparency.google.com/?region=US&domain=${encodeURIComponent(domain)}`;
}
