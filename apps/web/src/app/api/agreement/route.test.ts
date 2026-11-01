import { createHash } from "node:crypto";

import type { CoveredAnswer } from "@healdesk/catalog";
import { effectiveDateOf, prepareSigning } from "@healdesk/catalog/agreement-signing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DOWNLOAD_COOKIE } from "@/lib/agreement-download";
import { findAgreementRecord } from "@/lib/checkout/records";
import { mailboxOf, UNCONFIRMED_COPIES_PER_DAY } from "@/lib/email/agreement-copy";
import { __resetRateLimiterForTests, takeRateLimit } from "@/lib/rate-limit";
import { signatureRequestFor } from "@/lib/checkout/records.testing";
import { issueSetupToken, setupLinkExpiry } from "@/lib/setup-link";
import { createSetupRequest, findSetupRequest, updateSetupRequest } from "@/lib/setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import { POST } from "./route";

/**
 * POST /api/agreement signs here, since 14 October 2026: the catalog's own
 * validation and rendering, a sealed record in the marketing Sheet, and the
 * signer's PDF copy through this site's Resend sender, so a buyer can sign
 * while the AWS host is in standby. apps/app is never called
 * (docs/design/checkout-records-on-vercel-2026-10-14.md).
 *
 * While the purchase is by setup link the signature is gated exactly like the
 * payment: no link, no signature, and only under the address the link was
 * sent to. A refused signature never becomes a record.
 */

const SECRET = "test-secret";

/** Resend, as the copy sees it; anything else fetched is a call that must not happen. */
const resend = vi.fn(async (url: URL | RequestInfo, _init?: RequestInit): Promise<Response> => {
  if (String(url) === "https://api.resend.com/emails") return Response.json({ id: "email_1" });
  return new Response("not here", { status: 599 });
});

let sheets: FakeSheets;
let counter = 0;

beforeEach(() => {
  vi.stubEnv("HEALDESK_PROVISION_SECRET", SECRET);
  vi.stubEnv("HEALDESK_APP_URL", "http://app.test");
  vi.stubEnv("HEALDESK_CHECKOUT_MODE", "");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <hello@healdesk.io>");
  vi.stubGlobal("fetch", resend);
  resend.mockClear();
  sheets = new FakeSheets();
  __setSheetsClientForTests(sheets);
  __resetSheetSchemaForTests();
  __resetRateLimiterForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

/**
 * What the agreement step sends for a med spa that answered "Yes", whose
 * bookings are in Mindbody: the business associate agreement. A "No", or a
 * veterinary practice, signs the Data Protection Agreement since its release
 * (20 October 2026), which `practice` asks for.
 */
function signature(
  signatoryEmail: string,
  overrides: Record<string, unknown> = {},
  practice: { specialty: string; covered: CoveredAnswer | null } = { specialty: "med-spa", covered: "yes" },
): Record<string, unknown> {
  const request = signatureRequestFor({
    clinicName: "Radiance Med Spa LLC",
    specialty: practice.specialty,
    covered: practice.covered,
    bookingSystem: "mindbody",
    calendarAccount: "workspace_no_baa",
    contactName: "Alex Chen",
    contactEmail: signatoryEmail,
    contactTitle: "Owner",
  });
  const body = { ...request, ...overrides };
  // The hash of what this browser displayed, as the agreement step computes it.
  const displayed = prepareSigning(body as never, effectiveDateOf(new Date()), {});
  return { displayedHash: displayed.hash, ...body };
}

function sign(token: string | null, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  counter += 1;
  return POST(
    new Request("http://localhost/api/agreement", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": `10.3.0.${counter}`,
        "user-agent": "vitest-browser",
        ...(token ? { cookie: `hd_setup=${encodeURIComponent(token)}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function invited(email: string) {
  const created = await createSetupRequest({
    name: "Alex Chen",
    clinicName: "Radiance Med Spa",
    website: null,
    email,
    channels: ["web"],
    leadId: null,
    ipAddress: null,
  });
  if (!created.ok) throw new Error("the fake Sheet refused a request");
  const expiresAt = setupLinkExpiry();
  await updateSetupRequest(created.request.id, { status: "invited", invitedAt: new Date(), linkExpiresAt: expiresAt });
  return { id: created.request.id, token: issueSetupToken(created.request.id, email, expiresAt) };
}

/** The bodies Resend was sent. */
function emails(): Record<string, unknown>[] {
  return resend.mock.calls
    .filter(([url]) => String(url) === "https://api.resend.com/emails")
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

/** The agreement records in the fake Sheet, none before its first signature has made the tab. */
function agreementRows(): Record<string, unknown>[] {
  return sheets.tabs.has("agreements") ? sheets.records("agreements") : [];
}

function nothingButResend(): void {
  for (const [url] of resend.mock.calls) expect(String(url)).toBe("https://api.resend.com/emails");
}

describe("POST /api/agreement, while the purchase is by setup link", () => {
  test("no link, no signature", async () => {
    const response = await sign(null, signature("info@radiance.com"));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { field: string }).field).toBe("setupLink");
    expect(agreementRows()).toHaveLength(0);
  });

  test("a valid link signs only under its own address", async () => {
    const { token } = await invited("info@radiance.com");
    const other = await sign(token, signature("someone@else.com"));
    expect(other.status).toBe(422);
    expect(((await other.json()) as { field: string }).field).toBe("signatoryEmail");
    expect(agreementRows()).toHaveLength(0);
  });

  test("a valid link under its own address signs, and the request records it", async () => {
    const { id, token } = await invited("info@radiance.com");
    const response = await sign(token, signature("INFO@radiance.com"));
    expect(response.status).toBe(201);
    expect((await findSetupRequest(id))!.signedAt).toBeInstanceOf(Date);
    nothingButResend();
  });
});

describe("POST /api/agreement records the signature here, sealed, and never calls apps/app", () => {
  beforeEach(() => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
  });

  test("the answer the agreement step expects, a sealed record, and a download cookie", async () => {
    const response = await sign(null, signature("Info@Radiance.com"));
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["acceptedAt", "agreementId", "approvedByCounsel", "copy", "hash", "text", "version"].sort(),
    );
    expect(body.copy).toEqual({ status: "sent" });
    expect(body.hash).toBe(createHash("sha256").update(String(body.text), "utf8").digest("hex"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain(`${DOWNLOAD_COOKIE}=`);

    // The record opens with the shared secret, re-renders to the same text,
    // and says who signed, from where, and when, as apps/app will import it.
    const found = await findAgreementRecord(String(body.agreementId));
    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.text).toBe(body.text);
    expect(found.record).toMatchObject({
      id: body.agreementId,
      documentVersion: body.version,
      documentHash: body.hash,
      signatoryName: "Alex Chen",
      signatoryTitle: "Owner",
      signatoryEmail: "info@radiance.com",
      ipAddress: expect.stringMatching(/^10\.3\.0\./),
      userAgent: "vitest-browser",
      acceptedAt: body.acceptedAt,
      displayedHashVerified: true,
    });
    // The record keeps no text: only what re-renders it.
    const stored = agreementRows()[0]!;
    expect(String(stored.record_1)).not.toContain("BUSINESS ASSOCIATE AGREEMENT");
    nothingButResend();
  });

  test("one log line per signature names the record, never the signer", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await sign(null, signature("info@radiance.com"));
    const body = (await response.json()) as { agreementId: string; version: string; hash: string };
    const lines = info.mock.calls.filter(([line]) => String(line).includes("agreement signed"));
    expect(lines).toEqual([
      ["[healdesk] agreement signed", { agreementId: body.agreementId, version: body.version, hash: body.hash }],
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/Alex|radiance\.com/);
  });

  test("the signer is mailed the PDF, and the evidence of it goes on the record, once", async () => {
    const response = await sign(null, signature("info@radiance.com"));
    const body = (await response.json()) as { agreementId: string; hash: string };
    const [email] = emails();
    expect(email).toMatchObject({
      to: ["info@radiance.com"],
      subject: "Your signed business associate agreement for Radiance Med Spa LLC",
    });
    expect(String(email!.text)).toContain(body.hash);
    expect(String(email!.text)).not.toContain(body.agreementId);
    const [attachment] = email!.attachments as { filename: string; content: string }[];
    expect(attachment!.filename).toMatch(/^healdesk-baa-[a-z0-9._-]+-\d{4}-\d{2}-\d{2}\.pdf$/);
    const pdf = Buffer.from(attachment!.content, "base64");
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Keyed by the signature, never by the address.
    const headers = resend.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(`hd-agreement-copy-${body.agreementId}-1`);

    const found = await findAgreementRecord(body.agreementId);
    expect(found.status === "found" && found.record.copy).toEqual({
      sentAt: expect.any(String),
      pdfSha256: createHash("sha256").update(pdf).digest("hex"),
    });
  });

  test("a copy the provider refuses is reported, and no evidence is written", async () => {
    resend.mockImplementationOnce(async () => new Response("rate limited", { status: 429 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await sign(null, signature("info@radiance.com"));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { agreementId: string; copy: unknown };
    expect(body.copy).toEqual({ status: "not_sent", reason: "We tried to email your copy and it did not go out." });
    const found = await findAgreementRecord(body.agreementId);
    expect(found.status === "found" && found.record.copy).toBeNull();
  });

  test("a document other than the one on the screen is refused, and nothing is recorded", async () => {
    const response = await sign(null, { ...signature("info@radiance.com"), displayedHash: "0".repeat(64) });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { field: string }).field).toBe("displayedHash");
    expect(agreementRows()).toHaveLength(0);
    expect(emails()).toEqual([]);
  });

  test("every field is held to the catalog's caps, the title and the body included", async () => {
    const longTitle = await sign(null, signature("info@radiance.com", { signatoryTitle: "T".repeat(121) }));
    expect(longTitle.status).toBe(422);
    expect(((await longTitle.json()) as { field: string }).field).toBe("signatoryTitle");

    const label = await sign(null, signature("info@radiance.com", { assentLabel: "I agree to whatever" }));
    expect(((await label.json()) as { field: string }).field).toBe("assentLabel");

    // An address healdesk could not mail its copy to never reaches the record.
    const unsendable = await sign(null, signature("gunter@klinik.test", { signatoryEmail: "günter@klinik.test" }));
    expect(((await unsendable.json()) as { field: string }).field).toBe("signatoryEmail");

    const huge = await sign(null, { ...signature("info@radiance.com"), padding: "x".repeat(20_000) });
    expect(huge.status).toBe(413);
    expect(agreementRows()).toHaveLength(0);
  });

  test("a version below the floor, or a draft, is refused as a version and never signed", async () => {
    // What apps/app's POST /api/agreements answered until 14 October 2026,
    // asked of the same catalog code here.
    for (const templateVersion of ["1.2.1", "1.1.0-draft", "9.9.9"]) {
      const response = await sign(null, { ...signature("info@radiance.com"), templateVersion });
      expect(response.status, templateVersion).toBe(422);
      expect(((await response.json()) as { field: string }).field, templateVersion).toBe("templateVersion");
    }
    expect(agreementRows()).toHaveLength(0);
  });

  test("a Sheet that cannot take the record means nothing was signed, and no copy goes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const append = vi.spyOn(sheets, "appendRows").mockRejectedValue(new Error("Google Sheets API 503 UNAVAILABLE"));
    const response = await sign(null, signature("info@radiance.com"));
    expect(append).toHaveBeenCalled();
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toMatch(/couldn't record your agreement/);
    expect(emails()).toEqual([]);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("without the secret or the Sheet there is nothing to sign with", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("HEALDESK_PROVISION_SECRET", "");
    expect((await sign(null, signature("info@radiance.com"))).status).toBe(503);
  });
});

/**
 * The calendar answers travel with the signature (bookingSystem and
 * calendarAccount, by those names), and the platform the released agreement
 * still renders from must be the one the booking system implies.
 */
/**
 * Annex X5, P6: "In pilot mode it goes only to the email bound to the setup
 * link. In public mode it goes once per address per day, with the typed
 * variables restricted to safe characters." Until 19 October 2026 the only
 * limit was five signatures an hour per IP, per instance, and any text could
 * be mailed to any address.
 */
describe("POST /api/agreement holds the copy to an address nobody confirmed to P6's rules", () => {
  beforeEach(() => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // mockClear keeps an implementation a test set: each starts from the default.
    appTakesNoRelays();
  });

  test("one copy per address a day, counted in the Sheet, so another instance does not send a second", async () => {
    const first = await sign(null, signature("info@radiance.com"));
    expect(((await first.json()) as { copy: unknown }).copy).toEqual({ status: "sent" });
    // A cold start, or another warm instance: its memory is empty.
    __resetRateLimiterForTests();
    const second = await sign(null, signature("INFO@radiance.com"));
    expect(second.status).toBe(201);
    const body = (await second.json()) as { agreementId: string; copy: unknown };
    expect(body.copy).toEqual({
      status: "not_sent",
      reason: "A copy of an agreement already went to this address today, so we have not emailed another.",
    });
    expect(emails()).toHaveLength(1);
    // Signed and on file all the same, with its copy still owed.
    const found = await findAgreementRecord(body.agreementId);
    expect(found.status === "found" && found.record.copy).toBeNull();
    // Another address is its own day.
    const other = await sign(null, signature("owner@glow.com"));
    expect(((await other.json()) as { copy: unknown }).copy).toEqual({ status: "sent" });
  });

  /** The review of 19 October 2026: a +tag or Gmail's dots made a new address of the same mailbox. */
  test("the day's copy is counted per mailbox: a +tag or Gmail's dots are the same inbox", async () => {
    const first = await sign(null, signature("alex.chen+p6@gmail.com"));
    expect(((await first.json()) as { copy: unknown }).copy).toEqual({ status: "sent" });
    for (const variant of ["alexchen@googlemail.com", "Alex.Chen+other@Gmail.com", "a.l.e.x.chen@gmail.com"]) {
      const again = await sign(null, signature(variant));
      expect(((await again.json()) as { copy: { status: string } }).copy.status).toBe("not_sent");
    }
    expect(emails()).toHaveLength(1);
    expect(mailboxOf("Alex.Chen+p6@GoogleMail.com")).toBe("alexchen@gmail.com");
    // Elsewhere only the tag goes: dots can be part of the name.
    expect(mailboxOf("alex.chen+p6@radiance.com")).toBe("alex.chen@radiance.com");
  });

  /**
   * The review of 19 October 2026: a copy held back had no queue before
   * payment, so nobody knew to send it. apps/app is told, once per mailbox
   * and day, with the agreement's id and the code only.
   */
  /** The relays to apps/app's agreementCopyWithheld, as sent. */
  const relayed = () =>
    resend.mock.calls
      .filter(([url]) => String(url) === "http://app.test/api/ops")
      .map(([, init]) => JSON.parse(String(init?.body)) as { op: string; args: Record<string, unknown> });

  /** An apps/app without the operation, or a host in standby: no relay is taken. */
  function appTakesNoRelays(): void {
    resend.mockImplementation(async (url) => {
      if (String(url) === "https://api.resend.com/emails") return Response.json({ id: "email_1" });
      return new Response("not here", { status: 599 });
    });
  }

  /** apps/app answering the relay, as one that has the operation does. */
  function appTakesRelays(): void {
    resend.mockImplementation(async (url) => {
      if (String(url) === "https://api.resend.com/emails") return Response.json({ id: "email_1" });
      if (String(url) === "http://app.test/api/ops") return Response.json({ data: { raised: true } });
      return new Response("not here", { status: 599 });
    });
  }

  test("a copy held back is told to ops once per mailbox and day, ids and codes only", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    appTakesRelays();
    await sign(null, signature("info@radiance.com"));
    expect(relayed()).toEqual([]);
    const second = (await (await sign(null, signature("info+again@radiance.com"))).json()) as { agreementId: string };
    await sign(null, signature("info@radiance.com"));
    await vi.waitFor(() =>
      expect(relayed()).toEqual([
        { op: "agreementCopyWithheld", args: { agreementId: second.agreementId, code: "already_sent_today" } },
      ]),
    );
    expect(JSON.stringify(relayed())).not.toContain("radiance.com");
    const unsafe = (await (await sign(null, signature("x@stranger.com", { signatoryName: "Call 5125550100" }))).json()) as {
      agreementId: string;
    };
    await vi.waitFor(() =>
      expect(relayed()[1]).toEqual({
        op: "agreementCopyWithheld",
        args: { agreementId: unsafe.agreementId, code: "unsafe_text" },
      }),
    );
  });

  /**
   * The check of 19 October 2026: a relay apps/app did not take kept the
   * mailbox's place for the day, so no later signing was told; and a copy
   * that failed was never told at all.
   */
  test("a relay apps/app did not take gives its place back, and a copy that failed is told too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    appTakesNoRelays();
    await sign(null, signature("relays@radiance.com"));
    // apps/app answers nothing it knows (599 here): the relay is not taken,
    // and once it has answered, the mailbox's place is given back.
    await sign(null, signature("relays@radiance.com"));
    await vi.waitFor(() => expect(relayed()).toHaveLength(1));
    const withheldPlaces = () =>
      sheets
        .records("counters")
        .filter((r) => String(r.key).startsWith("agreement-copy-withheld:") && r.key !== "agreement-copy-withheld:day")
        .map((r) => Number(r.count));
    await vi.waitFor(() => expect(withheldPlaces()).toEqual([0]));
    appTakesRelays();
    const third = (await (await sign(null, signature("relays@radiance.com"))).json()) as { agreementId: string };
    await vi.waitFor(() => expect(relayed()).toHaveLength(2));
    expect(relayed()[1]!.args).toEqual({ agreementId: third.agreementId, code: "already_sent_today" });

    resend.mockImplementationOnce(async () => new Response("down", { status: 500 }));
    const failed = (await (await sign(null, signature("new@clinic.com"))).json()) as { agreementId: string };
    await vi.waitFor(() =>
      expect(relayed()[2]).toEqual({ op: "agreementCopyWithheld", args: { agreementId: failed.agreementId, code: "send_failed" } }),
    );
  });

  test("telling ops never holds the buyer's answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await sign(null, signature("answer@radiance.com"));
    let answerRelay: (r: Response) => void = () => {};
    resend.mockImplementation(async (url) => {
      if (String(url) === "http://app.test/api/ops") return new Promise<Response>((resolve) => (answerRelay = resolve));
      return Response.json({ id: "email_1" });
    });
    const answer = await sign(null, signature("answer@radiance.com"));
    // The withheld sentence, while the relay is still waiting on apps/app.
    expect(((await answer.json()) as { copy: { reason: string } }).copy.reason).toBe(
      "A copy of an agreement already went to this address today, so we have not emailed another.",
    );
    await vi.waitFor(() => expect(relayed()).toHaveLength(1));
    answerRelay(Response.json({ data: { raised: true } }));
  });

  test("the day's copies to unconfirmed addresses are capped across mailboxes, and a refusal takes nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The day's places but one are taken already, by other mailboxes.
    for (let i = 1; i < UNCONFIRMED_COPIES_PER_DAY; i += 1) {
      expect((await takeRateLimit("agreement-copy:day", UNCONFIRMED_COPIES_PER_DAY, 24 * 60 * 60 * 1000)).ok).toBe(true);
    }
    const last = (await (await sign(null, signature("last@clinic.com"))).json()) as { copy: unknown };
    expect(last.copy).toEqual({ status: "sent" });
    const over = (await (await sign(null, signature("one.more@clinic.com"))).json()) as { copy: unknown };
    expect(over.copy).toEqual({
      status: "not_sent",
      reason: "We have emailed as many copies today as we send in a day, so yours has not been sent.",
    });
    expect(emails()).toHaveLength(1);
    // The refused mailbox kept nothing: its own day is free for tomorrow's place.
    const day = sheets.records("counters").find((r) => r.key === "agreement-copy:day");
    expect(Number(day!.count)).toBe(UNCONFIRMED_COPIES_PER_DAY);
  });

  /**
   * The check of 19 October 2026: every call counted, a refused one too, so a
   * copy that failed while a second signing was refused left the day spent,
   * and the next signing was told a copy had gone.
   */
  test("a copy that failed while a second signing was refused leaves the mailbox's day free", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The first copy's send fails, slowly, while the second signing is refused.
    let firstSend = true;
    resend.mockImplementation(async (url) => {
      if (String(url) !== "https://api.resend.com/emails") return new Response("not here", { status: 599 });
      if (!firstSend) return Response.json({ id: "email_2" });
      firstSend = false;
      return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("down", { status: 500 })), 100));
    });
    const [a, b] = await Promise.all([
      sign(null, signature("info@radiance.com")),
      sign(null, signature("info@radiance.com")),
    ]);
    const reasons = await Promise.all([a, b].map(async (r) => ((await r.json()) as { copy: { reason?: string } }).copy.reason));
    expect(reasons).toContain("We tried to email your copy and it did not go out.");
    const c = await sign(null, signature("info@radiance.com"));
    expect(((await c.json()) as { copy: unknown }).copy).toEqual({ status: "sent" });
  });

  test("the address is counted and sent in the form it travels in: a full-width domain is gmail.com", async () => {
    const wide = await sign(null, signature("alex@ｇｍａｉｌ.com"));
    expect(wide.status).toBe(201);
    expect(((await wide.json()) as { copy: unknown }).copy).toEqual({ status: "sent" });
    expect(emails()[0]!.to).toEqual(["alex@gmail.com"]);
    const plain = await sign(null, signature("a.lex@gmail.com"));
    expect(((await plain.json()) as { copy: { status: string } }).copy.status).toBe("not_sent");
    expect(mailboxOf("alex@gmail。com")).toBe("alex@gmail.com");
    expect(mailboxOf("alex@münchen.de")).toBe(mailboxOf("alex@xn--mnchen-3ya.de"));
  });

  test("two signings to one mailbox at the same moment send one copy", async () => {
    const [a, b] = await Promise.all([
      sign(null, signature("info@radiance.com")),
      sign(null, signature("info@radiance.com")),
    ]);
    const statuses = [a, b].map(async (r) => ((await r.json()) as { copy: { status: string } }).copy.status);
    expect((await Promise.all(statuses)).sort()).toEqual(["not_sent", "sent"]);
    expect(emails()).toHaveLength(1);
  });

  test("a copy the provider refused does not use up the address's day", async () => {
    resend.mockImplementationOnce(async () => new Response("down", { status: 500 }));
    await sign(null, signature("info@radiance.com"));
    const again = await sign(null, signature("info@radiance.com"));
    expect(((await again.json()) as { copy: unknown }).copy).toEqual({ status: "sent" });
  });

  test.each([
    ["the practice's name", { clinicLegalName: "Claim your prize at radiance-prizes.com" }],
    ["the signer's name", { signatoryName: "Call 5125550100 now" }],
    ["the signer's title", { signatoryTitle: "Owner: https://evil.example" }],
  ])("%s with a link or a number in it is signed, and the copy is not mailed", async (_field, overrides) => {
    const response = await sign(null, signature("someone@stranger.com", overrides));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { agreementId: string; copy: { status: string } };
    expect(body.copy.status).toBe("not_sent");
    expect(emails()).toHaveLength(0);
    expect((await findAgreementRecord(body.agreementId)).status).toBe("found");
  });

  test("the copy carries the footer every email does, under a subject of at most 70 characters", async () => {
    const long = `Radiance ${"Aesthetic and Wellness ".repeat(6)}Med Spa LLC`;
    await sign(null, signature("info@radiance.com", { clinicLegalName: long }));
    const [email] = emails();
    expect([...String(email!.subject)].length).toBeLessThanOrEqual(70);
    expect(String(email!.text)).toContain("Replies reach the healdesk team. Please leave out patient details.");
    expect(String(email!.text)).not.toContain("is a service of");
    expect(String(email!.text)).toContain("Wilmington, DE 19801");
    expect(String(email!.html)).not.toMatch(/href=/);
  });
});

describe("POST /api/agreement, under a setup link, mails the address the link was sent to", () => {
  test("each signature's copy goes, whatever the day's count: the link confirmed the address", async () => {
    const { token } = await invited("info@radiance.com");
    for (const name of ["Radiance Med Spa", "Radiance Med Spa LLC"]) {
      const response = await sign(token, signature("info@radiance.com", { clinicLegalName: name }));
      expect(((await response.json()) as { copy: unknown }).copy).toEqual({ status: "sent" });
    }
    expect(emails()).toHaveLength(2);
  });
});

describe("POST /api/agreement checks the calendar answers before anything is signed", () => {
  beforeEach(() => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
  });

  async function refusal(response: Response) {
    return { status: response.status, field: ((await response.json()) as { field: string }).field };
  }

  test("an unknown booking system, or none, is refused", async () => {
    expect(await refusal(await sign(null, { ...signature("a@clinic.com"), bookingSystem: "zenoti" }))).toEqual({
      status: 422,
      field: "bookingSystem",
    });
    expect(await refusal(await sign(null, { ...signature("a@clinic.com"), bookingSystem: undefined }))).toEqual({
      status: 422,
      field: "bookingSystem",
    });
  });

  test("an unknown Google account kind is refused", async () => {
    expect(await refusal(await sign(null, { ...signature("a@clinic.com"), calendarAccount: "gmail" }))).toEqual({
      status: 422,
      field: "calendarAccount",
    });
  });

  test("a platform the booking system doesn't imply is refused", async () => {
    // Mindbody's agreement names Mindbody; Calendly has no phase-two platform, so "none".
    expect(await refusal(await sign(null, { ...signature("a@clinic.com"), platform: "boulevard" }))).toEqual({
      status: 422,
      field: "platform",
    });
    const calendly = signature("a@clinic.com", { bookingSystem: "calendly", platform: "none" });
    expect(await refusal(await sign(null, { ...calendly, platform: "calcom" }))).toEqual({ status: 422, field: "platform" });
    expect(agreementRows()).toHaveLength(0);

    const signed = await sign(null, calendly);
    expect(signed.status).toBe(201);
    const found = await findAgreementRecord(((await signed.json()) as { agreementId: string }).agreementId);
    expect(found.status === "found" && found.record.answers).toMatchObject({
      bookingSystem: "calendly",
      calendarAccount: "workspace_no_baa",
      platformId: "none",
    });
  });

  test("a practice with no agreement to sign here is refused", async () => {
    expect(await refusal(await sign(null, { ...signature("a@clinic.com"), specialty: "astrology" }))).toEqual({
      status: 422,
      field: "specialty",
    });
    expect(agreementRows()).toHaveLength(0);
  });

  test("a veterinary practice, and a med spa that answered No, sign the Data Protection Agreement since its release", async () => {
    for (const practice of [
      { specialty: "veterinary", covered: null },
      { specialty: "med-spa", covered: "no" },
    ] as const) {
      const response = await sign(null, signature("a@clinic.com", {}, practice));
      expect(response.status, practice.specialty).toBe(201);
      const body = (await response.json()) as { agreementId: string; version: string; text: string; approvedByCounsel: boolean };
      // DPA 1.2.0 since it landed (reconciled 1 November 2026) (dpa/1.1.0 before it).
      expect(body.version, practice.specialty).toBe("dpa/1.2.0");
      expect(body.approvedByCounsel).toBe(true);
      expect(body.text.startsWith("HEALDESK DATA PROTECTION AGREEMENT\nVersion 1.2.0")).toBe(true);
      expect(body.text.replace(/\s+/g, " ")).toContain("a single text message that carries fixed wording");
      const found = await findAgreementRecord(body.agreementId);
      expect(found.status === "found" && found.record.documentVersion).toBe("dpa/1.2.0");
    }
    // A veterinary practice that sends the BAA's wording is refused: the decision is the catalogue's.
    const vet = signature("a@clinic.com", {}, { specialty: "veterinary", covered: null });
    expect(await refusal(await sign(null, { ...vet, assentLabel: "I agree to the Business Associate Agreement" }))).toEqual({
      status: 422,
      field: "assentLabel",
    });
  });
});
