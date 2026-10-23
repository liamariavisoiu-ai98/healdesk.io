import { loadClinicRows, readOpsInbox } from "@/lib/admin/clinic-strip";
import { composeInbox } from "@/lib/admin/inbox-rows";
import {
  fetchAgreementReviews,
  fetchPracticeReviews,
  fetchRecordingAlerts,
  fetchSiteReadFailures,
  fetchSupportRequests,
} from "@/lib/admin/ops-client";
import { LAUNCH_PROMISES } from "@/lib/admin/seo/launch";
import { listSetupRequests } from "@/lib/setup-requests";
import { isMarketingStoreConfigured } from "@/lib/sheets/client";
import type { OpsInbox } from "@/lib/admin/strip-types";

/**
 * What Home reads (E1 step 4). Lane A2's `opsInbox`, built in apps/app on
 * the digest and the open alerts, is the list once it lands; until then, and
 * whenever it cannot be read, Home is composed here from the reads this app
 * already makes, with the failure named in `unreadable` so the list never
 * looks complete when it is not. Seven reads, settled independently: one
 * that fails costs its row, never the list.
 *
 * The clinic list and the first-weeks rows come from the Clinics table's
 * cached loader rather than their own reads: the list read runs a
 * connection-state check per clinic upstream, and one per request is enough.
 *
 * Server-only: it imports ops-client.
 */

/** What Home cannot show while apps/app's inbox is not read: named, so the list never looks complete. */
export const INBOX_MISSING_SOURCE = "the alerts, undelivered transcripts and ready-to-go-live rows";

export async function loadOpsInbox(now = new Date()): Promise<OpsInbox> {
  const upstream = await readOpsInbox();
  if (upstream?.ok) return upstream.data;

  const [reads, reviews, agreementChecks, support, recordings, siteReads, setupRequestsWaiting] = await Promise.all([
    loadClinicRows(),
    fetchPracticeReviews(),
    fetchAgreementReviews(),
    fetchSupportRequests(),
    fetchRecordingAlerts(),
    fetchSiteReadFailures(),
    countSetupRequestsWaiting(),
  ]);
  const clinics = reads.clinics.ok ? { ok: true as const, data: reads.rows } : reads.clinics;
  const inbox = composeInbox(
    { clinics, health: reads.health, reviews, agreementChecks, support, recordings, siteReads, launch: LAUNCH_PROMISES, setupRequestsWaiting },
    now,
  );
  inbox.unreadable.unshift(
    upstream
      ? { source: INBOX_MISSING_SOURCE, reason: upstream.message }
      : { source: INBOX_MISSING_SOURCE, reason: "the ops inbox has not landed in this console yet; only the queues and clinics it can read are listed" },
  );
  return inbox;
}

/** Setup requests with no link sent: null when no Sheet is configured, the reason when it could not be read. */
async function countSetupRequestsWaiting(): Promise<number | null | { failed: string }> {
  if (!isMarketingStoreConfigured()) return null;
  try {
    const requests = await listSetupRequests(200);
    return requests.filter((r) => r.status === "new" && !r.invitedAt && !r.unsubscribedAt).length;
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}
