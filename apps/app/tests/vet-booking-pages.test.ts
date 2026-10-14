import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ResolvedLink } from "@/lib/connections/links";
import type { ResolvedBookingRequest } from "@/lib/meta/booking-requests";

/**
 * Where a vet reads the animal's name and species: the desk page a request's
 * email points to, and the setup page where a practice chooses what the
 * assistant asks for. Both in the vet's words ("client", never "patient"),
 * and the animal fields offered to no practice whose patients are people.
 * Rendered to static markup with the resolvers mocked; the database-backed
 * half is tests/vet-booking-fields.test.ts.
 */

const mocks = vi.hoisted(() => ({
  request: null as ResolvedBookingRequest | null,
  link: null as ResolvedLink | null,
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  RedirectType: { replace: "replace", push: "push" },
}));
vi.mock("@/app/connect/[token]/request-context", () => ({
  connectRequestContext: async () => ({ ipAddress: null, userAgent: null }),
}));
vi.mock("@/lib/connections/attempt-limit", () => ({ withinConnectAttemptLimit: () => true }));
vi.mock("@/lib/meta/booking-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/booking-requests")>()),
  resolveBookingRequest: async () => mocks.request,
}));
vi.mock("@/lib/connections/links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connections/links")>()),
  resolveConnectionLink: async () => mocks.link,
}));

import BookingRequestPage from "@/app/booking/[token]/page";
import SetupPage from "@/app/setup/[token]/page";

const TOKEN = "T".repeat(43);

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&rsquo;/g, "’")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function request(overrides: Partial<ResolvedBookingRequest>): ResolvedBookingRequest {
  return {
    id: "req-1",
    clinicId: "clinic-1",
    clinicName: "Paws & Claws",
    audience: "clients",
    timeZone: "America/Los_Angeles",
    channel: "voice",
    platform: null,
    firstName: "Dana",
    phone: "+14155550192",
    preferredWindow: "Thursday afternoon",
    alternativeWindows: [],
    treatment: "Wellness exam",
    collectedFields: {},
    status: "requested",
    createdAt: new Date("2026-10-14T16:00:00Z"),
    decidedAt: null,
    decidedByLabel: null,
    deskNote: null,
    confirmedFor: null,
    proposedSlots: [],
    rescheduleExpiresAt: null,
    bookedVia: "desk",
    lastInboundAt: null,
    calendar: null,
    calendarWrite: null,
    heldFor: null,
    metaWindowOpen: null,
    amendmentCount: 0,
    ...overrides,
  };
}

async function deskPage(): Promise<string> {
  return text(
    renderToStaticMarkup(
      await BookingRequestPage({
        params: Promise.resolve({ token: TOKEN }),
        searchParams: Promise.resolve({}),
      }),
    ),
  );
}

function link(specialty: string): ResolvedLink {
  return {
    clinicId: "clinic-1",
    clinicName: "Paws & Claws",
    clinicSlug: "paws",
    platformId: "none",
    attributionMode: "estimated",
    specialty,
    purpose: "setup",
    linkId: "link-1",
    audience: "recipients",
    allowsAccountChange: false,
    pendingElection: null,
    sentTo: null,
  } as ResolvedLink;
}

async function setupPage(): Promise<string> {
  return text(renderToStaticMarkup(await SetupPage({ params: Promise.resolve({ token: TOKEN }) })));
}

describe("the desk page", () => {
  beforeEach(() => {
    mocks.request = null;
  });

  test("a vet's request names the animal and its species, under the vet's words", async () => {
    mocks.request = request({
      collectedFields: {
        animal_species: "small mammal",
        animal_name: "Biscuit",
        last_name: "Okafor",
      },
      amendmentCount: 1,
    });
    const page = await deskPage();
    expect(page).toContain("A client would like to book");
    expect(page).toMatch(
      /Collected by the assistant Last name Okafor Animal's name Biscuit Species Small mammal/,
    );
    expect(page).toContain("in the client’s export");
    expect(page).not.toMatch(/patient/i);
  });

  test("a species written as other keeps its word, capitalised", async () => {
    mocks.request = request({ collectedFields: { animal_species: "other: ferret" } });
    expect(await deskPage()).toContain("Species Other: ferret");
  });

  test("a practice whose patients are people reads 'patient', as before", async () => {
    mocks.request = request({ audience: "patients", collectedFields: { new_or_existing: "new" } });
    const page = await deskPage();
    expect(page).toContain("A patient would like to book");
    expect(page).toContain("New or returning patient new");
  });
});

describe("the setup page", () => {
  test("a vet is offered the animal's name and species, pre-selected, in its own words", async () => {
    mocks.link = link("veterinary");
    const page = await setupPage();
    expect(page).toContain("Animal's name");
    expect(page).toContain("Species");
    expect(page).toContain("New or returning client");
    expect(page).not.toContain("New or returning patient");
    const html = renderToStaticMarkup(
      await SetupPage({ params: Promise.resolve({ token: TOKEN }) }),
    );
    // Pre-selected: the vet's defaults include both.
    for (const id of ["animal_name", "animal_species"]) {
      const input = html.match(new RegExp(`<input[^>]*value="${id}"[^>]*>`))?.[0];
      expect(input, id).toBeDefined();
      expect(input, id).toMatch(/checked/);
    }
  });

  test("a practice whose patients are people is never offered them", async () => {
    mocks.link = link("med-spa");
    const html = renderToStaticMarkup(
      await SetupPage({ params: Promise.resolve({ token: TOKEN }) }),
    );
    expect(html).not.toMatch(/animal_name|animal_species|Animal&#x27;s name|Animal's name/);
    expect(text(html)).toContain("New or returning patient");
  });
});
