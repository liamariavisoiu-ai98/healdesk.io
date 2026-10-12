import { SENDER_IDENTITY } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { ENTITY, entityLine } from "./legal";
import { site } from "./site";

/**
 * apps/app's email footer prints the entity and the mailbox from the catalog's
 * mirror, because it cannot import this app's legal.ts. The site and every
 * email must name the same company at the same address, so the mirror is held
 * to the source here: change one without the other and this fails.
 */
describe("the email footer's sender identity matches the site's", () => {
  test("the entity line, as entityLine() words it", () => {
    expect(SENDER_IDENTITY.entityLine).toBe(entityLine());
  });

  test("the US mailing address and its label", () => {
    expect(SENDER_IDENTITY.postalAddress).toBe(ENTITY.postalAddress);
    expect(SENDER_IDENTITY.postalAddressLabel).toBe(ENTITY.postalAddressLabel);
  });

  test("replies go to the one address, the same one every page names", () => {
    // hello@ is the only address, for everything (owner, 9 October 2026):
    // the legal pages, the site and every email's Reply-To name the same one.
    expect(ENTITY.email).toBe("hello@healdesk.io");
    expect(SENDER_IDENTITY.replyTo).toBe(ENTITY.email);
    expect(site.email).toBe(ENTITY.email);
  });
});
