import { and, asc, eq, ne } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { supportCases } from "@/db/schema";

import type { SupportCaseState } from "../case-vocab";
import { topicLabel } from "../escalation-fields";
import { dayWords } from "./tools";

/**
 * The portal chat's get_open_cases (design E5 §3 and §8 S8; owner D16): the
 * practice's own open support requests as dates, topics, states and reply-by
 * days, so the chat can say "we have your request from Tuesday; a person
 * replies by Thursday" instead of opening a second case. Never a ref, never
 * an id, never a word of text: a case holds none, and this carries none.
 *
 * Read for the signed-in practice's clinic id only (the chat's session
 * names it), from the platform-wide support_cases filtered to that clinic.
 */

export const OPEN_CASES_MAX = 10;

export type OpenCase = {
  /** ISO day the request opened, in New York. */
  openedOn: string;
  category: string;
  state: Exclude<SupportCaseState, "closed">;
  /** ISO day a person replies by. */
  replyByOn: string;
};

function isoDay(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The clinic's open requests, oldest first. */
export async function readOpenCases(clinicId: string): Promise<OpenCase[]> {
  const rows = await unsafeDb
    .select({ openedAt: supportCases.openedAt, category: supportCases.category, state: supportCases.state, replyByOn: supportCases.replyByOn })
    .from(supportCases)
    .where(and(eq(supportCases.subjectClinicId, clinicId), ne(supportCases.state, "closed")))
    .orderBy(asc(supportCases.openedAt), asc(supportCases.id))
    .limit(OPEN_CASES_MAX);
  return rows.map((r) => ({
    openedOn: isoDay(r.openedAt),
    category: r.category,
    state: r.state as OpenCase["state"],
    replyByOn: r.replyByOn,
  }));
}

/** Where a request stands, said to the practice. */
const STANDS: Readonly<Record<OpenCase["state"], string>> = {
  new: "with the healdesk team",
  drafting: "with the healdesk team",
  drafted: "with the healdesk team",
  needs_edit: "with the healdesk team",
  snoozed: "with the healdesk team",
  waiting_clinic: "healdesk replied by email and is waiting on the practice",
};

/** get_open_cases's result, as the model reads it. */
export function openCasesText(cases: readonly OpenCase[]): string {
  if (cases.length === 0) return "This practice has no open support requests.";
  return [
    "This practice's open support requests (dates, topics and where each stands; never anyone's words):",
    ...cases.map((c) => {
      const stands = STANDS[c.state];
      const reply = c.state === "waiting_clinic" ? "" : `; a person replies by ${dayWords(c.replyByOn)}`;
      return `- Opened ${dayWords(c.openedOn)}, about ${topicLabel(c.category)}: ${stands}${reply}.`;
    }),
  ].join("\n");
}
