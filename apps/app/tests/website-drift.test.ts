import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  parseClinicProfile,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
  type ClinicProfile,
} from "@healdesk/catalog";
import { afterEach, describe, expect, test, vi } from "vitest";

import { assertPayloadAllowed, copyProblems } from "@/lib/email/lint";
import {
  renderWebsiteChanges,
  sectionCounts,
  WEBSITE_CHANGES_ENTRY,
} from "@/lib/email/templates/website_changes";
import { readClinicWebsite, webOrigin, WebOriginError } from "@/lib/website/client";
import {
  describeChange,
  diffProfiles,
  fingerprintOf,
  stillOpen,
  type KnowledgeView,
  type WebsiteChange,
} from "@/lib/website/diff";

/**
 * The signed website re-reads and the drift list, without a database (plan
 * Part B, "Re-reads"; Part F3, "Changes on your website"; Annex X5, L23):
 * the diff per Knowledge section, what Knowledge already says, the
 * fingerprint an ignore is remembered by, the words the list shows, the
 * signed call to apps/web and what each of its answers becomes, and L23,
 * which names a section and a count and never the service.
 */

const CLINIC_ID = "0c1d2e3f-0000-4000-8000-000000000000";
const SECRET = "test-provision-secret";

function profile(over: Partial<ClinicProfile> = {}): ClinicProfile {
  const p = parseClinicProfile({
    version: 1,
    website: "glowmedspa.com",
    readAt: "2026-09-01T12:00:00.000Z",
    pages: 3,
    locations: [
      {
        label: "Glow Med Spa",
        address: "12 Main St, Springfield, IL 62701",
        phone: "(415) 555-0100",
        hours: {
          sun: [],
          mon: [["09:00", "17:00"]],
          tue: [["09:00", "17:00"]],
          wed: [["09:00", "17:00"]],
          thu: [["09:00", "17:00"]],
          fri: [["09:00", "17:00"]],
          sat: [],
        },
      },
    ],
    services: [
      {
        name: "Signature facial",
        priceKind: "exact",
        priceUsd: 199,
        maxUsd: null,
        unit: null,
        durationMinutes: 60,
      },
      {
        name: "Express facial",
        priceKind: "from",
        priceUsd: 99,
        maxUsd: null,
        unit: null,
        durationMinutes: null,
      },
    ],
    providers: [{ name: "Ana Lee", title: "Lead aesthetician" }],
    policies: ["Cancel 24 hours ahead to keep your deposit."],
    faqs: [{ question: "Is there parking?", answer: "Yes, behind the building." }],
    acceptsInsurance: "unknown",
    practiceKind: "med-spa",
    dropped: 0,
  });
  if (!p) throw new Error("the fixture profile does not parse");
  return { ...p, ...over };
}

const BASE = profile();

function knowledgeOf(p: ClinicProfile, over: Partial<KnowledgeView> = {}): KnowledgeView {
  return {
    services: p.services.map((s) => ({
      name: s.name,
      priceKind: s.priceKind,
      priceFromUsd: s.priceUsd,
      priceToUsd: s.priceKind === "exact" ? s.priceUsd : s.maxUsd,
      unit: s.unit,
      durationMinutes: s.durationMinutes,
    })),
    policies: [...p.policies],
    quickAnswers: p.faqs.map((f) => ({ question: f.question, answer: f.answer })),
    providers: [],
    address: p.locations[0]?.address ?? null,
    phoneE164: "+14155550100",
    openingHours: p.locations[0]?.hours ?? null,
    ...over,
  } as KnowledgeView;
}

function kinds(changes: WebsiteChange[]): string[] {
  return changes.map((c) => `${c.section}:${c.kind}:${c.key}`).sort();
}

describe("the diff against the baseline", () => {
  test("the same website says nothing new", () => {
    expect(diffProfiles(BASE, profile(), { address: BASE.locations[0]!.address })).toEqual([]);
  });

  test("each section: what the website lists now, no longer lists, or states differently", () => {
    const next = profile({
      services: [
        { ...BASE.services[0]!, priceUsd: 219 },
        {
          name: "Brow shaping",
          priceKind: "exact",
          priceUsd: 45,
          maxUsd: null,
          unit: null,
          durationMinutes: 30,
        },
      ],
      providers: [{ name: "Maya Cho", title: null }],
      policies: ["Deposits are refundable up to 48 hours ahead."],
      faqs: [
        { question: "Is there parking?", answer: "Yes, free, behind the building." },
        { question: "Do you take walk-ins?", answer: "On weekday mornings." },
      ],
      locations: [
        {
          ...BASE.locations[0]!,
          phone: "(415) 555-0199",
          hours: { ...BASE.locations[0]!.hours!, sat: [["10:00", "14:00"]] },
        },
      ],
    });
    expect(kinds(diffProfiles(BASE, next, { address: BASE.locations[0]!.address }))).toEqual(
      [
        "hours:changed:weekly",
        "policies:added:deposits are refundable up to 48 hours ahead.",
        "policies:removed:cancel 24 hours ahead to keep your deposit.",
        "practice:changed:phone",
        "prices:added:brow shaping",
        "prices:changed:signature facial",
        "prices:removed:express facial",
        "providers:added:maya cho",
        "providers:removed:ana lee",
        "quick_answers:added:do you take walk-ins?",
        "quick_answers:changed:is there parking?",
      ].sort(),
    );
  });

  test("a website that stops giving its hours, its number or its address is not saying it has none", () => {
    const next = profile({
      locations: [{ label: "Glow Med Spa", address: null, phone: null, hours: null }],
    });
    expect(diffProfiles(BASE, next, { address: null })).toEqual([]);
  });

  test("the clinic's own location is compared: by address, then by label, never another location", () => {
    const other = {
      label: "Glow Med Spa Downtown",
      address: "400 Market St, Springfield, IL 62702",
      phone: "(415) 555-0300",
      hours: null,
    };
    // The website lists the other location first; the clinic's is matched by its address.
    const next = profile({ locations: [other, BASE.locations[0]!] });
    expect(diffProfiles(BASE, next, { address: BASE.locations[0]!.address })).toEqual([]);
    // Its address changed on the website: matched by the baseline location's label.
    const moved = profile({
      locations: [other, { ...BASE.locations[0]!, address: "14 Main St, Springfield, IL 62701" }],
    });
    expect(kinds(diffProfiles(BASE, moved, { address: BASE.locations[0]!.address }))).toEqual([
      "practice:changed:address",
    ]);
  });

  test("with no baseline, everything the website says is an addition", () => {
    const changes = diffProfiles(null, BASE, { address: null });
    expect(changes.every((c) => c.kind === "added" && c.before === null)).toBe(true);
    expect(changes.map((c) => c.section)).toEqual(
      expect.arrayContaining([
        "practice",
        "prices",
        "hours",
        "providers",
        "policies",
        "quick_answers",
      ]),
    );
  });
});

describe("what Knowledge already says", () => {
  const next = profile({
    services: [{ ...BASE.services[0]!, priceUsd: 219 }, BASE.services[1]!],
  });
  const [priceChange] = diffProfiles(BASE, next, { address: BASE.locations[0]!.address });

  test("a change Knowledge already has is not raised; one it does not have is", () => {
    expect(priceChange).toMatchObject({ section: "prices", kind: "changed" });
    expect(stillOpen(priceChange!, knowledgeOf(BASE))).toBe(true);
    expect(stillOpen(priceChange!, knowledgeOf(next))).toBe(false);
  });

  test("a removal is raised only while Knowledge still has the item", () => {
    const [removed] = diffProfiles(BASE, profile({ policies: [] }), { address: null });
    expect(removed).toMatchObject({ section: "policies", kind: "removed" });
    expect(stillOpen(removed!, knowledgeOf(BASE))).toBe(true);
    expect(stillOpen(removed!, knowledgeOf(BASE, { policies: [] }))).toBe(false);
  });

  test("providers are raised only for a practice that books by named provider", () => {
    const [added] = diffProfiles(
      BASE,
      profile({ providers: [...BASE.providers, { name: "Maya Cho", title: null }] }),
      { address: null },
    );
    expect(added).toMatchObject({ section: "providers", kind: "added", key: "maya cho" });
    expect(stillOpen(added!, knowledgeOf(BASE, { providers: [] }))).toBe(false);
    expect(stillOpen(added!, knowledgeOf(BASE, { providers: ["Ana Lee"] }))).toBe(true);
    expect(stillOpen(added!, knowledgeOf(BASE, { providers: ["Ana Lee", "Maya Cho"] }))).toBe(
      false,
    );
  });

  test("a main number AYA could not give is never raised", () => {
    const [phone] = diffProfiles(
      BASE,
      profile({ locations: [{ ...BASE.locations[0]!, phone: "call us" }] }),
      { address: BASE.locations[0]!.address },
    );
    expect(phone).toMatchObject({ section: "practice", key: "phone" });
    expect(stillOpen(phone!, knowledgeOf(BASE, { phoneE164: null }))).toBe(false);
  });
});

describe("the fingerprint an ignore is remembered by", () => {
  test("the same change found again is the same; what the website says now makes another", () => {
    const at = (price: number) =>
      diffProfiles(
        BASE,
        profile({ services: [{ ...BASE.services[0]!, priceUsd: price }, BASE.services[1]!] }),
        { address: null },
      )[0]!;
    expect(fingerprintOf(at(219))).toBe(fingerprintOf(at(219)));
    expect(fingerprintOf(at(219))).not.toBe(fingerprintOf(at(229)));
    expect(fingerprintOf(at(219))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the list's words", () => {
  test("each kind in a sentence: the clinic's own services, prices and questions", () => {
    const next = profile({
      services: [{ ...BASE.services[0]!, priceUsd: 219 }],
      faqs: [{ question: "Do you take walk-ins?", answer: "On weekday mornings." }],
      policies: [],
    });
    const words = diffProfiles(BASE, next, { address: null }).map(describeChange);
    expect(words).toEqual(
      expect.arrayContaining([
        {
          text: "On your website: Signature facial, $219, 60 minutes.",
          detail: "Before: $199, 60 minutes.",
        },
        { text: "Express facial is no longer on your website.", detail: null },
        {
          text: "A policy is no longer on your website.",
          detail: "Cancel 24 hours ahead to keep your deposit.",
        },
        { text: 'Your website answers "Do you take walk-ins?"', detail: "On weekday mornings." },
        { text: 'Your website no longer answers "Is there parking?"', detail: null },
      ]),
    );
  });

  test("hours read Monday first, with the closed days named", () => {
    const [hours] = diffProfiles(
      BASE,
      profile({
        locations: [
          {
            ...BASE.locations[0]!,
            hours: { ...BASE.locations[0]!.hours!, sat: [["10:00", "14:00"]] },
          },
        ],
      }),
      { address: BASE.locations[0]!.address },
    );
    expect(describeChange(hours!)).toEqual({
      text: "Your website's opening hours are different.",
      detail:
        "Mon 09:00–17:00 · Tue 09:00–17:00 · Wed 09:00–17:00 · Thu 09:00–17:00 · Fri 09:00–17:00 · Sat 10:00–14:00 · Sun closed",
    });
  });
});

describe("the signed call to apps/web", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  type Call = { url: string; init: RequestInit };

  function answering(response: () => Response): { fetch: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return response();
    }) as typeof fetch;
    return { fetch: fetchFn, calls };
  }

  const deps = (fetchFn: typeof fetch) => ({
    fetch: fetchFn,
    origin: "https://healdesk.test",
    secret: SECRET,
  });

  test("sends the clinic's id and website, signed, and takes back a profile of that website", async () => {
    const { fetch: f, calls } = answering(() =>
      Response.json({ status: "read", profile: BASE, summary: { services: 2 } }),
    );
    const outcome = await readClinicWebsite(
      { clinicId: CLINIC_ID, website: "glowmedspa.com" },
      deps(f),
    );
    expect(outcome).toEqual({ status: "read", profile: BASE });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://healdesk.test/api/clinic-site");
    const body = String(calls[0]!.init.body);
    expect(JSON.parse(body)).toEqual({ clinicId: CLINIC_ID, website: "glowmedspa.com" });
    const headers = calls[0]!.init.headers as Record<string, string>;
    // apps/web's own check passes it: the same signing, the same secret.
    expect(verify(body, headers[TIMESTAMP_HEADER]!, headers[SIGNATURE_HEADER]!, SECRET)).toEqual({
      ok: true,
    });
    expect(
      verify(body, headers[TIMESTAMP_HEADER]!, headers[SIGNATURE_HEADER]!, "another"),
    ).toMatchObject({ ok: false });
  });

  test("a profile of another website, or one that does not parse, is not this clinic's", async () => {
    for (const answer of [
      { status: "read", profile: { ...BASE, website: "elsewhere.com" } },
      { status: "read", profile: { ...BASE, extra: "field" } },
      { status: "maybe" },
    ]) {
      const { fetch: f } = answering(() => Response.json(answer));
      expect(
        await readClinicWebsite({ clinicId: CLINIC_ID, website: "glowmedspa.com" }, deps(f)),
      ).toEqual({
        status: "failed",
        failure: "invalid",
      });
    }
  });

  test("each answer that is not a profile becomes a category, never apps/web's words", async () => {
    const cases: [() => Response, unknown][] = [
      [() => Response.json({ status: "failed" }), { status: "failed", failure: "unreadable" }],
      [
        () =>
          Response.json({ status: "failed" }, { status: 429, headers: { "Retry-After": "3600" } }),
        { status: "failed", failure: "rate_limited", retryAfterSeconds: 3600 },
      ],
      [
        () => Response.json({ error: "Unauthorized." }, { status: 401 }),
        { status: "failed", failure: "refused" },
      ],
      [
        () => Response.json({ error: "x" }, { status: 422 }),
        { status: "failed", failure: "refused" },
      ],
      [
        () => Response.json({ status: "failed" }, { status: 503 }),
        { status: "failed", failure: "unavailable" },
      ],
      [() => new Response("<html>", { status: 200 }), { status: "failed", failure: "invalid" }],
    ];
    for (const [response, expected] of cases) {
      const { fetch: f } = answering(response);
      expect(
        await readClinicWebsite({ clinicId: CLINIC_ID, website: "glowmedspa.com" }, deps(f)),
      ).toEqual(expected);
    }
    const thrown = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(
      await readClinicWebsite({ clinicId: CLINIC_ID, website: "glowmedspa.com" }, deps(thrown)),
    ).toEqual({
      status: "failed",
      failure: "network",
    });
  });

  test("HEALDESK_WEB_URL: unset reads nothing; set, a bare origin, and https in production", async () => {
    vi.stubEnv("HEALDESK_WEB_URL", "");
    expect(webOrigin()).toBeNull();
    const { fetch: f, calls } = answering(() => Response.json({ status: "failed" }));
    expect(
      await readClinicWebsite(
        { clinicId: CLINIC_ID, website: "glowmedspa.com" },
        { fetch: f, secret: SECRET },
      ),
    ).toEqual({ status: "failed", failure: "unavailable" });
    expect(calls).toEqual([]);

    expect(webOrigin("https://healdesk.io")).toBe("https://healdesk.io");
    expect(webOrigin("https://healdesk.io/")).toBe("https://healdesk.io");
    expect(webOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const bad of [
      "healdesk.io",
      "ftp://healdesk.io",
      "https://healdesk.io/api",
      "https://u:p@healdesk.io",
    ]) {
      expect(() => webOrigin(bad), bad).toThrow(WebOriginError);
    }
    vi.stubEnv("NODE_ENV", "production");
    expect(() => webOrigin("http://healdesk.io")).toThrow(/https in production/);
  });
});

describe("L23, Changes on your website", () => {
  test("names each section and a count, never the service", () => {
    expect(
      sectionCounts([
        { section: "prices", count: 2 },
        { section: "hours", count: 1 },
        { section: "quick_answers", count: 1 },
      ]),
    ).toBe("2 in Prices, 1 in Hours and 1 in Quick answers");
    const email = renderWebsiteChanges(WEBSITE_CHANGES_ENTRY.fixture, {
      clinicName: "Glow Med Spa",
      audience: "patients",
      reason: "You get this because Glow Med Spa uses healdesk.",
      raisedAt: new Date("2026-10-19T12:00:00Z"),
      timeZone: "America/New_York",
    });
    expect(email.subject).toBe("Changes on your website");
    expect(email.text).toContain(
      "3 changes that AYA doesn't know yet: 2 in Prices and 1 in Hours.",
    );
    expect(email.text).not.toMatch(/facial|\$\d/i);
    expect(copyProblems(email.text)).toEqual([]);
  });

  test("its payload is the allowlist's: sections, counts and our own link, nothing else", () => {
    expect(() =>
      assertPayloadAllowed(WEBSITE_CHANGES_ENTRY.fixture, "website_changes"),
    ).not.toThrow();
    expect(() =>
      assertPayloadAllowed(
        {
          ...WEBSITE_CHANGES_ENTRY.fixture,
          sectionRows: [{ section: "prices", count: 1, name: "Signature facial" }],
        },
        "website_changes",
      ),
    ).toThrow(/sectionRows\[0\]\.name/);
  });

  test("refuses to send with nothing to name", () => {
    expect(() =>
      renderWebsiteChanges(
        { sectionRows: [], count: 0, reviewUrl: WEBSITE_CHANGES_ENTRY.fixture.reviewUrl },
        {
          clinicName: "Glow Med Spa",
          audience: "patients",
          reason: "x",
          raisedAt: new Date(),
          timeZone: "America/New_York",
        },
      ),
    ).toThrow(/at least one change/);
  });
});

describe("the jobs, as a fresh deployment gets them", () => {
  // truncateAll re-seeds every job off for the tests; the migration's own
  // rows are what a deployment gets.
  const seeds = () => {
    const dir = fileURLToPath(new URL("../drizzle/", import.meta.url));
    return readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readFileSync(`${dir}${name}`, "utf8"));
  };
  const row = (name: string) => new RegExp(`\\('${name}', '((?:[^']|'')+)', (true|false)\\)`);

  test("the reads a clinic's own setup asks for run once HEALDESK_WEB_URL is set", () => {
    const found = seeds().flatMap((text) => text.match(row("site-reads")) ?? []);
    expect(found[2]).toBe("true");
  });

  test("the monthly drift check ships off, naming the owner who switches it on and when", () => {
    const found = seeds().flatMap((text) => text.match(row("website-drift")) ?? []);
    expect(found[2]).toBe("false");
    expect(found[1]).toMatch(
      /until the owner switches it on, before the first clinic''s 30th live day/,
    );
  });
});
