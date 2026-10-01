import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
  /**
   * How many sites, and whose decision it is. Set by the chain triage, absent
   * on a clinic that was never flagged.
   *
   * The classifier's isChainOrFranchise fires on the word "locations", which
   * catches a two-site independent exactly as hard as a 400-site franchise.
   * 438 of the 835 it flagged turned out to be a group of two to ten sites
   * under one owner, which is a better prospect than a single site rather than
   * a worse one.
   */
  chainTier?: "national-chain" | "multi-site-group" | "single-site" | "unclear";
  /** Locations countable on the page. Null where the page does not say. */
  siteCount?: number | null;
  /**
   * Opening hours, when the page states them.
   *
   * Two shapes on purpose. `opensAt`/`closesAt` are the single weekday pair —
   * what a spreadsheet column can hold, and what was asked for. `hoursByDay`
   * keeps the detail that pair throws away, because for an after-hours product
   * the discarded part is the valuable part: a med spa's Saturday is when its
   * missed calls are worth most, and "Mon-Fri 9-5" collapses Saturday and
   * "closed Sunday" into the same blank.
   *
   * Null when the page does not say. Guessing plausible clinic hours would be
   * indistinguishable from reading them, and these hours go into a cold email
   * the clinic can check. At most they pre-fill the hours a clinic confirms in
   * the onboarding wizard; nothing here is written into apps/app.
   */
  opensAt: string | null;
  closesAt: string | null;
  hoursByDay: string | null;
  /**
   * The one service this clinic leads with, in its own words.
   *
   * Not the segment. `injectables` is a category this pipeline invented for
   * counting, and it reads like a category in a sentence — "an injectables
   * appointment" is not something a patient would ever say. The clinic's own
   * word is "Botox", "lip filler", "CoolSculpting", "semaglutide", and using it
   * is the difference between a mail merge and someone who looked at the site.
   *
   * Null when the page does not make one service clearly primary, because a
   * guess here is visible: naming a treatment a clinic does not offer is worse
   * than naming none.
   */
  topService: string | null;
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

const SYSTEM = `You classify US aesthetic, medical and veterinary clinics into exactly one primary segment, from their own website text.

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

TOP SERVICE — the single treatment this clinic leads with, written the way a
patient would ask for it: "Botox", "lip filler", "CoolSculpting", "semaglutide",
"Invisalign", "LASIK". Take it from the hero copy and the first service block,
which is the clinic's own statement of what it sells.

Never a category. "injectables" and "medical aesthetics" are shelf labels this
pipeline uses for counting; nobody rings up to book an injectables appointment.
Null if no single service is clearly primary — naming a treatment the clinic
does not offer is worse than naming none, because they will notice.

OPENING HOURS — report them ONLY if the page states them. opensAt and closesAt
are the typical WEEKDAY pair in 24-hour HH:MM; put weekends and any closed days
in hoursByDay.

Null for all three if the page does not say. Do not infer them from what a
clinic of this type usually does: these figures decide whether a real phone call
is later counted as after-hours, so an invented one is worse than an absent one.

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
      "opensAt",
      "closesAt",
      "hoursByDay",
      "topService",
    ],
    properties: {
      topService: {
        type: ["string", "null"],
        description:
          'The single service the clinic leads with, in ITS OWN words and as a patient would say it — "Botox", "lip filler", "CoolSculpting", "semaglutide", "Invisalign", "LASIK". Two or three words at most, lowercase unless it is a brand name. NOT a category like "injectables" or "aesthetics". Null if no one service is clearly primary.',
      },
      segment: { type: "string", enum: [...SEGMENTS] },
      opensAt: {
        type: ["string", "null"],
        description:
          'Typical weekday opening time, 24h HH:MM (e.g. "09:00"). Null if the page does not state hours. Never guess.',
      },
      closesAt: {
        type: ["string", "null"],
        description:
          'Typical weekday closing time, 24h HH:MM (e.g. "17:00"). Null if the page does not state hours. Never guess.',
      },
      hoursByDay: {
        type: ["string", "null"],
        description:
          'All stated hours on one line, e.g. "Mon-Thu 09:00-19:00; Fri 09:00-17:00; Sat 10:00-14:00; Sun closed". Null if not stated.',
      },
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
    segment: "unknown",
    confidence: "low",
    evidence: `classification failed: ${why}`,
    opensAt: null,
    closesAt: null,
    hoursByDay: null,
    topService: null,
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
 *
 * These are labelled `unknown`, NOT `not-a-target`, and the distinction is
 * worth more than it looks. `not-a-target` is a finding — this is a device
 * manufacturer, an agency, a training academy. `unknown` is an admission that
 * the crawl failed. Conflating them discards live prospects as if they had been
 * examined and rejected: the first sample buried crawfordplasticsurgery.com and
 * centerforadvanceddentistry.com in the reject pile, both obviously real
 * practices, purely because their sites timed out.
 *
 * Same rule as the rest of the pipeline — when we cannot measure something, say
 * so rather than emitting a number that reads like a conclusion.
 */
/**
 * Clinics the budget did not reach, returned rather than dropped.
 *
 * The caller writes `[...settled, ...fresh]` over the labels file, and `settled`
 * deliberately excludes "unknown" so a retried crawl gets reclassified. So a
 * clinic that partition() sent to toCall but maxCalls cut off appeared in
 * NEITHER list, and the write silently deleted it: `--max-llm 5` on a fresh run
 * would have left a labels file holding five rows and lost the rest.
 *
 * Returned as unknown, which is also what makes them retry on the next run.
 */
function deferred(crawls: CrawlResult[], why: string): Label[] {
  return crawls.map((c) => ({
    ...unclassified(c.clinicId, why),
    evidence: `not classified: ${why}`,
  }));
}

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
        segment: "unknown",
        confidence: "low",
        evidence: crawl.error ?? "page had too little text to classify",
        opensAt: null,
        closesAt: null,
        hoursByDay: null,
        topService: null,
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
  const skipped = deferred(toCall.slice(budgeted.length), "call budget reached");
  if (!budgeted.length) return [...labelled, ...skipped];

  const existing =
    options.batchIdFile && existsSync(options.batchIdFile)
      ? readFileSync(options.batchIdFile, "utf8").trim()
      : null;

  if (existing) console.log(`  resuming batch ${existing} — not resubmitting`);

  // A batch id on disk says nothing about WHICH clinics it covers. Resuming a
  // 200-clinic batch for a 4,512-clinic request set returned 200 labels and
  // reported success, so the remaining 4,312 vanished with no error anywhere.
  // The ids that come back are checked against the ids asked for, below.

  // Submitted through a client that does NOT retry.
  //
  // The default is maxRetries: 2, and the create POST carries every clinic's
  // page text — roughly 33 MB for a full run. If that upload drops after the
  // server has accepted it but before the response comes back, a retry creates
  // a SECOND batch. Both are billed, only one id reaches disk, and the orphan
  // finishes and charges with nothing reading its results.
  //
  // A retry cannot be made safe here because the API has no idempotency key on
  // this endpoint, so the only correct behaviour is to fail once and loudly and
  // let the operator look before resubmitting.
  const submitter = new Anthropic(
    options.apiKey ? { apiKey: options.apiKey, maxRetries: 0 } : { maxRetries: 0 },
  );

  const batch = existing
    ? await client.messages.batches.retrieve(existing)
    : await submitter.messages.batches.create({
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

  /**
   * Rebuild the client on an auth failure, rather than dying.
   *
   * An OAuth access token lives about eight hours; a batch may run for
   * twenty-four. The client caches its credential at construction, so a long
   * batch outlives the token it was created with — and the failure lands in the
   * middle of the poll loop, holding a submitted, already-billed batch.
   *
   * Reconstructing re-reads the credential from disk, which picks up a token
   * the CLI has since refreshed. If the profile itself has expired, the retry
   * fails the same way and the error surfaces with the batch id intact, so the
   * work is still recoverable by re-running after `ant auth login`.
   */
  let poller = client;
  let authRetries = 0;

  for (;;) {
    let status;
    try {
      status = await poller.messages.batches.retrieve(batch.id);
      authRetries = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAuth = /401|authentication|unauthorized|expired|credential/i.test(message);

      if (!isAuth || authRetries >= 3) throw error;

      authRetries += 1;
      console.log(
        `\n  credentials expired mid-batch — reloading (attempt ${authRetries}/3). ` +
          `The batch is safe; its id is on disk.`,
      );
      poller = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

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

  // Deliberately NOT cleared here.
  //
  // Reading the results and persisting them are two steps, and a crash between
  // them used to lose the batch: the id was gone, so the next run resubmitted
  // and paid for all 4,500 classifications a second time. The caller deletes
  // the id after it has written the labels to disk, which is the only moment
  // the work is genuinely safe.
  const returned = new Set(labelled.map((l) => l.clinicId));
  const missing = budgeted.filter((c) => !returned.has(c.clinicId));

  if (missing.length) {
    // Whatever the resumed batch did not cover is classified now, in the same
    // invocation. Silently returning a short list is the one outcome that must
    // not happen: it looks exactly like a complete run.
    console.log(
      `\n  resumed batch covered ${returned.size} of ${budgeted.length} — ` +
        `classifying the remaining ${missing.length} directly`,
    );
    labelled.push(
      ...(await labelClinics(missing, { ...options, maxCalls: missing.length })),
    );
  }

  return [...labelled, ...skipped];
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
  const skipped = deferred(toCall.slice(budgeted.length), "call budget reached");
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

  return [...labelled, ...skipped];
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
