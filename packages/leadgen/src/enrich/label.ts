import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import Anthropic from "@anthropic-ai/sdk";

import type { CrawlResult } from "./crawl.ts";
import { SEGMENT_RULES, SEGMENTS, type Segment } from "./segments.ts";

/**
 * One primary segment per clinic, decided from the clinic's own words.
 *
 * Two design rules, both of which exist so the output can be COUNTED:
 *
 *   1. **Single label, forced.** A clinic offering Botox, laser and a bit of
 *      CoolSculpting is one business and must occupy one bucket. Multi-label
 *      output cannot be tallied — every overlapping clinic inflates several
 *      segments at once, which is the exact defect in the source list's own
 *      `category` column.
 *   2. **Closed enum, validated on the way back.** A model asked an open
 *      question invents near-synonyms ("medspa", "med spa", "aesthetics") that
 *      look like different segments in a tally. Anything not in SEGMENTS is
 *      rejected rather than coerced, because a silently coerced label is a
 *      wrong row that looks right.
 *
 * Confidence is returned and kept. A low-confidence label on a thin page is not
 * the same evidence as a high-confidence one on a full service menu, and the
 * segment tally should be reported both ways — if the ranking flips when you
 * drop the low-confidence rows, the ranking was never real.
 */

export type Label = {
  clinicId: string;
  segment: Segment;
  confidence: "high" | "medium" | "low";
  /** One line, for spot-checking a sample by eye. */
  evidence: string;
  /** Signals that feed the ranking, read off the same page for free. */
  offersOnlineBooking: boolean;
  mentionsWeightLoss: boolean;
  isChainOrFranchise: boolean;
};

/**
 * Haiku, not Sonnet.
 *
 * This is a closed-enum classification against text that is already in front of
 * the model — the hard part is the crawl, not the judgement. Haiku 4.5 is built
 * for exactly this shape, and at $1/$5 per million tokens against Sonnet 5's
 * $3/$15 it is a third of the price for the same tally. Over 4,512 clinics that
 * is the difference between roughly $43 and roughly $14.
 *
 * If a hand-check of the evidence column shows Haiku genuinely mislabelling a
 * segment, raise it — but check first. Paying 3× on the assumption that a
 * bigger model must be better is how a one-off script quietly costs $40.
 */
const MODEL = "claude-haiku-4-5";

const SYSTEM = `You classify US aesthetic and medical clinics into exactly one primary segment, from their own website text.

SEGMENTS — choose exactly one id:
${SEGMENT_RULES}

TIE-BREAK, and apply it consistently: when a clinic offers several of these, choose what the HOMEPAGE LEADS WITH — the hero copy, the first service block, the thing the business is presenting itself as. That is the clinic's own statement of its primary business, it is stable between crawls, and it is where the marketing spend and the inbound calls go.

Two exceptions to the tie-break:
- If a supervised medical WEIGHT-LOSS programme is a headline offering, choose weight-loss-glp1 even when aesthetics leads. It is a distinct intake conversation and that is what we are segmenting for.
- If the practice is run by a board-certified SURGEON doing surgical procedures, choose plastic-surgery even if a med spa operates alongside it.

CONFIDENCE:
  high    — an explicit service menu makes the primary offering unambiguous
  medium  — the offering is clear but inferred from hero copy or partial text
  low     — thin, generic, or the page barely loaded

Also report, from the same text:
  offersOnlineBooking  — a real self-serve booking widget or "Book online" flow.
                         A contact form, a "request a consultation" form or a
                         phone number is NOT online booking.
  mentionsWeightLoss   — semaglutide, tirzepatide, GLP-1, medical weight loss.
  isChainOrFranchise   — multi-location chain or franchise language ("locations
                         near you", "find a location", a named national brand).

Return JSON only.`;

/**
 * The same classification through the Batch API, at half the token price.
 *
 * Worth its own code path because the trade it asks for costs nothing here.
 * Batches are not latency-guaranteed — most finish inside an hour, the ceiling
 * is 24 — and this is a job that runs once, overnight, against a list that took
 * weeks to assemble. Paying double for a result you will read tomorrow morning
 * is a straight waste.
 *
 * It also removes the concurrency and rate-limit handling entirely: submit,
 * poll, read. Nothing to tune, nothing to back off.
 *
 * Results come back in arbitrary order, so they are keyed by `custom_id` — the
 * clinic id. Reading them positionally would silently attach every label to the
 * wrong clinic, which is the kind of bug that produces a plausible tally and no
 * error.
 */
/**
 * One schema, shared by the streaming and batch paths.
 *
 * Two copies would drift, and a drifted enum is the worst kind: the batch run
 * accepts a label the streaming run rejects, and the two produce different
 * tallies from the same crawl.
 */
const CLASSIFY_TOOL = {
  name: "classify",
  description: "Record the clinic's primary segment.",
  input_schema: {
    type: "object" as const,
    required: [
      "segment",
      "confidence",
      "evidence",
      "offersOnlineBooking",
      "mentionsWeightLoss",
      "isChainOrFranchise",
    ],
    properties: {
      segment: { type: "string", enum: [...SEGMENTS] },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      evidence: {
        type: "string",
        description: "One line quoting or naming what decided it.",
      },
      offersOnlineBooking: { type: "boolean" },
      mentionsWeightLoss: { type: "boolean" },
      isChainOrFranchise: { type: "boolean" },
    },
  },
};

/** A clinic we could not classify. Kept, never dropped — see crawlSites(). */
function unclassified(clinicId: string, why: string): Label {
  return {
    clinicId,
    segment: "not-a-target",
    confidence: "low",
    evidence: `classification failed: ${why}`,
    offersOnlineBooking: false,
    mentionsWeightLoss: false,
    isChainOrFranchise: false,
  };
}

/**
 * Split off the clinics that need no API call at all.
 *
 * A site that returned almost nothing gets labelled without spending a token.
 * Sending an empty page to a model produces a confident guess from the business
 * name, which is precisely the inference this pipeline exists to replace.
 */
function partition(crawls: CrawlResult[]): {
  labelled: Label[];
  toCall: CrawlResult[];
} {
  const labelled: Label[] = [];
  const toCall: CrawlResult[] = [];

  for (const crawl of crawls) {
    if (crawl.text.length < 200) {
      labelled.push({
        clinicId: crawl.clinicId,
        segment: "not-a-target",
        confidence: "low",
        evidence: crawl.error ?? "page had too little text to classify",
        offersOnlineBooking: false,
        mentionsWeightLoss: false,
        isChainOrFranchise: false,
      });
    } else {
      toCall.push(crawl);
    }
  }

  return { labelled, toCall };
}

/** Validate rather than trust — a label outside the enum splits a bucket. */
function readClassification(
  clinicId: string,
  content: readonly { type: string }[],
): Label {
  const block = content.find(
    (c): c is { type: "tool_use"; input: unknown } => c.type === "tool_use",
  );
  if (!block) throw new Error("no classification returned");

  const input = block.input as Omit<Label, "clinicId">;

  if (!SEGMENTS.includes(input.segment)) {
    throw new Error(`unknown segment: ${String(input.segment)}`);
  }

  return { clinicId, ...input };
}

export async function labelClinicsBatched(
  crawls: CrawlResult[],
  options: LabelOptions & {
    pollSeconds?: number;
    /**
     * Where to record the batch id, the moment it exists.
     *
     * Load-bearing, not a convenience. An OAuth access token lives about eight
     * hours and a batch may take up to twenty-four, so a long run can outlive
     * its own credentials — and without this, that failure loses a submitted,
     * already-billed batch, with no way forward but paying for all 4,500
     * requests again. With it, a re-run picks the batch back up and collects
     * results that were already paid for.
     *
     * The same recovery covers every other reason a poll loop dies: a closed
     * laptop, a dropped connection, Ctrl-C.
     */
    batchIdFile?: string;
  },
): Promise<Label[]> {
  const client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});

  const { labelled, toCall } = partition(crawls);
  const budgeted = toCall.slice(0, options.maxCalls ?? toCall.length);
  if (!budgeted.length) return labelled;

  const existing =
    options.batchIdFile && existsSync(options.batchIdFile)
      ? readFileSync(options.batchIdFile, "utf8").trim()
      : null;

  if (existing) console.log(`  resuming batch ${existing} — not resubmitting`);

  const batch = existing
    ? await client.messages.batches.retrieve(existing)
    : await client.messages.batches.create({
    requests: budgeted.map((crawl) => ({
      custom_id: crawl.clinicId,
      params: {
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM,
        messages: [
          { role: "user" as const, content: `Website: ${crawl.domain}\n\n${crawl.text}` },
        ],
        tools: [CLASSIFY_TOOL],
        tool_choice: { type: "tool" as const, name: "classify" },
      },
    })),
  });

  // Recorded before the first poll, so a crash between submit and completion is
  // always recoverable. Writing it afterwards would leave exactly the gap this
  // exists to close.
  if (options.batchIdFile && !existing) {
    writeFileSync(options.batchIdFile, batch.id);
    console.log(`  batch ${batch.id} submitted — id saved, safe to interrupt`);
  }

  const pollMs = (options.pollSeconds ?? 30) * 1000;
  for (;;) {
    const status = await client.messages.batches.retrieve(batch.id);
    if (status.processing_status === "ended") break;
    options.onProgress?.(
      status.request_counts.succeeded + status.request_counts.errored,
      budgeted.length,
    );
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const byId = new Map(budgeted.map((c) => [c.clinicId, c]));

  for await (const entry of await client.messages.batches.results(batch.id)) {
    const crawl = byId.get(entry.custom_id);
    if (!crawl) continue;

    if (entry.result.type !== "succeeded") {
      // An errored or expired row is a clinic we could not classify, and it is
      // kept as such. Dropping it would shrink the denominator and flatter
      // every remaining segment's share.
      labelled.push(unclassified(crawl.clinicId, `batch ${entry.result.type}`));
      continue;
    }

    try {
      labelled.push(readClassification(crawl.clinicId, entry.result.message.content));
    } catch (error) {
      labelled.push(
        unclassified(
          crawl.clinicId,
          error instanceof Error ? error.message.slice(0, 120) : "unknown",
        ),
      );
    }
  }

  // Cleared only once every result has been read. Removing it earlier would
  // discard the recovery handle while it is still the thing keeping an
  // already-paid-for batch reachable.
  if (options.batchIdFile && existsSync(options.batchIdFile)) {
    rmSync(options.batchIdFile);
  }

  return labelled;
}

export type LabelOptions = {
  /**
   * Optional, and deliberately so.
   *
   * The SDK resolves credentials in its own order — ANTHROPIC_API_KEY, then
   * ANTHROPIC_AUTH_TOKEN, then the OAuth profile written by `ant auth login`.
   * Passing `apiKey: undefined` lets that resolution happen; demanding an
   * explicit key here would reject a perfectly good logged-in profile and force
   * everyone to mint and store a long-lived secret they do not need.
   */
  apiKey?: string;
  /** Hard cap on spend. Beyond it, remaining clinics are left unlabelled. */
  maxCalls?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
};

export async function labelClinics(
  crawls: CrawlResult[],
  options: LabelOptions,
): Promise<Label[]> {
  const client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  const concurrency = options.concurrency ?? 8;

  const { labelled, toCall } = partition(crawls);
  const budgeted = toCall.slice(0, options.maxCalls ?? toCall.length);
  let done = 0;

  for (let i = 0; i < budgeted.length; i += concurrency) {
    const batch = budgeted.slice(i, i + concurrency);

    const results = await Promise.all(
      batch.map(async (crawl) => {
        try {
          return await labelOne(client, crawl);
        } catch (error) {
          // One failure must not lose the batch. An unlabelled clinic is
          // recoverable on a re-run; a crashed pipeline over 4,500 domains is
          // an afternoon.
          return unclassified(
            crawl.clinicId,
            error instanceof Error ? error.message.slice(0, 120) : "unknown",
          );
        }
      }),
    );

    labelled.push(...results);
    done += batch.length;
    options.onProgress?.(done, budgeted.length);
  }

  return labelled;
}

async function labelOne(
  client: Anthropic,
  crawl: CrawlResult,
): Promise<Label> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: SYSTEM,
    messages: [
      { role: "user", content: `Website: ${crawl.domain}\n\n${crawl.text}` },
    ],
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify" },
  });

  return readClassification(crawl.clinicId, response.content);
}
