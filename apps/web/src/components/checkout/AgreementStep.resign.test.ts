// @vitest-environment happy-dom
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AGREEMENT_KEY, storeAgreement } from "@/lib/agreement-recovery";
import {
  agreementInputs,
  FUNNEL_KEY,
  type FunnelState,
  initialFunnel,
} from "@/lib/checkout/funnel";

import { type AgreementResult, AgreementStep } from "./AgreementStep";
import { CheckoutFlow } from "./CheckoutFlow";

/**
 * "Sign again with different answers", run in a DOM (the one checkout test
 * that needs one: the rest read static markup).
 *
 * The step can open on the signed view, which has no end-of-document marker.
 * Pressing "Sign again" draws the document, with its marker, and the
 * read-to-end observer has to attach to that marker then, or the signature
 * section stays inert for good: the old signature already cleared, the new
 * one impossible, and no way to reach Review and pay. So: signed view, Sign
 * again, the marker scrolled into view, the box ticked, and Sign is enabled.
 * And the way into that view from Review and pay: a purchase apps/app refuses
 * for its agreement sends the buyer back to sign again.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** IntersectionObserver as the read-to-end check uses it, with a way to scroll a target into view. */
class FakeObserver {
  static live = new Set<FakeObserver>();
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeObserver.live.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    FakeObserver.live.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** Tell every observer watching `target` that it is now on screen. */
  static scrollIntoView(target: Element) {
    for (const observer of [...FakeObserver.live]) {
      if (!observer.targets.has(target)) continue;
      const entry = { target, isIntersecting: true } as unknown as IntersectionObserverEntry;
      observer.callback([entry], observer as unknown as IntersectionObserver);
    }
  }
}

const SIGNED: AgreementResult = {
  agreementId: "6f1b0c9e-8f2a-4d31-9c77-1a2b3c4d5e6f",
  version: "1.2.1",
  hash: "a".repeat(64),
  text: "HEALDESK BUSINESS ASSOCIATE AGREEMENT\n\n1. Definitions...",
  acceptedAt: "2026-10-06T10:00:00.000Z",
  approvedByCounsel: true,
};

/** A clinic at step 3 with every answer given, as the funnel stores it. */
const ANSWERED: FunnelState = {
  ...initialFunnel({ plan: "voice" }),
  step: 3,
  clinicName: "Glow Med Spa LLC",
  website: "glowmedspa.com",
  specialty: "med-spa",
  bookingSystem: "google_calendar",
  calendarAccount: "workspace_baa",
  covered: "no",
  contactName: "Laura Owner",
  contactTitle: "Owner",
  contactEmail: "info@glowmedspa.com",
};

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  FakeObserver.live.clear();
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  // The funnel's analytics mirror posts its step; nothing here may leave the test.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );
  if (!found) throw new Error(`no button "${label}" in: ${container.textContent}`);
  return found;
}

/** The step on its own, hosted the way the flow hosts it, with the covered answer in the host's state. */
function StepHost({
  initialSigned,
  onAnswer,
}: {
  initialSigned: AgreementResult | null;
  onAnswer?: (set: (covered: FunnelState["covered"]) => void) => void;
}) {
  const [signed, setSigned] = useState<AgreementResult | null>(initialSigned);
  const [covered, setCovered] = useState<FunnelState["covered"]>(ANSWERED.covered);
  onAnswer?.(setCovered);
  return h(AgreementStep, {
    step: 3,
    totalSteps: 4,
    onBack: () => undefined,
    clinicName: ANSWERED.clinicName,
    specialty: ANSWERED.specialty!,
    bookingSystem: ANSWERED.bookingSystem!,
    calendarAccount: ANSWERED.calendarAccount!,
    covered,
    onCovered: setCovered,
    contactName: ANSWERED.contactName,
    contactTitle: ANSWERED.contactTitle,
    contactEmail: ANSWERED.contactEmail,
    onContact: () => undefined,
    signed,
    onSigned: () => undefined,
    onContinue: () => undefined,
    onResign: () => setSigned(null),
  });
}

/** Signed view, Sign again, the end of the document scrolled to, the box ticked. */
async function signAgainAndRead(): Promise<HTMLButtonElement> {
  expect(container.textContent).toContain("Sign again with different answers");
  expect(container.querySelector("[data-agreement-end]")).toBeNull();

  await act(async () => button("Sign again with different answers").click());

  const marker = container.querySelector("[data-agreement-end]");
  expect(marker).not.toBeNull();
  const sign = button("Sign and continue");
  expect(sign.disabled).toBe(true);
  expect(container.querySelector("section[inert]")).not.toBeNull();

  await act(async () => FakeObserver.scrollIntoView(marker!));
  expect(container.textContent).toContain("You've read to the end.");
  expect(container.querySelector("section[inert]")).toBeNull();

  const tick = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(tick.checked).toBe(false);
  await act(async () => tick.click());
  return sign;
}

describe('"Sign again with different answers"', () => {
  test("in the purchase: the document can be read and signed again", async () => {
    sessionStorage.setItem(FUNNEL_KEY, JSON.stringify(ANSWERED));
    storeAgreement(SIGNED, agreementInputs(ANSWERED)!);

    await act(async () => root.render(h(CheckoutFlow, {})));
    const sign = await signAgainAndRead();
    expect(sign.disabled).toBe(false);
  });

  test("in the step itself, redrawn by its host rather than replaced: the marker still attaches", async () => {
    // The flow re-keys the step on a re-sign; the step must not depend on it.
    function Host() {
      const [signed, setSigned] = useState<AgreementResult | null>(SIGNED);
      return h(AgreementStep, {
        step: 3,
        totalSteps: 4,
        onBack: () => undefined,
        clinicName: ANSWERED.clinicName,
        specialty: ANSWERED.specialty!,
        bookingSystem: ANSWERED.bookingSystem!,
        calendarAccount: ANSWERED.calendarAccount!,
        covered: ANSWERED.covered,
        onCovered: () => undefined,
        contactName: ANSWERED.contactName,
        contactTitle: ANSWERED.contactTitle,
        contactEmail: ANSWERED.contactEmail,
        onContact: () => undefined,
        signed,
        onSigned: () => undefined,
        onContinue: () => undefined,
        onResign: () => setSigned(null),
      });
    }

    await act(async () => root.render(h(Host)));
    const sign = await signAgainAndRead();
    expect(sign.disabled).toBe(false);
  });

  test("a browser with no IntersectionObserver is let through once the document is drawn", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    await act(async () => root.render(h(StepHost, { initialSigned: null })));

    expect(container.querySelector("[data-agreement-end]")).not.toBeNull();
    expect(container.textContent).toContain("You've read to the end.");
    expect(container.querySelector("section[inert]")).toBeNull();
  });

  test("another answer is another document: read-to-end and the tick both reset", async () => {
    let answer: (covered: FunnelState["covered"]) => void = () => undefined;
    await act(async () =>
      root.render(h(StepHost, { initialSigned: null, onAnswer: (set) => (answer = set) })),
    );

    await act(async () =>
      FakeObserver.scrollIntoView(container.querySelector("[data-agreement-end]")!),
    );
    const tick = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => tick.click());
    expect(tick.checked).toBe(true);

    await act(async () => answer("yes"));
    expect(container.textContent).toContain("Read to the end of the agreement to sign it.");
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(
      false,
    );
    expect(container.querySelector("section[inert]")).not.toBeNull();
    expect(button("Sign and continue").disabled).toBe(true);
  });

  test("a purchase apps/app refuses for its agreement goes back to step 3, to sign again", async () => {
    // apps/app refuses, under `agreementId`, an agreement that is not the
    // document the purchase describes (checkIntentAgreement).
    const reason = "The agreement you signed names a different practice. Please sign it again.";
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) =>
      String(url).endsWith("/api/checkout")
        ? Response.json({ error: reason, field: "agreementId" }, { status: 422 })
        : new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    sessionStorage.setItem(FUNNEL_KEY, JSON.stringify({ ...ANSWERED, step: 4 }));
    storeAgreement(SIGNED, agreementInputs(ANSWERED)!);

    await act(async () => root.render(h(CheckoutFlow, {})));
    const terms = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => terms.click());
    await act(async () => {
      button("Pay $").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The purchase carried the covered-entity answer apps/app matched.
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/checkout"))!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      agreementId: SIGNED.agreementId,
      covered: "no",
    });
    // Step 3, the reason at its top, the signature set aside and the
    // document drawn to be read and signed again.
    expect(container.textContent).toContain("Your agreement");
    expect(container.textContent).toContain(reason);
    expect(container.textContent).not.toContain("Sign again with different answers");
    expect(container.querySelector("[data-agreement-end]")).not.toBeNull();
    expect(sessionStorage.getItem(AGREEMENT_KEY)).toBeNull();
  });
});
