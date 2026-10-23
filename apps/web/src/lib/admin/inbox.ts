import { readOpsInbox } from "@/lib/admin/clinic-strip";
import { composeInbox } from "@/lib/admin/inbox-rows";
import {
  fetchAgreementReviews,
  fetchClinicHealth,
  fetchClinics,
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
 * Server-only: it imports ops-client.
 */
export async function loadOpsInbox(now = new Date()): Promise<OpsInbox> {
  const upstream = await readOpsInbox();
  if (upstream?.ok) return upstream.data;

  const [clinics, health, reviews, agreementChecks, support, recordings, siteReads, setupRequestsWaiting] = await Promise.all([
    fetchClinics(),
    fetchClinicHealth(),
    fetchPracticeReviews(),
    fetchAgreementReviews(),
    fetchSupportRequests(),
    fetchRecordingAlerts(),
    fetchSiteReadFailures(),
    countSetupRequestsWaiting(),
  ]);
  const inbox = composeInbox(
    { clinics, health, reviews, agreementChecks, support, recordings, siteReads, launch: LAUNCH_PROMISES, setupRequestsWaiting },
    now,
  );
  if (upstream && !upstream.ok) inbox.unreadable.unshift({ source: "the ops inbox (alerts, transcripts, go-live)", reason: upstream.message });
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
