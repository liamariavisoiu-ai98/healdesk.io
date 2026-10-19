import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { BookingRequestView } from "@/lib/meta/booking-requests";
import type { BookingsScreen } from "@/lib/portal/bookings";

/**
 * Where a vet reads the animal's name and species: the request on Bookings,
 * which the desk's emailed link points to, in the vet's words ("client",
 * never "patient"). The setup page where a practice once chose what the
 * assistant asks for was retired with the setup wizard (plan C2); which
 * fields a practice may be asked for is now the specialty's. Rendered to static markup with the step-up and
 * the readers mocked; the database-backed half is
 * tests/vet-booking-fields.test.ts, and Bookings behind a real step-up is
 * tests/bookings-screen.test.ts.
 */

const PAGE = {
  portal: { userId: "usr-1", clinicId: "clinic-1", clinicSlug: "paws" },
  stepUp: { passkeyId: "pk-1", stepUpId: "su-1", deviceLabel: "Front desk Mac" },
  request: { requestId: "render-1" },
};

const mocks = vi.hoisted(() => ({
  screen: null as BookingsScreen | null,
  audience: "clients" as "clients" | "patients",
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  RedirectType: { replace: "replace", push: "push" },
  // The shell's Help carries the support chat (WP10), which reads the slug
  // from the route; static markup has no router.
  useParams: () => null,
}));
vi.mock("@/app/connect/[token]/request-context", () => ({
  connectRequestContext: async () => ({ ipAddress: null, userAgent: null }),
}));
vi.mock("@/lib/connections/attempt-limit", () => ({ withinConnectAttemptLimit: () => true }));
// The guard shows nothing until the browser has asked the server
// (PatientPageGuard); static markup has no browser, so it stands in as a
// wrapper that says which step-up and render it was given.
vi.mock("@/app/c/[slug]/PatientPageGuard", async () => {
  const { createElement } = await import("react");
  return {
    PatientPageGuard: (props: {
      slug: string;
      stepUpId: string;
      renderId: string;
      children: unknown;
    }) =>
      createElement(
        "div",
        { "data-guard": props.slug, "data-step-up": props.stepUpId, "data-render": props.renderId },
        props.children as never,
      ),
  };
});
vi.mock("@/lib/portal/patient-page", () => ({
  requirePatientPage: async () => PAGE,
  withPatientPage: async (_page: unknown, read: (tx: unknown) => Promise<unknown>) => read({}),
  patientGuardProps: () => ({ slug: "paws", stepUpId: "su-1", renderId: "render-1" }),
}));
vi.mock("@/lib/portal/page", () => ({
  loadPortalPage: async () => ({ state: { clinic: { offboardingStartedAt: null } } }),
  shellProps: () => ({
    slug: "paws",
    clinicName: "Paws & Claws",
    section: "bookings",
    audience: mocks.audience,
    status: { kind: "answering" },
    timeZone: "America/Los_Angeles",
    locations: [],
    opened: ["bookings"],
  }),
}));
vi.mock("@/lib/portal/bookings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/bookings")>()),
  readBookingsScreen: async () => mocks.screen,
  withFreeTimes: async (_page: unknown, screen: unknown) => screen,
}));

import BookingsPage from "@/app/c/[slug]/bookings/page";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&rsquo;/g, "’")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function request(overrides: Partial<BookingRequestView>): BookingRequestView {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    clinicId: "clinic-1",
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
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    decidedAt: null,
    decidedByLabel: null,
    deskNote: null,
    confirmedFor: null,
    appointmentId: null,
    proposedSlots: [],
    rescheduleExpiresAt: null,
    bookedVia: "desk",
    lastInboundAt: null,
    lapsed: false,
    calendar: null,
    calendarWrite: null,
    heldFor: null,
    metaWindowOpen: null,
    amendments: [],
    ...overrides,
  };
}

async function bookingsPage(view: BookingRequestView): Promise<string> {
  mocks.audience = view.audience;
  mocks.screen = {
    timeZone: view.timeZone,
    open: [view],
    deposits: [],
    missed: [],
    booked: [],
    focus: null,
    writableCalendar: false,
  };
  return text(
    renderToStaticMarkup(
      await BookingsPage({
        params: Promise.resolve({ slug: "paws" }),
        searchParams: Promise.resolve({}),
      }),
    ),
  );
}

describe("a request on Bookings", () => {
  beforeEach(() => {
    mocks.screen = null;
  });

  test("a vet's request names the animal and its species, under the vet's words", async () => {
    const page = await bookingsPage(
      request({
        collectedFields: {
          animal_species: "small mammal",
          animal_name: "Biscuit",
          last_name: "Okafor",
        },
        amendments: [
          { text: "Biscuit is a guinea pig.", requestedAt: new Date("2026-10-14T17:00:00Z") },
        ],
      }),
    );
    expect(page).toContain("Dana would like to book");
    expect(page).toMatch(/Last name Okafor Animal's name Biscuit Species Small mammal/);
    expect(page).toContain("Amended at your practice’s direction Biscuit is a guinea pig.");
    expect(page).not.toMatch(/patient/i);
  });

  test("a species written as other keeps its word, capitalised", async () => {
    expect(
      await bookingsPage(request({ collectedFields: { animal_species: "other: ferret" } })),
    ).toContain("Species Other: ferret");
  });

  test("a practice whose patients are people reads 'patient', as before", async () => {
    const page = await bookingsPage(
      request({ audience: "patients", collectedFields: { new_or_existing: "new" } }),
    );
    expect(page).toContain("New or returning patient new");
  });
});

