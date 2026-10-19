import { publicUrl } from "@/lib/public-url";
import {
  WEBSITE_CHANGE_SECTION_NAMES as SECTION_NAMES,
  type WebsiteChangeSection,
} from "@/lib/website/types";

import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L23, "Changes on your website" (Annex X5): to the clinic's address, when
 * the monthly drift check (lib/website) reads its website again and finds
 * things Knowledge does not say. It names each Knowledge section and a
 * count, never the service, the price or the words (Annex X5, "L23: names
 * the Knowledge section and a count, never the service"), and links to the
 * list on Knowledge, behind sign-in, where each change is confirmed or
 * ignored.
 *
 * Once per check (dedupe `website_changes:<read id>`); a change the clinic
 * ignored is never counted again. An outbox kind: no token.
 */

export type WebsiteChangesPayload = {
  /** Each section with changes, in the list's order, and how many. */
  sectionRows: { section: WebsiteChangeSection; count: number }[];
  /** All of them. */
  count: number;
  /** publicUrl("/c/<slug>/knowledge#website"). */
  reviewUrl: string;
};

/** "2 in Prices and 1 in Hours". */
export function sectionCounts(rows: WebsiteChangesPayload["sectionRows"]): string {
  const parts = rows.map((row) => `${row.count} in ${SECTION_NAMES[row.section]}`);
  return parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export const renderWebsiteChanges: EmailTemplate<WebsiteChangesPayload> = (payload, ctx) => {
  const rows = payload.sectionRows.filter((row) => row.count > 0);
  for (const row of rows) {
    if (!(row.section in SECTION_NAMES)) {
      throw new EmailCompositionError(`"${String(row.section)}" is not a Knowledge section.`);
    }
  }
  if (rows.length === 0 || payload.count < 1) {
    throw new EmailCompositionError("A website changes email needs at least one change.");
  }
  const n = payload.count;
  const changes = n === 1 ? "one change" : `${n} changes`;
  const clinic = ctx.clinicName ?? "your practice";
  return compose(
    {
      subject: "Changes on your website",
      preheader: `We found ${changes} AYA doesn't know yet: ${sectionCounts(rows)}.`,
      blocks: [
        {
          type: "paragraph",
          text: `We read ${clinic}'s website again and found ${changes} that AYA doesn't know yet: ${sectionCounts(rows)}.`,
        },
        {
          type: "paragraph",
          text: `AYA keeps answering from Knowledge as it is. Confirm each change there and she uses it, or ignore it and we won't raise it again.`,
        },
        { type: "action", label: "Review the changes", url: payload.reviewUrl },
      ],
    },
    ctx,
  );
};

export const WEBSITE_CHANGES_ENTRY: TemplateEntry<WebsiteChangesPayload> = {
  render: renderWebsiteChanges,
  get fixture(): WebsiteChangesPayload {
    return {
      sectionRows: [
        { section: "prices", count: 2 },
        { section: "hours", count: 1 },
      ],
      count: 3,
      reviewUrl: publicUrl("/c/radiance-med-spa/knowledge#website"),
    };
  },
};
