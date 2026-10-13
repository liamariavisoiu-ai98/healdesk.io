import { afterEach, describe, expect, test, vi } from "vitest";

import {
  readSiteOfferToken,
  SITE_OFFER_COOKIE,
  siteOfferEndsAt,
  siteOfferFromCookieHeader,
  siteOfferLive,
  siteOfferState,
  siteOfferToken,
} from "./site-offer";

const AT = new Date("2026-10-13T12:00:00Z");
const HOUR = 3_600_000;

afterEach(() => vi.unstubAllEnvs());

describe("the website's setup offer cookie", () => {
  test("round-trips the moment it was made", () => {
    const token = siteOfferToken(AT)!;
    expect(readSiteOfferToken(token, AT.getTime() + HOUR)?.toISOString()).toBe(AT.toISOString());
  });

  test("a value the browser wrote is not an offer", () => {
    const token = siteOfferToken(AT)!;
    const [, sig] = token.split(".");
    expect(readSiteOfferToken(`${AT.getTime() + HOUR}.${sig}`, AT.getTime() + 2 * HOUR)).toBeNull();
    expect(readSiteOfferToken(`${AT.getTime()}.forged`, AT.getTime())).toBeNull();
    expect(readSiteOfferToken("", AT.getTime())).toBeNull();
    expect(readSiteOfferToken(null)).toBeNull();
  });

  test("a moment in the future is refused", () => {
    expect(readSiteOfferToken(siteOfferToken(AT)!, AT.getTime() - 1)).toBeNull();
  });

  test("lives for 48 hours and not a moment longer", () => {
    const header = `a=b; ${SITE_OFFER_COOKIE}=${encodeURIComponent(siteOfferToken(AT)!)}`;
    expect(siteOfferFromCookieHeader(header, AT.getTime())?.getTime()).toBe(AT.getTime());
    expect(siteOfferLive(header, AT.getTime() + 48 * HOUR - 1)).toBe(true);
    expect(siteOfferLive(header, AT.getTime() + 48 * HOUR)).toBe(false);
    expect(siteOfferLive(null)).toBe(false);
    expect(siteOfferState(AT, AT.getTime() + HOUR).endsAt).toBe("2026-10-15T12:00:00.000Z");
    expect(siteOfferState(AT, AT.getTime() + 49 * HOUR).endsAt).toBeNull();
  });

  test("says when it ends, from the Cookie header, while it holds", () => {
    const header = `${SITE_OFFER_COOKIE}=${encodeURIComponent(siteOfferToken(AT)!)}`;
    expect(siteOfferEndsAt(header, AT.getTime() + HOUR)?.toISOString()).toBe("2026-10-15T12:00:00.000Z");
    expect(siteOfferEndsAt(header, AT.getTime() + 48 * HOUR)).toBeNull();
    expect(siteOfferEndsAt(`${SITE_OFFER_COOKIE}=${AT.getTime()}.forged`, AT.getTime())).toBeNull();
    expect(siteOfferEndsAt(null)).toBeNull();
  });

  test("a different secret does not read it", () => {
    vi.stubEnv("HEALDESK_GATE_SECRET", "one");
    const token = siteOfferToken(AT)!;
    vi.stubEnv("HEALDESK_GATE_SECRET", "two");
    expect(readSiteOfferToken(token, AT.getTime())).toBeNull();
  });
});
