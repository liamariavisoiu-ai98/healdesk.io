import { queuesSource } from "./queues";
import { healthFlagsSource } from "./health-flags";
import { opsAlertsSource } from "./ops-alerts";
import { practiceReviewsSource } from "./practice-reviews";
import { recordingAlertsSource } from "./recording-alerts";
import { siteReadsSource } from "./site-reads";
import { supportRepliesSource } from "./support-replies";
import type { InboxSource } from "./types";

/**
 * Every source Home reads, in the order they are read (the order rows are
 * shown in is decided afterwards, by orderInbox). To add one: a file beside
 * this one exporting an InboxSource, its kind in INBOX_KINDS, and one line
 * here.
 *
 * Not here, and why:
 *   - setup requests owed: they live in the marketing Sheet, which only
 *     apps/web reads; the ones past the day promised already reach the ops
 *     log as `setup_request_reply_past_due`, which the ops-alerts source lists;
 *   - launch promises: LAUNCH_PROMISES is apps/web's
 *     (lib/admin/seo/launch.ts), which apps/app cannot read.
 */
export const INBOX_SOURCES: readonly InboxSource[] = [
  opsAlertsSource,
  queuesSource,
  healthFlagsSource,
  practiceReviewsSource,
  supportRepliesSource,
  recordingAlertsSource,
  siteReadsSource,
];
