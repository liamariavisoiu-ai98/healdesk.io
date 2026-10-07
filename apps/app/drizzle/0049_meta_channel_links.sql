-- Two more single-use link purposes: `meta` connects a clinic's Facebook Page
-- and its linked Instagram account through Facebook Login for Business, and
-- `whatsapp` its number through Embedded Signup (launch plan 1.6 and 2.5,
-- docs/meta-app-review.md). Separate purposes rather than one "channels"
-- link, because a link is burned in the transaction that stores what it
-- bought, and a clinic connecting both channels would otherwise spend it on
-- the first. Resolution and consumption already compare the purpose column
-- (lib/connections/links.ts), so a Meta token still opens nothing else.
ALTER TABLE "connection_links" DROP CONSTRAINT "connection_links_purpose_known";--> statement-breakpoint
ALTER TABLE "connection_links"
  ADD CONSTRAINT "connection_links_purpose_known" CHECK (purpose IN ('connect', 'setup', 'meta', 'whatsapp'));
