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

const MODEL = "claude-sonnet-5";

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

export type LabelOptions = {
  apiKey: string;
  /** Hard cap on spend. Beyond it, remaining clinics are left unlabelled. */
  maxCalls?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
};

export async function labelClinics(
  crawls: CrawlResult[],
  options: LabelOptions,
): Promise<Label[]> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const concurrency = options.concurrency ?? 8;
  const max = options.maxCalls ?? crawls.length;

  // A site that returned nothing gets labelled without an API call. Sending an
  // empty page to a model produces a confident guess from a business name,
  // which is precisely the inference this whole pipeline exists to replace.
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

  const budgeted = toCall.slice(0, max);
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
          return {
            clinicId: crawl.clinicId,
            segment: "not-a-target" as Segment,
            confidence: "low" as const,
            evidence: `classification failed: ${
              error instanceof Error ? error.message.slice(0, 120) : "unknown"
            }`,
            offersOnlineBooking: false,
            mentionsWeightLoss: false,
            isChainOrFranchise: false,
          };
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
      {
        role: "user",
        content: `Website: ${crawl.domain}\n\n${crawl.text}`,
      },
    ],
    tools: [
      {
        name: "classify",
        description: "Record the clinic's primary segment.",
        input_schema: {
          type: "object",
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
      },
    ],
    tool_choice: { type: "tool", name: "classify" },
  });

  const block = response.content.find((c) => c.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("no classification returned");
  }

  const input = block.input as Omit<Label, "clinicId">;

  // Validate rather than trust. A label outside the enum would create a segment
  // that exists only in this run and quietly splits a bucket.
  if (!SEGMENTS.includes(input.segment)) {
    throw new Error(`unknown segment: ${String(input.segment)}`);
  }

  return { clinicId: crawl.clinicId, ...input };
}
