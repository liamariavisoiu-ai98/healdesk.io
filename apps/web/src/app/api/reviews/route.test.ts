import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { __resetRateLimiterForTests } from "@/lib/rate-limit";

import { POST } from "./route";

/**
 * A review reaches a person through the site's one sender (Annex X3): the
 * customer ID is checked with apps/app, then the review goes to hello@ with
 * the app and kind tags, an idempotency key and the portrait attached.
 * apps/app and Resend are stubbed.
 */

type Sent = {
  to: string[];
  subject: string;
  text: string;
  tags: { name: string; value: string }[];
  attachments?: { filename: string; content: string }[];
};

let sent: { body: Sent; key: string | null }[];
let ip = 0;

/** A 1x1 JPEG's first bytes are enough: the route checks the magic number. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);

beforeEach(() => {
  sent = [];
  __resetRateLimiterForTests();
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <noreply@healdesk.io>");
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-secret");
  vi.stubEnv("HEALDESK_APP_URL", "http://app.internal.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href === "http://app.internal.test/api/reviews/verify") {
        return Response.json({ clinic: { name: "Glow Med Spa", specialty: "med-spa" } });
      }
      if (href.startsWith("https://api.resend.com/")) {
        sent.push({
          body: JSON.parse(String(init?.body)) as Sent,
          key: new Headers(init?.headers).get("Idempotency-Key"),
        });
        return Response.json({ id: "re_1" });
      }
      throw new Error(`unexpected fetch ${href}`);
    }),
  );
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const REVIEW = {
  name: "Laura Owner",
  customerId: "cus_glow",
  rating: 5,
  title: "Just excellent",
  jobTitle: "Owner",
  city: "Austin",
  state: "TX",
  body: "Every call answered.",
};

function post(body: Record<string, unknown>): Promise<Response> {
  ip += 1;
  return POST(
    new Request("http://localhost/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `10.5.0.${ip}` },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/reviews", () => {
  test("sends the review to hello@ through send(), with its kind, a key and the portrait", async () => {
    const response = await post({
      ...REVIEW,
      photo: `data:image/jpeg;base64,${JPEG.toString("base64")}`,
    });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    const [review] = sent;
    expect(review!.body.to).toEqual(["hello@healdesk.io"]);
    expect(review!.body.subject).toBe("Review (5/5), Glow Med Spa");
    expect(review!.body.tags).toEqual([
      { name: "app", value: "web" },
      { name: "kind", value: "review" },
    ]);
    expect(review!.key).toMatch(/^hd-review-[0-9a-f]{32}-1$/);
    expect(review!.body.attachments).toEqual([
      { filename: "portrait.jpg", content: JPEG.toString("base64") },
    ]);
  });

  test("the same review twice carries the same key; another review another", async () => {
    await post(REVIEW);
    await post(REVIEW);
    await post({ ...REVIEW, rating: 4 });
    expect(sent[1]!.key).toBe(sent[0]!.key);
    expect(sent[2]!.key).not.toBe(sent[0]!.key);
    expect(sent[0]!.body.attachments).toBeUndefined();
  });

  test("without a transport it says the form is down, and sends nothing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const response = await post(REVIEW);
    expect(response.status).toBe(503);
    expect(sent).toHaveLength(0);
  });
});
