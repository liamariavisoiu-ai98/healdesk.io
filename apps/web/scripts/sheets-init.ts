import { isMarketingStoreConfigured, sheetsClient } from "../src/lib/sheets/client";
import { TABS, ensureSheetSchema } from "../src/lib/sheets/schema";

/**
 * Provision the marketing Sheet's tabs and header rows, once:
 *
 *   npm run sheets:init -w @healdesk/web
 *
 * Reads MARKETING_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON from the
 * environment (or apps/web/.env.local). The site does the same thing lazily
 * on its first write, so this is a convenience for checking the sharing and
 * the key before a deploy rather than a migration step anything depends on.
 * Idempotent: tabs and headers that already exist are left alone, and a tab
 * whose header row is not ours is refused rather than overwritten.
 */
async function main(): Promise<void> {
  if (!isMarketingStoreConfigured()) {
    throw new Error(
      "MARKETING_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON must both be set (the second as the key file's JSON, or base64 of it).",
    );
  }
  await ensureSheetSchema(sheetsClient());
  console.log(`Marketing Sheet ready: ${TABS.map((tab) => `${tab.title} (${tab.columns.length} columns)`).join(", ")}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
