import Anthropic from "@anthropic-ai/sdk";
import { ApifyClient } from "apify-client";

import { selectAngle } from "./angle.ts";
import { detectFromHtml, detectFromMaps } from "./booking-detection.ts";
import { classifyPage } from "./classify.ts";
import { scoreIntegration, scoreProspect } from "./score.ts";
import { detectAdSignals, NO_AD_SIGNAL, type AdSignal } from "./signals/ads.ts";
import {
  matchPostingsToClinic,
  summariseHiring,
  type JobPosting,
} from "./signals/hiring.ts";
import type { BookingDetection, MapsPlace, Prospect } from "./types.ts";

const MAPS_ACTOR = "compass/crawler-google-places";
const CRAWLER_ACTOR = "apify/website-content-crawler";

/** Broad Maps queries cap at ~120 visible results — split queries, then dedupe. */
const MAX_PLACES_PER_SEARCH = 120;

export const DEFAULT_QUERIES = [
  "med spa",
  "medical spa",
  "weight loss clinic",
  "aesthetic clinic",
] as const;

export type PipelineOptions = {
  /** e.g. "Austin, Texas". Split by neighbourhood for full metro coverage. */
  location: string;
  queries?: readonly string[];
  /** Cap on ambiguous sites sent to the LLM. Keeps a first run cheap. */
  maxLlmCalls?: number;
  /**
   * Front-desk job postings for this metro, if you have them.
   *
   * Passed in rather than fetched here because job-board actors differ enough
   * that hard-coding one would mean rewriting this the first time it changes.
   * See signals/hiring.ts → searchFrontDeskPostings.
   */
  jobPostings?: JobPosting[];
  log?: (message: string) => void;
};

export async function runPipeline({
  location,
  queries = DEFAULT_QUERIES,
  maxLlmCalls = 50,
  jobPostings = [],
  log = console.log,
}: PipelineOptions): Promise<Prospect[]> {
  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) throw new Error("APIFY_TOKEN is not set.");

  const apify = new ApifyClient({ token: apifyToken });

  // ---------------------------------------------------------------------------
  // Stage 1 — build the universe, take the free filter.
  // ---------------------------------------------------------------------------
  log(`[1/4] Scraping Google Maps: ${queries.length} queries × ${location}`);

  const mapsRun = await apify.actor(MAPS_ACTOR).call({
    searchStringsArray: [...queries],
    locationQuery: location,
    maxCrawledPlacesPerSearch: MAX_PLACES_PER_SEARCH,
    language: "en",
  });

  const { items } = await apify
    .dataset(mapsRun.defaultDatasetId)
    .listItems();
  const places = items as unknown as MapsPlace[];

  // Dedupe by place ID, falling back to phone — the same clinic surfaces under
  // several category queries.
  const unique = new Map<string, MapsPlace>();
  for (const place of places) {
    const key = place.placeId ?? place.phone ?? place.title;
    if (!key) continue;
    if (!unique.has(key)) unique.set(key, place);
  }
  log(`      ${places.length} results → ${unique.size} unique clinics`);

  // ---------------------------------------------------------------------------
  // Stage 2 — resolve what Maps could not.
  // ---------------------------------------------------------------------------
  const resolved = new Map<string, BookingDetection>();
  /**
   * Advertising signals, harvested from the same rendered HTML as the booking
   * detection. Free — we already paid to fetch the page — and it is the single
   * most useful thing to know about a prospect.
   */
  const adSignals = new Map<string, AdSignal>();
  const needsCrawl: MapsPlace[] = [];

  for (const [key, place] of unique) {
    const detection = detectFromMaps(place);
    if (detection) resolved.set(key, detection);
    else needsCrawl.push(place);
  }

  log(
    `[2/4] ${resolved.size} settled from Maps · ${needsCrawl.length} need a rendered fetch`,
  );

  if (needsCrawl.length > 0) {
    // MUST render: these widgets inject via JavaScript, so a plain HTTP
    // crawler reports false "no booking" for bookable clinics.
    const crawlRun = await apify.actor(CRAWLER_ACTOR).call({
      startUrls: needsCrawl
        .filter((place) => place.website)
        .map((place) => ({ url: place.website! })),
      crawlerType: "playwright:firefox",
      maxCrawlDepth: 1,
      maxCrawlPages: needsCrawl.length * 2,
      saveHtml: true,
    });

    const { items: pages } = await apify
      .dataset(crawlRun.defaultDatasetId)
      .listItems();

    const byHost = new Map<string, string>();
    for (const page of pages as unknown as {
      url?: string;
      html?: string;
      text?: string;
    }[]) {
      if (!page.url) continue;
      const host = safeHost(page.url);
      if (!host) continue;
      const content = `${page.html ?? ""}\n${page.text ?? ""}`;
      byHost.set(host, (byHost.get(host) ?? "") + content);
    }

    // ------------------------------------------------------------------------
    // Stage 3 — footprint match, then LLM for whatever stays ambiguous.
    // ------------------------------------------------------------------------
    const client = new Anthropic();
    let llmCalls = 0;
    let llmSkipped = 0;

    for (const place of needsCrawl) {
      const key = place.placeId ?? place.phone ?? place.title;
      if (!key) continue;

      const host = place.website ? safeHost(place.website) : null;
      const content = host ? byHost.get(host) : undefined;

      if (!content) {
        resolved.set(key, {
          hasOnlineBooking: false,
          method: "none",
          provider: null,
          source: "footprint",
          matchedSignatures: [],
        });
        continue;
      }

      // Same page, second question: are they buying traffic? Costs nothing
      // extra and produces the strongest outreach angle we have.
      adSignals.set(key, detectAdSignals(content));

      const footprint = detectFromHtml(content);

      // Ambiguous: scheduling language, no recognised vendor. Ask the model.
      const ambiguous =
        !footprint.hasOnlineBooking && footprint.method === "none";

      if (!ambiguous) {
        resolved.set(key, footprint);
        continue;
      }

      if (llmCalls >= maxLlmCalls) {
        llmSkipped += 1;
        resolved.set(key, footprint);
        continue;
      }

      try {
        resolved.set(key, await classifyPage(content, client));
        llmCalls += 1;
      } catch (error) {
        log(`      classification failed for ${place.title}: ${String(error)}`);
        resolved.set(key, footprint);
      }
    }

    log(`[3/4] ${llmCalls} pages classified by model`);
    if (llmSkipped > 0) {
      // Never let a cap look like full coverage.
      log(
        `      ⚠️  ${llmSkipped} ambiguous sites skipped — maxLlmCalls (${maxLlmCalls}) reached. ` +
          `They fell back to the footprint verdict and may be misclassified.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 4 — score.
  // ---------------------------------------------------------------------------
  const prospects: Prospect[] = [];

  for (const [key, place] of unique) {
    const detection = resolved.get(key);
    if (!detection) continue;

    const ads = adSignals.get(key) ?? NO_AD_SIGNAL;
    const hiring = summariseHiring(
      matchPostingsToClinic(place.title ?? "", jobPostings),
    );

    const { score, reasons } = scoreProspect(place, detection, { ads, hiring });
    const integration = scoreIntegration(detection);

    prospects.push({
      placeId: place.placeId ?? key,
      name: place.title ?? "(unknown)",
      website: place.website ?? null,
      phone: place.phone ?? null,
      city: place.city ?? null,
      state: place.state ?? null,
      reviewsCount: place.reviewsCount ?? null,
      rating: place.totalScore ?? null,
      detection,
      ads,
      hiring,
      score,
      scoreReasons: reasons,
      integrationScore: integration.score,
      integrationNotes: integration.notes,
      angle: selectAngle({ place, detection, ads, hiring }),
    });
  }

  prospects.sort((a, b) => b.score - a.score);
  log(`[4/4] ${prospects.length} scored prospects`);

  return prospects;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function toCsv(prospects: Prospect[]): string {
  const header = [
    "score",
    "phase2_integration_score",
    "angle",
    "angle_headline",
    "name",
    "phone",
    "website",
    "city",
    "state",
    "reviews",
    "rating",
    "has_online_booking",
    "method",
    "provider",
    "detection_source",
    "ad_platforms",
    "ad_conversion_tracking",
    "funnel_tools",
    "hiring_front_desk",
    "hiring_posted",
    "evidence",
    "proof_links",
    "reasons",
    "phase2_integration_notes",
  ];

  const escape = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  const rows = prospects.map((p) =>
    [
      p.score,
      p.integrationScore,
      p.angle.id,
      p.angle.headline,
      p.name,
      p.phone,
      p.website,
      p.city,
      p.state,
      p.reviewsCount,
      p.rating,
      p.detection.hasOnlineBooking,
      p.detection.method,
      p.detection.provider,
      p.detection.source,
      p.ads.platforms.join("|"),
      p.ads.hasConversionTracking,
      p.ads.funnelTools.join("|"),
      p.hiring.postings.length > 0 && !p.hiring.isStale,
      p.hiring.mostRecent?.toISOString().slice(0, 10) ?? "",
      p.angle.evidence.join(" · "),
      p.angle.proofLinks.join(" "),
      p.scoreReasons.join("; "),
      p.integrationNotes.join("; "),
    ]
      .map(escape)
      .join(","),
  );

  return [header.join(","), ...rows].join("\n");
}
