import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { withinSignInRequestLimit } from "@/lib/connections/attempt-limit";
import type {
  DeliveryResult,
  DeliveryTarget,
  EmailTransport,
  OutgoingEmail,
} from "@/lib/reporting/deliver";
import { consumeSignInLink, lookUpSignInLink } from "@/lib/sign-in/links";
import { looksLikeEmail, normaliseSignInEmail, sendSignInLink } from "@/lib/sign-in/request";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { seedClinic, seedPortalUser } from "./setup/factories";

/**
 * /sign-in (plan Part D1): a link goes only to a clinic's address, signs in
 * the user it was sent to, lands where it was asked to land if that is a path
 * on this app, and is never minted when nobody could be sent it.
 *
 * The page's uniform answer is in the action (it answers before any of this
 * runs); what is tested here is what happens after that answer.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "https://app.healdesk.test";

type Sent = { target: DeliveryTarget; message: OutgoingEmail };

function fakeTransport(result: DeliveryResult = { status: "sent", messageId: "msg_1" }) {
  const sent: Sent[] = [];
  const transport: EmailTransport = {
    name: "fake",
    send: async (target, message) => {
      sent.push({ target, message });
      return result;
    },
  };
  return { sent, transport };
}

function tokenIn(text: string): string {
  const match = new RegExp(`${ORIGIN.replace(/\./g, "\\.")}/link/([A-Za-z0-9_-]{43})`).exec(text);
  if (!match) throw new Error("no sign-in link in the email");
  return match[1]!;
}

async function linkCount(): Promise<number> {
  const { rows } = await getMigratorPool().query<{ n: string }>(
    `select count(*) as n from sign_in_links`,
  );
  return Number(rows[0]!.n);
}

const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["BETTER_AUTH_URL", "NODE_ENV"]) SAVED[key] = process.env[key];
  process.env.BETTER_AUTH_URL = ORIGIN;
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else (process.env as Record<string, string>)[key] = value;
  }
});

describe("what /sign-in accepts", () => {
  test("an address is compared trimmed and lower-cased, and only a plausible one is tried", () => {
    expect(normaliseSignInEmail("  Laura@GlowSpa.COM ")).toBe("laura@glowspa.com");
    expect(looksLikeEmail("info@glowspa.com")).toBe(true);
    for (const bad of ["", "laura", "laura@", "@glowspa.com", "laura@glowspa", "a b@glowspa.com"]) {
      expect(looksLikeEmail(bad), bad).toBe(false);
    }
  });

  test("five requests for one inbox in ten minutes, twenty from one client, whoever owns them", () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const inbox = `limit-${randomUUID()}@glowspa.test`;
    for (let i = 0; i < 5; i += 1)
      expect(withinSignInRequestLimit(inbox, ip), `request ${i + 1}`).toBe(true);
    expect(withinSignInRequestLimit(inbox, ip)).toBe(false);

    // Other inboxes from the same client, up to its own ceiling of twenty
    // (the six above count towards it).
    for (let i = 0; i < 14; i += 1) {
      expect(
        withinSignInRequestLimit(`other-${i}-${randomUUID()}@glowspa.test`, ip),
        `inbox ${i}`,
      ).toBe(true);
    }
    expect(withinSignInRequestLimit(`one-more-${randomUUID()}@glowspa.test`, ip)).toBe(false);

    // No client address: the inbox bound still holds on its own.
    const lone = `lone-${randomUUID()}@glowspa.test`;
    for (let i = 0; i < 5; i += 1) expect(withinSignInRequestLimit(lone, null)).toBe(true);
    expect(withinSignInRequestLimit(lone, null)).toBe(false);
  });
});

describeDb("sending a sign-in link", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  test("a clinic's address gets one link, to the address on file, which signs that user in", async () => {
    const clinic = await seedClinic("glow");
    const owner = await seedPortalUser(clinic.clinicId, "owner");
    await getMigratorPool().query(`update "user" set email = 'Laura@GlowSpa.test' where id = $1`, [
      owner.userId,
    ]);
    const { sent, transport } = fakeTransport();

    const outcome = await sendSignInLink(
      { email: "  laura@glowspa.TEST ", next: "/c/glow/setup" },
      { transport },
    );

    expect(outcome).toBe("sent");
    expect(sent).toHaveLength(1);
    const [{ target, message }] = sent as [Sent];
    expect(target.to).toBe("Laura@GlowSpa.test");
    expect(message.subject).toBe("Your healdesk sign-in link");
    expect(message.phiClass).toBe("none");

    const token = tokenIn(message.text);
    const looked = await lookUpSignInLink(token);
    expect(looked).toMatchObject({ ok: true, userId: owner.userId, purpose: "sign_in" });
    const { rows } = await getMigratorPool().query<{ id: string }>(`select id from sign_in_links`);
    expect(message.idempotencyKey).toBe(`hd-sign_in_link-${rows[0]!.id}-1`);
    // Ids and the kind only: no clinic tag, because a sign-in names no
    // clinic, and never the address.
    expect(message.tags).toEqual([
      { name: "app", value: "app" },
      { name: "kind", value: "sign_in_link" },
      { name: "delivery", value: rows[0]!.id },
    ]);
    expect(message.text).not.toContain(clinic.slug);

    expect(await consumeSignInLink(token, "203.0.113.9")).toEqual({
      ok: true,
      userId: owner.userId,
      purpose: "sign_in",
      redirectTo: "/c/glow/setup",
    });
  });

  test("an address with no clinic, or no account at all, is sent nothing and mints nothing", async () => {
    await getMigratorPool().query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ($1, 'Former owner', 'former@glowspa.test', true, now(), now())`,
      [`usr_${randomUUID().slice(0, 12)}`],
    );
    const { sent, transport } = fakeTransport();

    expect(await sendSignInLink({ email: "former@glowspa.test" }, { transport })).toBe(
      "no_account",
    );
    expect(await sendSignInLink({ email: "stranger@elsewhere.test" }, { transport })).toBe(
      "no_account",
    );
    expect(sent).toHaveLength(0);
    expect(await linkCount()).toBe(0);
  });

  test("a next that leaves the app is dropped, so the link still signs in", async () => {
    const clinic = await seedClinic("glow");
    const owner = await seedPortalUser(clinic.clinicId, "owner");
    const { sent, transport } = fakeTransport();

    expect(
      await sendSignInLink({ email: owner.email, next: "//evil.test/c/glow" }, { transport }),
    ).toBe("sent");
    const consumed = await consumeSignInLink(tokenIn(sent[0]!.message.text), null);
    expect(consumed).toMatchObject({ ok: true, redirectTo: null });
  });

  test("with no public origin in production, no link is minted that nobody could be sent", async () => {
    const clinic = await seedClinic("glow");
    const owner = await seedPortalUser(clinic.clinicId, "owner");
    delete process.env.BETTER_AUTH_URL;
    (process.env as Record<string, string>).NODE_ENV = "production";
    const { sent, transport } = fakeTransport();

    expect(await sendSignInLink({ email: owner.email }, { transport })).toBe("unavailable");
    expect(sent).toHaveLength(0);
    expect(await linkCount()).toBe(0);
  });

  test("a send the provider refuses is reported as failed", async () => {
    const clinic = await seedClinic("glow");
    const owner = await seedPortalUser(clinic.clinicId, "owner");
    const { transport } = fakeTransport({
      status: "failed",
      reason: "provider said no",
      statusCode: 422,
    });

    expect(await sendSignInLink({ email: owner.email }, { transport })).toBe("failed");
  });
});
