import Anthropic from "@anthropic-ai/sdk";
import type { ClinicProfile } from "@healdesk/catalog";

import { extractClinicProfile, type ExtractionClient, type ExtractionFailure } from "./extract";
import { fetchSitePages, SiteFetchError, type FetchFailure, type ReadOptions } from "./fetch";
import { pageTexts } from "./html";

/**
 * A clinic's website, read: fetched behind the guard (fetch.ts), reduced to
 * text (html.ts), its business facts extracted and screened (extract.ts).
 *
 * The result is the profile or the reason there is none. The reason is for
 * our logs: the browser is told only that the read failed, and setup asks
 * its three questions instead. Nothing is stored here or anywhere in
 * apps/web; the caller hands the profile back and forgets it.
 */

export type SiteReadFailure = FetchFailure | ExtractionFailure | "no-text" | "unconfigured";

export type SiteRead =
  | { status: "read"; profile: ClinicProfile; model: string }
  | { status: "failed"; reason: SiteReadFailure; detail?: string };

/**
 * The fetching share of the time budget. A site's home page, its robots.txt
 * and six pages in parallel normally take a few seconds; past this the read
 * goes on with what it has, and the model gets the rest.
 */
const FETCH_BUDGET_MS = 18_000;

/** Below this the model has no realistic chance of finishing, so it is not asked. */
const MIN_EXTRACTION_MS = 10_000;

/** Less text than this is a page drawn by JavaScript or a holding page: nothing to extract. */
const MIN_TEXT_CHARS = 200;

export type ReadSiteOptions = {
  /** Epoch milliseconds by which the read has an answer, inside the route's maxDuration. */
  deadline: number;
  /** Tests pass a stand-in; otherwise apps/web's own key. */
  client?: ExtractionClient;
  /** Tests replace DNS and HTTP. */
  fetch?: Pick<ReadOptions, "resolve" | "transport" | "blockedHosts">;
};

function defaultClient(): ExtractionClient | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return apiKey ? new Anthropic({ apiKey }) : null;
}

export async function readClinicSite(website: string, options: ReadSiteOptions): Promise<SiteRead> {
  const client = options.client ?? defaultClient();
  if (!client) return { status: "failed", reason: "unconfigured" };

  let pages;
  try {
    pages = await fetchSitePages(website, {
      ...options.fetch,
      deadline: Math.min(Date.now() + FETCH_BUDGET_MS, options.deadline - MIN_EXTRACTION_MS),
    });
  } catch (error) {
    if (error instanceof SiteFetchError) {
      return { status: "failed", reason: error.reason, detail: error.detail };
    }
    throw error;
  }

  const texts = pageTexts(pages);
  if (texts.reduce((sum, page) => sum + page.text.length, 0) < MIN_TEXT_CHARS) {
    return { status: "failed", reason: "no-text" };
  }

  const timeoutMs = options.deadline - Date.now();
  if (timeoutMs < MIN_EXTRACTION_MS) {
    return { status: "failed", reason: "timeout", detail: "no time left to extract" };
  }

  const result = await extractClinicProfile(
    { website, pages: texts, readAt: new Date() },
    { client, timeoutMs },
  );
  return result.ok
    ? { status: "read", profile: result.profile, model: result.model }
    : { status: "failed", reason: result.reason, detail: result.detail };
}
