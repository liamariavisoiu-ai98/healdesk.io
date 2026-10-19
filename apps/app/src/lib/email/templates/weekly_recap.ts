import { publicUrl } from "@/lib/public-url";
import type { ClaimsPayload } from "@/lib/reporting/claim-words";

import { counted } from "./billing-copy";
import { compose } from "./compose";
import { claimsFixture, weekBlocks } from "./daily_summary";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L14, "Your week with AYA" (Annex X5), on its own: on the clinic's Monday,
 * only while no daily summary can carry it, because the Daily summary switch
 * is off or no opening hours are on file to send one at
 * (lib/scheduler/weekly-recap.ts). While the summary goes, the week's first
 * one carries these same figures and this email does not go (X3, "Designed
 * merges"). To the clinic's one address, through the outbox; part of the
 * service, so no switch of its own: the daily summary's would stop it exactly
 * when it is meant to go.
 *
 * Counts only, from the claims function (lib/reporting/claims.ts), worded as
 * Home and the daily summary word them. It no longer asks for a reply about
 * anything that looked wrong on a call: replies reach hello@, which is kept
 * free of patient details, and the portal has no flag on a conversation yet,
 * so the email says nothing about flagging.
 */

export type WeeklyRecapPayload = {
  /** Last week's Monday and Sunday, clinic-local dates. */
  weekStartOn: string;
  weekEndOn: string;
  weekClaims: ClaimsPayload;
  /** Why it came alone: the summary is off (else no opening hours are on file). */
  isSummaryOff: boolean;
  /** publicUrl("/c/<slug>"): Home, with this week's numbers. */
  homeUrl: string;
  /** publicUrl("/c/<slug>/settings#alerts") or ("/c/<slug>/knowledge#hours"): the one change that folds this into a summary. */
  settingsUrl: string;
};

export const renderWeeklyRecap: EmailTemplate<WeeklyRecapPayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  return compose(
    {
      subject: "Your week with AYA",
      preheader: `${counted(payload.weekClaims.handledCount, "conversation", "conversations")} handled at ${clinic} last week.`,
      blocks: [
        ...weekBlocks(payload.weekClaims, payload.weekStartOn, payload.weekEndOn, ctx),
        { type: "action", label: "See this week on Home", url: payload.homeUrl },
        {
          type: "paragraph",
          text: payload.isSummaryOff
            ? `Your daily summary is off, so this comes on its own each Monday. With the summary on, each working day brings every booking and booking request, and the week's first carries this recap: ${payload.settingsUrl}`
            : `Your daily summary goes out at your opening time, and your opening hours aren't set yet, so this comes on its own each Monday. Add your hours, and the week's first summary carries it: ${payload.settingsUrl}`,
        },
      ],
    },
    ctx,
  );
};

export const WEEKLY_RECAP_ENTRY: TemplateEntry<WeeklyRecapPayload> = {
  render: renderWeeklyRecap,
  get fixture(): WeeklyRecapPayload {
    return {
      weekStartOn: "2026-10-05",
      weekEndOn: "2026-10-11",
      weekClaims: claimsFixture({
        handledCount: 61,
        voiceCount: 38,
        webCount: 23,
        rangOutCount: 27,
        requestsTakenCount: 15,
        requestsConfirmedCount: 11,
        bookedValueCents: 312_500,
        pricedBookingsCount: 9,
        perUnitBookingsCount: 2,
        depositsCollectedCount: 4,
        depositsCollectedCents: 20_000,
      }),
      isSummaryOff: true,
      homeUrl: publicUrl("/c/radiance-med-spa"),
      settingsUrl: publicUrl("/c/radiance-med-spa/settings#alerts"),
    };
  },
};
