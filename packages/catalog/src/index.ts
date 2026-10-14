/**
 * @healdesk/catalog — the contract between the marketing site and the product.
 *
 * Mostly domain data (platforms, plans, specialties, the BAA and the DPA), plus
 * the request-signing helper the two apps use to talk to each other.
 *
 * Everything here exists because drift between apps/web and apps/app is a real
 * bug, not a tidiness concern. If the picker offers a platform the provisioning
 * API rejects, the customer hits it mid-checkout. If the signing and verifying
 * sides disagree by one byte, provisioning fails with an opaque 401.
 *
 * No dependencies, so importing it from either side pulls nothing along.
 * Four server-side modules are subpath exports instead, so the browser never
 * imports them: `@healdesk/catalog/agreement-pdf` (pdf-lib, the one
 * dependency), `/agreement-signing` and `/mail-address` (node:url), and
 * `/checkout-record` (node:zlib).
 */

export * from "./agreement-copy";
export * from "./agreement-copy-email";
export * from "./agreement-kind";
export * from "./agreement-match";
export * from "./agreement-termination";
export * from "./assistant-settings";
export * from "./audience";
export * from "./baa";
export * from "./baa-explainer";
export * from "./baa-selections";
export * from "./booking-requirements";
export * from "./booking-systems";
export * from "./calendar-terms";
export * from "./checkout-intent";
export * from "./clinic-profile";
export * from "./clinical-content";
export * from "./connection-steps";
export * from "./direct-booking-addendum";
export * from "./dpa";
export * from "./dpa-calendar-election";
export * from "./dpa-explainer";
export * from "./forwarding";
export * from "./google-calendar-disclosure";
export * from "./onboarding";
export * from "./plans";
export * from "./platforms";
export * from "./provision-request";
export * from "./purchase";
export * from "./request-signing";
export * from "./segments";
export * from "./sender-identity";
export * from "./specialties";
export * from "./subprocessor-notice";
export * from "./time-zones";
export * from "./treatment-names";
export * from "./treatment-vocabulary";
export * from "./urgent-content";
export * from "./welcome";
