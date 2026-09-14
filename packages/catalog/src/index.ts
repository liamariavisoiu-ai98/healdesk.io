/**
 * @healdesk/catalog — the contract between the marketing site and the product.
 *
 * Mostly domain data (platforms, plans, specialties, the BAA document), plus
 * the request-signing helper the two apps use to talk to each other.
 *
 * Everything here exists because drift between apps/web and apps/app is a real
 * bug, not a tidiness concern. If the picker offers a platform the provisioning
 * API rejects, the customer hits it mid-checkout. If the signing and verifying
 * sides disagree by one byte, provisioning fails with an opaque 401.
 *
 * No dependencies, so importing it from either side pulls nothing along.
 */

export * from "./baa";
export * from "./baa-explainer";
export * from "./clinical-content";
export * from "./connection-steps";
export * from "./forwarding";
export * from "./onboarding";
export * from "./plans";
export * from "./platforms";
export * from "./request-signing";
export * from "./segments";
export * from "./specialties";
