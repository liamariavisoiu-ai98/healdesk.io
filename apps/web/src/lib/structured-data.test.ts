import { PRODUCTS } from "@healdesk/catalog";
import { describe, expect, it } from "vitest";

import { site } from "./site";
import { organizationLd, serializeLd, softwareApplicationLd, termAnchor } from "./structured-data";

describe("structured data", () => {
  it("names the company without its legal name, which only Terms and Privacy print", () => {
    const org = organizationLd();
    expect(org).toMatchObject({ "@type": "Organization", name: "healdesk", url: site.url, email: site.email });
    expect(org).not.toHaveProperty("legalName");
    expect(JSON.stringify(org)).not.toMatch(/Viixi/i);
  });

  it("gives no sameAs until a profile URL is real", () => {
    if (site.profiles.length === 0) expect(organizationLd()).not.toHaveProperty("sameAs");
    else expect(organizationLd().sameAs).toEqual(site.profiles);
  });

  it("prices every product from the catalog, so the markup cannot drift from checkout", () => {
    const offers = softwareApplicationLd().offers as { name: string; price: number; priceSpecification: { price: number }[] }[];
    expect(offers.map((offer) => offer.name)).toEqual(Object.values(PRODUCTS).map((product) => product.name));
    for (const [index, product] of Object.values(PRODUCTS).entries()) {
      expect(offers[index]?.price).toBe(product.perStepMonthlyUsd);
      expect(offers[index]?.priceSpecification[1]?.price).toBe(product.setupFeeUsd);
    }
  });

  it("carries no rating or review, since none is published", () => {
    expect(JSON.stringify(softwareApplicationLd())).not.toMatch(/aggregateRating|"review"/);
  });

  it("escapes < so a string can never close the script element", () => {
    expect(serializeLd({ name: "</script><script>alert(1)</script>" })).not.toContain("</script>");
  });

  it("anchors glossary terms by their words", () => {
    expect(termAnchor("Business associate agreement (BAA)")).toBe("business-associate-agreement-baa");
  });
});
