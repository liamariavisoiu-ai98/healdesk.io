import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { demoEmail } from "@/lib/demo/build";
import type { DemoSession } from "@/lib/demo/sessions";

/**
 * A veterinary practice's demo, in its own words: its callers are clients
 * (a vet's patients are animals), and the agreement it would sign is the Data
 * Protection Agreement, never a business associate agreement. Vets can be
 * sent a demo today, before they can buy; the page and its email are the
 * first things they read. Rendered to static markup with the session read
 * stood in for, and a demo for a practice whose patients are people beside it,
 * which still says "patient" and the BAA where it did.
 */

const sessions = vi.hoisted(() => ({ current: null as DemoSession | null }));
vi.mock("@/lib/demo/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo/sessions")>();
  return { ...actual, getDemoSession: async () => sessions.current, readDemoSession: async () => ({ session: sessions.current, unavailable: false }) };
});

// The page's timers and buttons are client components; static markup has no router.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => "/demo",
  useSearchParams: () => new URLSearchParams(),
}));

// Next's font loader runs at build time; under test the font is a class name.
vi.mock("next/font/google", () => ({ Lora: () => ({ variable: "hd-lora" }) }));

const { default: DemoPage } = await import("./page");
const { LegacyDemoReady } = await import("@/components/demo/LegacyDemoReady");

function session(specialty: "veterinary" | "med-spa", name: string, slug: string): DemoSession {
  return {
    id: "demo-1",
    slug,
    status: "ready",
    leadEmail: "owner@example.test",
    clinicName: name,
    websiteUrl: "https://example.test",
    phoneE164: null,
    niche: specialty,
    specialty,
    brandName: null,
    logoUrl: null,
    brandColor: null,
    profile: {
      clinic_name: name,
      summary: "A practice.",
      specialty,
      phone: "(512) 555-0100",
      address: "1 Congress Ave, Austin, TX",
      hours: [{ days: "Mon–Fri", hours: "8am–5pm" }],
      services: [{ name: "Wellness exam", description: "", price: "$65", duration: "30 min" }],
      providers: [],
      faqs: [],
      policies: [],
      booking: "",
      highlights: [],
    },
    scrapeSource: "website",
    buildNote: null,
    createdBy: "ops@healdesk.io",
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
  } as unknown as DemoSession;
}

function words(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;|&#39;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The page's markup, and the voice card's ring note, which shows only once a call is asked for. */
async function page(demo: DemoSession): Promise<{ said: string; ringNote: string }> {
  sessions.current = demo;
  const element = (await DemoPage({ params: Promise.resolve({ slug: demo.slug }) })) as ReactElement;
  // A vet's demo is the page it had, one component down (components/demo/LegacyDemoReady.tsx).
  const built = element.type === LegacyDemoReady ? LegacyDemoReady(element.props as Parameters<typeof LegacyDemoReady>[0]) : element;
  return { said: words(renderToStaticMarkup(element)), ringNote: propOf(built, "ringNote") ?? "" };
}

/** The first `name` prop anywhere in the elements the page itself built. */
function propOf(node: unknown, name: string): string | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propOf(child, name);
      if (found !== null) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const props = (node as { props: Record<string, unknown> }).props;
  if (typeof props[name] === "string") return props[name] as string;
  for (const value of Object.values(props)) {
    const found = propOf(value, name);
    if (found !== null) return found;
  }
  return null;
}

describe("a demo in its practice's own words", () => {
  beforeEach(() => {
    sessions.current = null;
  });

  // The old close, which these were written against; the redesign is tested below.
  beforeEach(() => {
    process.env.DEMO_CLOSE_SPLIT = "control";
  });
  afterEach(() => {
    delete process.env.DEMO_CLOSE_SPLIT;
  });

  test("a vet's demo page says clients, and the data protection agreement, never patients or a BAA", async () => {
    const { said, ringNote } = await page(session("veterinary", "Paws & Claws", "paws-claws-k7q2mz9xwa"));
    expect(said).toContain("Try her the way a client would.");
    expect(said).toContain("We sign a data protection agreement and handle your clients' information under it");
    expect(said).toContain("With a client or on another line, the call still gets answered.");
    expect(said).toContain("Ask me anything a client would");
    expect(said).toContain("please don't share real client details");
    expect(said).not.toMatch(/\bpatients?\b/i);
    expect(said).not.toMatch(/\bBAA\b|business associate/i);
    expect(ringNote).toBe("One demo call, because you asked. Live, it only answers: it never dials a client.");
  });

  test("a demo for a practice whose patients are people is the owner's page (lib/demo/v2), in its own name", async () => {
    const { said, ringNote } = await page(session("med-spa", "Glow Med Spa", "glow-med-spa-k7q2mz9xwa"));
    expect(said).toContain("Glow Med Spa, answering every call and chat.");
    expect(said).toContain("We sign a Business Associate Agreement with every plan.");
    expect(said).toContain("Try her now. Call or message Aya like a patient would.");
    expect(said).toContain("What are missed calls costing Glow?");
    expect(said).not.toMatch(/Lumen/i);
    // One way to talk on the owner's page, "Call Aya" in the browser (components/demo/PhoneCallCard.tsx): nothing rings a phone.
    expect(ringNote).toBe("");
  });

  test("the redesigned close says clients and the data protection agreement for a vet, never patients or a BAA", async () => {
    process.env.DEMO_CLOSE_SPLIT = "close";
    const { said, ringNote } = await page(session("veterinary", "Paws & Claws", "paws-claws-k7q2mz9xwa"));
    expect(said).toContain("message her the way a client would.");
    expect(said).toContain("We sign a data protection agreement and handle your clients' information under it");
    expect(said).toContain("Ask me anything a client would");
    expect(said).toContain("Will clients mind it's AI?");
    expect(said).toContain("New client");
    expect(said).not.toMatch(/\bpatients?\b/i);
    expect(said).not.toMatch(/\bBAA\b|business associate/i);
    expect(ringNote).toBe("One demo call, because you asked. Live, it only answers: it never dials a client.");
  });

  test("both closes of a demo for people are the owner's page", async () => {
    process.env.DEMO_CLOSE_SPLIT = "close";
    const { said } = await page(session("med-spa", "Glow Med Spa", "glow-med-spa-k7q2mz9xwa"));
    expect(said).toContain("Glow Med Spa, answering every call and chat.");
    expect(said).not.toContain("Activate my AYA");
  });

  test("a vet's demo email says client, and its footer asks to leave out the clients' details", () => {
    const vet = session("veterinary", "Paws & Claws", "paws-claws-k7q2mz9xwa");
    const { text, html } = demoEmail(vet, Date.now(), { unsubscribeUrl: "https://healdesk.io/api/email/unsubscribe?t=x" });
    expect(text).toContain("Replies reach our team. Please don't include client details.");
    expect(text).not.toMatch(/\bpatients?\b/i);
    expect(html).toContain("Ask her what your clients ask");
    expect(html).not.toMatch(/\bpatients?\b/i);
  });
});
