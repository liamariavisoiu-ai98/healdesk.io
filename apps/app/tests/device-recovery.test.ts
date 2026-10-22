import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The human route for a clinic that has lost every device (wave 2, R4; plan
 * Part D3, "Lost every device", and Annex X5's O3), end to end: the
 * operator's link, issued only after the call back and sent only to the
 * clinic's address; the /recover/<token> page, whose GET spends nothing and
 * whose POST signs in and claims the link for that session; the one passkey
 * that session may add, once, for that clinic's sign-in only, inside the
 * link's window; and O3's promise kept, the operator removing a device and
 * signing everyone out. Then the paying browser's seven-day first
 * enrolment, and the Protect page that no longer loops with step-up.
 *
 * Driven through the real Better Auth session endpoint and the real
 * ceremony around @simplewebauthn/server, whose registration verdict alone
 * is stubbed, as in tests/passkeys.test.ts.
 */

/**
 * One response's cookies, as Next's cookies() store would carry them: what
 * the browser sent, and every Set-Cookie the request wrote, in order. Each
 * request runs inside its own jar (AsyncLocalStorage), so two concurrent
 * POSTs never share one; outside a jar, cookies are read as absent and
 * writes are dropped.
 */
type Jar = {
  sent: Map<string, string>;
  set: { name: string; value: string }[];
};

const mocks = vi.hoisted(() => {
  class NavigationSignal extends Error {
    constructor(readonly url: string) {
      super("NEXT_REDIRECT");
    }
  }
  return {
    NavigationSignal,
    jars: undefined as unknown as { getStore(): Jar | undefined },
    headers: new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.7" }),
    verifyRegistrationResponse: vi.fn(),
    sent: [] as { to: string; kind: string; subject: string; text: string }[],
  };
});

vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => {
    const jar = mocks.jars?.getStore();
    return {
      get: (name: string) => {
        const value = jar?.sent.get(name);
        return value === undefined ? undefined : { name, value };
      },
      set: (name: string, value: string) => {
        jar?.set.push({ name, value });
      },
      delete: (name: string) => {
        jar?.set.push({ name, value: "" });
      },
    };
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.NavigationSignal(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return { ...actual, verifyRegistrationResponse: mocks.verifyRegistrationResponse };
});
vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return {
    ...actual,
    sendEmail: (
      email: Parameters<typeof actual.sendEmail>[0],
      options: Parameters<typeof actual.sendEmail>[1] = {},
    ) =>
      actual.sendEmail(email, {
        ...options,
        transport: {
          name: "fake",
          send: async (target, message) => {
            mocks.sent.push({
              to: target.to,
              kind: email.kind,
              subject: message.subject,
              text: message.text,
            });
            return { status: "sent", messageId: `msg_${mocks.sent.length}` };
          },
        },
      }),
  };
});

const { auth } = await import("@/lib/auth");
const { passkeyEnrolDecision } = await import("@/lib/factors/authority");
const { finishPasskeyRegistration, startPasskeyRegistration } =
  await import("@/lib/factors/passkeys");
const { bindDeviceRecovery, claimDeviceRecovery, liveDeviceRecovery, lookUpDeviceRecovery } =
  await import("@/lib/factors/recovery");
const { someoneLeft } = await import("@/lib/factors/someone-left");
const { hashSessionToken } = await import("@/lib/factors/step-ups");
const { isMutating, isOpName, parseEnvelope, runOperation } = await import("@/lib/ops/api");
const { default: RecoverPage } = await import("@/app/recover/[token]/page");
const { ProtectDevice } = await import("@/app/c/[slug]/protect/ProtectDevice");
const { HUMAN_ROUTE, protectMode } = await import("@/app/c/[slug]/protect/copy");
const { renderDeviceChanged } = await import("@/lib/email/templates/device_changed");
const { DEVICE_RECOVERY_LINK_ENTRY } = await import("@/lib/email/templates/device_recovery_link");
const { DEVICE_RECOVERY_TTL_HOURS } = await import("@/lib/factors/recovery-terms");

const { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } =
  await import("./setup/db");
const { unsafeDb } = await import("@/db");
const { inTenant, seedClinic } = await import("./setup/factories");
const { runAddressChangesJob } = await import("@/lib/sign-in/address-change");

const jars = new AsyncLocalStorage<Jar>();
mocks.jars = jars;

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "https://app.healdesk.test";
const SESSION_COOKIE = "hd.session_token";
const OPERATOR = { email: "ops@healdesk.test", request: {} };

type Binding = { userId: string; sessionTokenHash: Buffer };
type Clinic = Awaited<ReturnType<typeof seedClinic>>;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getMigratorPool().query<T>(text, values)).rows;
}

type Client = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

/** One block on the RUNTIME role, always rolled back. Identity plane: no tenant. */
async function asApp<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    return await fn(client as unknown as Client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

async function op(name: string, args: Record<string, unknown> = {}) {
  const parsed = parseEnvelope(JSON.stringify({ op: name, args }));
  if (!parsed.ok) throw new Error(`${name} is not an operation`);
  const outcome = await runOperation(parsed.envelope.op, parsed.envelope.args, OPERATOR);
  return (outcome as { body: { data?: Record<string, unknown> } }).body.data!;
}

async function events(name: string) {
  return sql<{ actor_label: string; user_id: string | null; metadata: Record<string, unknown> }>(
    `select actor_label, user_id, metadata from security_events where event = $1 order by occurred_at`,
    [name],
  );
}

/** The token in the last recovery email, which is the only place it is ever written. */
function lastLinkToken(): string {
  const mail = [...mocks.sent].reverse().find((m) => m.kind === "device_recovery_link");
  const match =
    mail &&
    new RegExp(`${ORIGIN.replace(/\./g, "\\.")}/recover/([A-Za-z0-9_-]{43})`).exec(mail.text);
  if (!match) throw new Error("no recovery link was sent");
  return match[1]!;
}

async function issue(clinic: Clinic): Promise<string> {
  const outcome = await op("issueDeviceRecovery", { clinicId: clinic.clinicId, calledBack: true });
  expect(outcome).toMatchObject({ status: "issued", emailed: true });
  return lastLinkToken();
}

/** The form's server action in a rendered page, found the way a browser would submit it. */
function formAction(node: ReactNode): ((data: FormData) => Promise<void>) | null {
  if (!isValidElement(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = formAction(child);
        if (found) return found;
      }
    }
    return null;
  }
  const element = node as ReactElement<{ action?: unknown; children?: ReactNode }>;
  if (element.type === "form" && typeof element.props.action === "function") {
    return element.props.action as (data: FormData) => Promise<void>;
  }
  return formAction(element.props.children);
}

/**
 * Submit the /recover page's form for `token`; returns where the browser is
 * sent. A page rendered while a link worked can be submitted after it no
 * longer does (a stale tab), so the form may come from `pageOf`'s page. The
 * POST runs in `jar`, a response of its own, whose Set-Cookies it records.
 */
async function postLink(
  token: string,
  pageOf: string = token,
  jar: Jar = { sent: new Map(), set: [] },
): Promise<string> {
  return submit(await pageAction(pageOf), token, jar);
}

/** The Continue form's action, from the page as rendered for `token`. */
async function pageAction(token: string): Promise<(data: FormData) => Promise<void>> {
  const page = await RecoverPage({ params: Promise.resolve({ token }) });
  const action = formAction(page);
  if (!action) throw new Error("the page has no form to submit");
  return action;
}

/** Submit a rendered form for `token` in `jar`, its own response; returns where the browser goes. */
async function submit(
  action: (data: FormData) => Promise<void>,
  token: string,
  jar: Jar,
): Promise<string> {
  const data = new FormData();
  data.set("token", token);
  return jars.run(jar, async () => {
    try {
      await action(data);
    } catch (error) {
      if (error instanceof mocks.NavigationSignal) return error.url;
      throw error;
    }
    throw new Error("the action did not redirect");
  });
}

/** The session cookies a response set, by value. */
function sessionCookiesSet(jar: Jar): string[] {
  return jar.set.filter((c) => c.name === SESSION_COOKIE).map((c) => c.value);
}

/** Make the sign-in's open links lapse, as the owner past the trigger that keeps every role off the clock. */
async function lapse(userId: string): Promise<void> {
  const client = await getMigratorPool().connect();
  try {
    await client.query("begin");
    await client.query(`alter table device_recoveries disable trigger device_recoveries_guard`);
    await client.query(
      `update device_recoveries set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
        where user_id = $1 and used_at is null and revoked_at is null`,
      [userId],
    );
    await client.query(`alter table device_recoveries enable trigger device_recoveries_guard`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Open a change of the sign-in's address straight in the table, as nothing in the app would, to test the backstops. */
async function openChangeBehindTheAppsBack(clinic: Clinic, to: string): Promise<void> {
  await inTenant(clinic.clinicId, (c) =>
    c.query(
      `insert into sign_in_address_changes (clinic_id, user_id, old_email, new_email, source, status, requested_by, confirmed_at, effective_at)
       values ($1, $2, $3, $4, 'operator', 'pending', 'ops', now(), now() + interval '72 hours')`,
      [clinic.clinicId, clinic.staffUserId, clinic.staffEmail, to],
    ),
  );
}

/** A session the way a sign-in link starts one. */
async function startSession(userId: string): Promise<{ id: string; binding: Binding }> {
  const started = await auth.api.startLinkSession({ body: { userId }, headers: new Headers() });
  const [row] = await sql<{ token: string }>(`select token from session where id = $1`, [
    started.sessionId,
  ]);
  return {
    id: started.sessionId,
    binding: { userId, sessionTokenHash: hashSessionToken(row!.token) },
  };
}

async function sessionsOf(userId: string) {
  return sql<{ id: string; token: string }>(
    `select id, token from session where user_id = $1 order by created_at`,
    [userId],
  );
}

async function goLive(clinicId: string) {
  await sql(`update clinics set went_live_at = now() where id = $1`, [clinicId]);
}

async function passkeys(userId: string) {
  return sql<{ id: string; device_label: string; revoked_at: Date | null }>(
    `select id, device_label, revoked_at from user_factors where user_id = $1 and kind = 'passkey' order by created_at`,
    [userId],
  );
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

function registrationResponse(challenge: string, credentialId: string) {
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    response: {
      clientDataJSON: b64(JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN })),
      attestationObject: b64(randomBytes(64)),
      transports: ["internal"],
    },
    clientExtensionResults: {},
  };
}

function registers(credentialId: string) {
  mocks.verifyRegistrationResponse.mockResolvedValueOnce({
    verified: true,
    registrationInfo: {
      fmt: "none",
      aaguid: "00000000-0000-0000-0000-000000000000",
      credential: {
        id: credentialId,
        publicKey: new Uint8Array(randomBytes(77)),
        counter: 0,
        transports: ["internal"],
      },
      credentialType: "public-key",
      attestationObject: new Uint8Array(1),
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: ORIGIN,
      rpID: "app.healdesk.test",
    },
  });
}

/** Finish a registration started earlier, as the browser would answer its challenge. */
async function finish(
  session: Binding,
  challenge: string,
  label: string,
  extra: { payingBrowser?: boolean } = {},
) {
  const credentialId = b64(randomBytes(16));
  registers(credentialId);
  return finishPasskeyRegistration({
    session,
    response: registrationResponse(challenge, credentialId),
    deviceLabel: label,
    ...extra,
  });
}

async function seedPasskey(userId: string, label: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, transports, backed_up)
     values ($1, 'passkey', $2, $3, $4, 0, array['internal'], true) returning id`,
    [userId, label, randomBytes(16).toString("base64url"), randomBytes(77)],
  );
  return row!.id;
}

describe("the device operations are on the list", () => {
  test("one read and three writes", () => {
    expect(isOpName("getClinicDevices")).toBe(true);
    expect(isMutating("getClinicDevices")).toBe(false);
    for (const name of ["issueDeviceRecovery", "endDeviceRecovery", "removeClinicDevices"]) {
      expect(isOpName(name), name).toBe(true);
      expect(isMutating(name as never), name).toBe(true);
    }
  });
});

describe("the Protect page", () => {
  const props = {
    slug: "glow",
    next: "/c/glow",
    firstDevice: false,
    codeRoute: false,
    initialDevice: "mac" as const,
    stepUpHref: "/c/glow/step-up?next=%2Fc%2Fglow",
    audience: "patients" as const,
  };
  const text = (html: string) =>
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;|&#39;|&rsquo;/g, "'")
      .replace(/\s+/g, " ");

  test("with no device after go-live, it never claims one exists or sends the browser to step-up", () => {
    const html = renderToStaticMarkup(
      createElement(ProtectDevice, { ...props, mode: "no_device" }),
    );
    expect(text(html)).not.toContain("already has a device");
    expect(html).not.toContain("step-up");
    expect(text(html)).toContain("a device is added with our help");
    expect(text(html)).toContain(HUMAN_ROUTE.replace(/’/g, "'"));
    // No code to give and no device to confirm with: nothing to press but our help.
    expect(text(html)).not.toContain("Name this device");

    const withCode = renderToStaticMarkup(
      createElement(ProtectDevice, { ...props, mode: "no_device", codeRoute: true }),
    );
    expect(text(withCode)).toContain("a code from your authenticator app or a backup code");
    expect(text(withCode)).toContain("Name this device");
    expect(withCode).not.toContain("step-up");
  });

  test("with a device elsewhere, it offers that device, the code and our help", () => {
    const html = renderToStaticMarkup(
      createElement(ProtectDevice, { ...props, mode: "needs_proof", codeRoute: true }),
    );
    expect(html).toContain(props.stepUpHref.replace(/&/g, "&amp;"));
    expect(text(html)).toContain("Confirm with a device that has it");
    expect(text(html)).toContain("No device or code at hand?");
  });

  test("opened by the human route's link, it says the link adds one device", () => {
    const html = renderToStaticMarkup(
      createElement(ProtectDevice, { ...props, mode: "open", recovery: true }),
    );
    expect(text(html)).toContain("The link from healdesk lets one device be added, once.");
    expect(html).not.toContain("step-up");
  });

  test("its mode follows the decision", () => {
    expect(protectMode({ allowed: true, basis: "paying_browser" })).toBe("open");
    expect(protectMode({ allowed: false, codeRoute: true, hasPasskey: true })).toBe("needs_proof");
    expect(protectMode({ allowed: false, codeRoute: true, hasPasskey: false })).toBe("no_device");
  });
});

describe("O3 for what healdesk did", () => {
  const ctx = {
    clinicName: null,
    audience: "patients" as const,
    reason: "You're receiving this because this address is the sign-in for a healdesk account.",
    raisedAt: new Date("2026-10-19T14:32:00Z"),
    timeZone: "America/New_York",
  };

  test("a device added with the link says so; every addition says we call back before acting", () => {
    const viaLink = renderDeviceChanged(
      {
        change: "added",
        deviceName: "Front desk Mac",
        changedAt: "2026-10-19T14:32:00Z",
        source: "recovery",
      },
      ctx,
    );
    expect(viaLink.text).toContain(
      "with the one-time link healdesk emailed to this address after a call with your clinic",
    );
    expect(viaLink.text).toContain(
      "We'll call your clinic back on its published number, then remove the device and sign everyone out.",
    );
    const plain = renderDeviceChanged(
      { change: "added", deviceName: "Front desk Mac", changedAt: "2026-10-19T14:32:00Z" },
      ctx,
    );
    expect(plain.text).not.toContain("one-time link");
  });

  test("the operator's sign-out says healdesk did it, at the clinic's request", () => {
    const out = renderDeviceChanged(
      {
        change: "signed_out",
        changedAt: "2026-10-19T14:32:00Z",
        removedCount: 1,
        source: "operator",
      },
      ctx,
    );
    expect(out.text).toContain(
      "at your clinic's request and after calling it back, healdesk signed every browser out",
    );
    expect(out.text).toContain("one device was removed");
    expect(out.text).not.toContain("Someone left");
  });
});

describe("O16, the link's email", () => {
  test("asks for a new email to stop it, never a reply, which would copy the live link into hello@", async () => {
    const rendered = DEVICE_RECOVERY_LINK_ENTRY.render(DEVICE_RECOVERY_LINK_ENTRY.fixture, {
      clinicName: "Radiance Med Spa",
      audience: "patients",
      reason:
        "You're receiving this because this is the address on Radiance Med Spa's healdesk account.",
      raisedAt: new Date("2026-10-19T14:32:00Z"),
      timeZone: "America/New_York",
    });
    expect(rendered.text).toContain(
      "Write a new email to hello@healdesk.io, rather than replying to this one, so the link isn't copied into it",
    );
    expect(rendered.text).not.toMatch(/reply to this email/i);
    // Nor does its footer invite the reply (X1.9's line for this one kind).
    expect(rendered.text).not.toContain("Replies reach the healdesk team");
    expect(rendered.text).toContain(
      "To reach the healdesk team, write a new email to hello@healdesk.io rather than replying.",
    );
  });
});

describeDb("the human route", () => {
  beforeAll(async () => {
    await runMigrations();
    process.env.BETTER_AUTH_URL = ORIGIN;
  }, 120_000);

  beforeEach(async () => {
    await truncateAll();
    mocks.sent.length = 0;
    mocks.verifyRegistrationResponse.mockReset();
  });

  afterAll(async () => {
    await closePools();
  });

  test("the table: identity plane, never deleted, and only the claim, the use and the end move", async () => {
    const columns = await sql<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'device_recoveries'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain("clinic_id");
    const [privileges] = await sql<Record<string, boolean>>(
      `select has_table_privilege('healdesk_app', 'device_recoveries', 'SELECT') as select,
              has_table_privilege('healdesk_app', 'device_recoveries', 'INSERT') as insert,
              has_table_privilege('healdesk_app', 'device_recoveries', 'DELETE') as delete`,
    );
    expect(privileges).toEqual({ select: true, insert: true, delete: false });
    const updatable = await sql<{ attname: string }>(
      `select a.attname from pg_attribute a
        where a.attrelid = 'device_recoveries'::regclass and a.attnum > 0 and not a.attisdropped
          and has_column_privilege('healdesk_app', a.attrelid, a.attnum, 'UPDATE')
        order by a.attname`,
    );
    expect(updatable.map((r) => r.attname)).toEqual([
      "claimed_at",
      "factor_id",
      "revoked_at",
      "revoked_reason",
      "session_token_hash",
      "used_at",
    ]);
  });

  test("the table: the database dates and binds every link; a forward date, a longer window, a link that arrives claimed or bound elsewhere are refused or undone, for the runtime role", async () => {
    const clinic = await seedClinic("rtable");
    const digest = () => createHash("sha256").update(randomBytes(16)).digest();
    const insert = (extra = "", values: unknown[] = []) =>
      asApp((c) =>
        c.query<{ id: string; ahead: boolean; hours: string }>(
          `insert into device_recoveries (user_id, token_hash, address_hash, landing, issued_by, created_at, expires_at${extra ? `, ${extra}` : ""})
           values ($1, $2, app_address_hash($1), '/c/x/protect', 'ops', now() + interval '1 year', now() + interval '1 year 23 hours'${values.length ? `, ${values.map((_, i) => `$${i + 3}`).join(", ")}` : ""})
           returning id, created_at > now() as ahead, extract(epoch from (expires_at - created_at)) / 3600 as hours`,
          [clinic.staffUserId, digest(), ...values],
        ),
      );
    // Forward-dated by a year: the database dates it now, for exactly 24 hours.
    const [dated] = (await insert()).rows;
    expect(dated).toMatchObject({ ahead: false });
    expect(Number(dated!.hours)).toBe(24);
    // Arriving already claimed by a session of someone's choosing, or bound
    // to an address that is not the sign-in's: refused.
    await expect(
      insert("claimed_at, session_token_hash", [new Date(), digest()]),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      asApp((c) =>
        c.query(
          `insert into device_recoveries (user_id, token_hash, address_hash, landing, issued_by, expires_at)
           values ($1, $2, $3, '/c/x/protect', 'ops', now() + interval '24 hours')`,
          [clinic.staffUserId, digest(), digest()],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const [row] = await sql<{ id: string }>(
      `insert into device_recoveries (user_id, token_hash, address_hash, landing, issued_by, expires_at)
       values ($1, $2, app_address_hash($1), '/c/x/protect', 'ops', now() + interval '24 hours') returning id`,
      [clinic.staffUserId, digest()],
    );
    const id = row!.id;
    await expect(
      sql(
        `update device_recoveries set expires_at = expires_at + interval '1 hour' where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      sql(`update device_recoveries set address_hash = $2 where id = $1`, [id, digest()]),
    ).rejects.toMatchObject({ code: "42501" });
    // A session is named only once the link is claimed, and only once.
    await expect(
      sql(`update device_recoveries set session_token_hash = $2 where id = $1`, [id, digest()]),
    ).rejects.toMatchObject({ code: "23514" });
    await sql(`update device_recoveries set claimed_at = now() where id = $1`, [id]);
    await sql(`update device_recoveries set session_token_hash = $2 where id = $1`, [id, digest()]);
    await expect(
      sql(`update device_recoveries set session_token_hash = $2 where id = $1`, [id, digest()]),
    ).rejects.toMatchObject({ code: "42501" });
    await sql(`update device_recoveries set used_at = now() where id = $1`, [id]);
    await expect(
      sql(`update device_recoveries set used_at = null where id = $1`, [id]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  test("issue: refused without the call back; then one link, only to the clinic's address on file, and every step recorded", async () => {
    const clinic = await seedClinic("rissue");
    expect(await op("issueDeviceRecovery", { clinicId: clinic.clinicId })).toMatchObject({
      status: "refused",
    });
    expect(mocks.sent).toEqual([]);
    expect(await sql(`select 1 from device_recoveries`)).toHaveLength(0);

    const issued = await op("issueDeviceRecovery", { clinicId: clinic.clinicId, calledBack: true });
    expect(issued).toMatchObject({ status: "issued", emailed: true, replaced: 0 });
    expect(mocks.sent.map((m) => [m.to, m.kind])).toEqual([
      [clinic.staffEmail, "device_recovery_link"],
    ]);
    const token = lastLinkToken();
    const [row] = await sql<{
      token_hash: Buffer;
      landing: string;
      issued_by: string;
      hours: string;
    }>(
      `select token_hash, landing, issued_by, extract(epoch from (expires_at - created_at)) / 3600 as hours
         from device_recoveries`,
    );
    expect(Buffer.from(row!.token_hash).equals(createHash("sha256").update(token).digest())).toBe(
      true,
    );
    expect(row!.landing).toBe(`/c/${clinic.slug}/protect`);
    expect(row!.issued_by).toBe("ops@healdesk.test");
    expect(Number(row!.hours)).toBe(24);

    expect(await events("device_recovery_issued")).toEqual([
      {
        actor_label: "ops@healdesk.test",
        user_id: clinic.staffUserId,
        metadata: {
          recoveryId: issued.recoveryId,
          clinicId: clinic.clinicId,
          calledBack: true,
          validHours: 24,
        },
      },
    ]);
    expect((await events("device_recovery_link_sent"))[0]!.metadata).toEqual({
      recoveryId: issued.recoveryId,
      status: "sent",
    });

    const view = await op("getClinicDevices", { clinicId: clinic.clinicId });
    expect(view).toMatchObject({
      hasSignIn: true,
      devices: [],
      patientDataMayExist: false,
      recoveries: [{ id: issued.recoveryId, state: "open", issuedBy: "ops@healdesk.test" }],
    });
  });

  /**
   * Clinic names are capped when typed but never held to the email rule for
   * a clinic's name, which refuses an "@". Before 19 October 2026's fix the
   * send-time check refused O16 for good, a lockout, and the console was told
   * to try again in a minute.
   */
  test("a clinic whose name the email rule refuses still gets its link, without the name", async () => {
    const clinic = await seedClinic("rissue-at");
    await sql(`update clinics set name = $1 where id = $2`, ["Glow @ Main Street Med Spa", clinic.clinicId]);
    const issued = await op("issueDeviceRecovery", { clinicId: clinic.clinicId, calledBack: true });
    expect(issued).toMatchObject({ status: "issued", emailed: true });
    expect(mocks.sent.map((m) => [m.to, m.kind])).toEqual([[clinic.staffEmail, "device_recovery_link"]]);
    expect(mocks.sent[0]!.text).not.toContain("@ Main Street");
    expect(mocks.sent[0]!.text).toContain("your practice");
  });

  test("a second link replaces the first, which then works no more", async () => {
    const clinic = await seedClinic("rreplace");
    const first = await issue(clinic);
    const second = await issue(clinic);
    expect(await lookUpDeviceRecovery(first)).toEqual({ ok: false, reason: "ended" });
    expect(await lookUpDeviceRecovery(second)).toMatchObject({ ok: true });
    expect((await events("device_recovery_revoked"))[0]!.metadata).toMatchObject({
      reason: "replaced",
    });
    expect(await postLink(first, second)).toBe(`/recover/${first}`);
    expect(await sessionsOf(clinic.staffUserId)).toHaveLength(0);
  });

  test("the link: its page spends nothing; its POST signs in and lands on the Protect page, once", async () => {
    const clinic = await seedClinic("rclaim");
    const token = await issue(clinic);
    for (let i = 0; i < 2; i += 1) {
      expect(await lookUpDeviceRecovery(token)).toMatchObject({
        ok: true,
        userId: clinic.staffUserId,
        emailMasked: "r•••@example-clinic.test",
      });
    }
    expect(await sessionsOf(clinic.staffUserId)).toHaveLength(0);

    expect(await postLink(token)).toBe(`/c/${clinic.slug}/protect`);
    const sessions = await sessionsOf(clinic.staffUserId);
    expect(sessions).toHaveLength(1);
    const [claimed] = await sql<{ session_token_hash: Buffer }>(
      `select session_token_hash from device_recoveries`,
    );
    expect(
      Buffer.from(claimed!.session_token_hash).equals(hashSessionToken(sessions[0]!.token)),
    ).toBe(true);
    expect(await events("device_recovery_claimed")).toHaveLength(1);

    // Used: the page says so, and a second POST signs nobody in.
    expect(await lookUpDeviceRecovery(token)).toEqual({ ok: false, reason: "used" });
    const stale = await RecoverPage({ params: Promise.resolve({ token }) });
    expect(formAction(stale)).toBeNull();
    expect(renderToStaticMarkup(stale)).toContain("This link has already been used.");
    const fresh = await issue(await seedClinic("rclaim-other"));
    expect(await postLink(token, fresh)).toBe(`/recover/${token}`);
    expect(await sessionsOf(clinic.staffUserId)).toHaveLength(1);
  });

  test("after go-live, the session the link started may add one device, once; O3 says how it was added", async () => {
    const clinic = await seedClinic("ruse");
    await goLive(clinic.clinicId);
    const token = await issue(clinic);
    await postLink(token);
    const [s] = await sessionsOf(clinic.staffUserId);
    const session = { userId: clinic.staffUserId, sessionTokenHash: hashSessionToken(s!.token) };

    expect(await passkeyEnrolDecision(clinic.staffUserId, session.sessionTokenHash)).toMatchObject({
      allowed: true,
      basis: "recovery",
    });
    // Two tabs, two challenges on the one link.
    const tabA = await startPasskeyRegistration({ session });
    const tabB = await startPasskeyRegistration({ session });
    if (!tabA.ok || !tabB.ok) throw new Error("both tabs should have been offered the link");
    expect([tabA.basis, tabB.basis]).toEqual(["recovery", "recovery"]);

    mocks.sent.length = 0;
    expect(await finish(session, tabA.options.challenge, "Front desk Mac")).toMatchObject({
      ok: true,
      deviceLabel: "Front desk Mac",
    });
    // The other tab's passkey is refused: the link was spent on the first.
    expect(await finish(session, tabB.options.challenge, "Back office PC")).toEqual({
      ok: false,
      reason: "needs_step_up",
    });
    const stored = await passkeys(clinic.staffUserId);
    expect(stored.map((p) => p.device_label)).toEqual(["Front desk Mac"]);

    const [used] = await sql<{ factor_id: string; used_at: Date | null }>(
      `select factor_id, used_at from device_recoveries`,
    );
    expect(used!.factor_id).toBe(stored[0]!.id);
    const [added] = await events("passkey_added");
    expect(added!.metadata).toMatchObject({ basis: "recovery", factorId: stored[0]!.id });
    expect((await events("device_recovery_used"))[0]!.metadata).toMatchObject({
      factorId: stored[0]!.id,
    });

    // O3, to the address, saying the device came by the link.
    expect(mocks.sent.map((m) => [m.to, m.kind])).toEqual([[clinic.staffEmail, "device_changed"]]);
    expect(mocks.sent[0]!.text).toContain("“Front desk Mac” was added");
    expect(mocks.sent[0]!.text).toContain("with the one-time link healdesk emailed");

    // Spent: with the step-up the new passkey made ended, the session has no basis left.
    await sql(`update step_ups set revoked_at = now() where user_id = $1`, [clinic.staffUserId]);
    expect(await passkeyEnrolDecision(clinic.staffUserId, session.sessionTokenHash)).toEqual({
      allowed: false,
      codeRoute: false,
      hasPasskey: true,
    });
  });

  test("only for that clinic's sign-in, and only for the session that used it", async () => {
    const mine = await seedClinic("rmine");
    const theirs = await seedClinic("rtheirs");
    await goLive(mine.clinicId);
    await goLive(theirs.clinicId);
    const token = await issue(mine);

    // Claimed, it can be bound only to a session of this clinic's sign-in:
    // another clinic's session gets nothing from it.
    const claimed = await claimDeviceRecovery({ token });
    if (!claimed.ok) throw new Error(claimed.reason);
    expect(claimed.userId).toBe(mine.staffUserId);
    const stranger = await startSession(theirs.staffUserId);
    expect(
      await bindDeviceRecovery({ recoveryId: claimed.recoveryId, sessionId: stranger.id }),
    ).toBe(false);
    expect(
      await passkeyEnrolDecision(theirs.staffUserId, stranger.binding.sessionTokenHash),
    ).toMatchObject({ allowed: false });
    const browser = await startSession(mine.staffUserId);
    expect(
      await bindDeviceRecovery({ recoveryId: claimed.recoveryId, sessionId: browser.id }),
    ).toBe(true);
    // Once only: not to a second session after it.
    const other = await startSession(mine.staffUserId);
    expect(await bindDeviceRecovery({ recoveryId: claimed.recoveryId, sessionId: other.id })).toBe(
      false,
    );
    expect(await liveDeviceRecovery(unsafeDb, browser.binding)).not.toBeNull();

    // Another session of the same sign-in (a second link, another browser)
    // gets nothing from it.
    expect(await passkeyEnrolDecision(mine.staffUserId, other.binding.sessionTokenHash)).toEqual({
      allowed: false,
      codeRoute: false,
      hasPasskey: false,
    });
    expect(await startPasskeyRegistration({ session: other.binding })).toEqual({
      ok: false,
      reason: "no_device",
    });
  });

  test("only within its window: a lapsed link signs nobody in, and a claimed one adds nothing once its window has passed", async () => {
    const clinic = await seedClinic("rwindow");
    await goLive(clinic.clinicId);
    // A page to submit from: another clinic's link, still open.
    const elsewhere = await issue(await seedClinic("rwindow-other"));
    const lapsed = await issue(clinic);
    await lapse(clinic.staffUserId);
    expect(await lookUpDeviceRecovery(lapsed)).toEqual({ ok: false, reason: "expired" });
    expect(await postLink(lapsed, elsewhere)).toBe(`/recover/${lapsed}`);
    expect(await sessionsOf(clinic.staffUserId)).toHaveLength(0);
    expect(
      renderToStaticMarkup(await RecoverPage({ params: Promise.resolve({ token: lapsed }) })),
    ).toContain("This link has expired.");

    await sql(
      `update device_recoveries set revoked_at = now(), revoked_reason = 'replaced' where user_id = $1`,
      [clinic.staffUserId],
    );
    const token = await issue(clinic);
    await postLink(token);
    const [s] = await sessionsOf(clinic.staffUserId);
    const session = { userId: clinic.staffUserId, sessionTokenHash: hashSessionToken(s!.token) };
    const started = await startPasskeyRegistration({ session });
    if (!started.ok) throw new Error(started.reason);

    // The window passes between the challenge and the passkey.
    await lapse(clinic.staffUserId);
    expect(await finish(session, started.options.challenge, "Front desk Mac")).toEqual({
      ok: false,
      reason: "needs_step_up",
    });
    expect(await passkeys(clinic.staffUserId)).toEqual([]);
    expect(await passkeyEnrolDecision(clinic.staffUserId, session.sessionTokenHash)).toMatchObject({
      allowed: false,
    });
  });

  test("the operator ends an open link unused; it then says so", async () => {
    const clinic = await seedClinic("rend");
    const token = await issue(clinic);
    expect(await op("endDeviceRecovery", { clinicId: clinic.clinicId })).toEqual({
      status: "ended",
      browsersSignedOut: 0,
    });
    expect(await op("endDeviceRecovery", { clinicId: clinic.clinicId })).toEqual({
      status: "none",
    });
    expect(await lookUpDeviceRecovery(token)).toEqual({ ok: false, reason: "ended" });
    expect((await events("device_recovery_revoked"))[0]).toMatchObject({
      actor_label: "ops@healdesk.test",
      metadata: { reason: "operator_ended", clinicId: clinic.clinicId },
    });
  });

  test("ending or replacing a link a browser has opened signs that browser out, and ends its step-ups", async () => {
    const clinic = await seedClinic("rendclaimed");
    const device = await seedPasskey(clinic.staffUserId, "Front desk Mac");
    const signedIn = await startSession(clinic.staffUserId);
    await postLink(await issue(clinic));
    const [, claimer] = await sessionsOf(clinic.staffUserId);
    // A step-up on that browser from another device, which must end with it.
    await sql(
      `insert into step_ups (session_token_hash, user_id, factor_id, device_label) values ($1, $2, $3, 'Front desk Mac')`,
      [hashSessionToken(claimer!.token), clinic.staffUserId, device],
    );
    expect(await op("endDeviceRecovery", { clinicId: clinic.clinicId })).toEqual({
      status: "ended",
      browsersSignedOut: 1,
    });
    expect((await sessionsOf(clinic.staffUserId)).map((x) => x.id)).toEqual([signedIn.id]);
    expect(
      await sql(`select 1 from step_ups where session_token_hash = $1 and revoked_at is null`, [
        hashSessionToken(claimer!.token),
      ]),
    ).toEqual([]);
    expect((await events("device_recovery_revoked"))[0]!.metadata).toMatchObject({
      reason: "operator_ended",
      browsersSignedOut: 1,
    });

    // Replaced: a newer link ends the claimed one's browser the same way.
    await postLink(await issue(clinic));
    expect(await sessionsOf(clinic.staffUserId)).toHaveLength(2);
    await lapse(clinic.staffUserId);
    await issue(clinic);
    expect((await sessionsOf(clinic.staffUserId)).map((x) => x.id)).toEqual([signedIn.id]);
    expect((await events("device_recovery_revoked")).at(-1)!.metadata).toMatchObject({
      reason: "replaced",
      browsersSignedOut: 1,
    });
  });

  describe("the address it was sent to", () => {
    test("no link is issued while a change of the address is open, and the console is told why", async () => {
      const clinic = await seedClinic("raddropen");
      expect(
        await op("changeClinicEmail", {
          clinicId: clinic.clinicId,
          newEmail: "front@radiance.test",
        }),
      ).toMatchObject({ status: "entered" });
      mocks.sent.length = 0;
      const refused = await op("issueDeviceRecovery", {
        clinicId: clinic.clinicId,
        calledBack: true,
      });
      expect(refused).toMatchObject({ status: "refused" });
      expect(String(refused.message)).toContain("the address on file is the one being retired");
      expect(mocks.sent).toEqual([]);
      expect(await sql(`select 1 from device_recoveries`)).toEqual([]);
      expect((await events("device_recovery_issue_refused"))[0]).toMatchObject({
        actor_label: "ops@healdesk.test",
        user_id: clinic.staffUserId,
        metadata: { code: "address_changing", clinicId: clinic.clinicId },
      });
      expect(await op("getClinicDevices", { clinicId: clinic.clinicId })).toMatchObject({
        addressChangeOpen: true,
      });

      // Stopped, a link can be sent again.
      await op("stopClinicEmailChange", { clinicId: clinic.clinicId });
      expect(await op("getClinicDevices", { clinicId: clinic.clinicId })).toMatchObject({
        addressChangeOpen: false,
      });
      await issue(clinic);
    });

    test("starting a change ends an open link, and the browser that had opened it", async () => {
      const clinic = await seedClinic("raddrstart");
      const unclaimed = await issue(clinic);
      expect(
        await op("changeClinicEmail", {
          clinicId: clinic.clinicId,
          newEmail: "front@radiance.test",
        }),
      ).toMatchObject({ status: "entered" });
      expect(await lookUpDeviceRecovery(unclaimed)).toEqual({ ok: false, reason: "ended" });
      await op("stopClinicEmailChange", { clinicId: clinic.clinicId });

      await postLink(await issue(clinic));
      expect(await sessionsOf(clinic.staffUserId)).toHaveLength(1);
      await op("changeClinicEmail", { clinicId: clinic.clinicId, newEmail: "desk@radiance.test" });
      expect(await sessionsOf(clinic.staffUserId)).toHaveLength(0);
      const [row] = await sql<{ revoked_reason: string }>(
        `select revoked_reason from device_recoveries order by created_at desc limit 1`,
      );
      expect(row!.revoked_reason).toBe("address_changed");
      expect((await events("device_recovery_revoked")).at(-1)!.metadata).toMatchObject({
        reason: "address_changed",
        browsersSignedOut: 1,
      });
    });

    test("applying a change ends any link still open for the old address, and says so", async () => {
      const clinic = await seedClinic("raddrapply");
      const entered = await op("changeClinicEmail", {
        clinicId: clinic.clinicId,
        newEmail: "front@radiance.test",
      });
      // A link minted for the old address some way the app never would.
      const [link] = await sql<{ id: string }>(
        `insert into device_recoveries (user_id, token_hash, address_hash, landing, issued_by, expires_at)
         values ($1, $2, app_address_hash($1), $3, 'ops', now() + interval '24 hours') returning id`,
        [
          clinic.staffUserId,
          createHash("sha256").update(randomBytes(16)).digest(),
          `/c/${clinic.slug}/protect`,
        ],
      );
      await inTenant(clinic.clinicId, (c) =>
        c.query(
          `update sign_in_address_changes
              set effective_at = now() - interval '1 minute', confirmed_at = now() - interval '73 hours'
            where id = $1`,
          [entered.changeId],
        ),
      );
      expect((await runAddressChangesJob()).applied).toBe(1);
      const [row] = await sql<{ revoked_reason: string }>(
        `select revoked_reason from device_recoveries where id = $1`,
        [link!.id],
      );
      expect(row!.revoked_reason).toBe("address_changed");
      expect((await events("sign_in_address_changed"))[0]!.metadata).toMatchObject({
        recoveriesRevoked: 1,
        recoveryIds: [link!.id],
      });
    });

    test("a link whose address moved neither signs in nor adds a device, and its refusal is recorded", async () => {
      const clinic = await seedClinic("raddrmoved");
      await goLive(clinic.clinicId);
      const unclaimed = await issue(clinic);
      const elsewhere = await issue(await seedClinic("raddrmoved-other"));
      // The address moves some way that ends nothing (a backstop test).
      await sql(`update "user" set email = 'moved@radiance.test' where id = $1`, [
        clinic.staffUserId,
      ]);
      expect(await lookUpDeviceRecovery(unclaimed)).toEqual({ ok: false, reason: "moved" });
      expect(await postLink(unclaimed, elsewhere)).toBe(`/recover/${unclaimed}`);
      expect(await sessionsOf(clinic.staffUserId)).toHaveLength(0);
      expect((await events("device_recovery_refused")).at(-1)!.metadata).toMatchObject({
        code: "moved",
      });
      expect(
        renderToStaticMarkup(await RecoverPage({ params: Promise.resolve({ token: unclaimed }) })),
      ).toContain("This link no longer works.");

      // Claimed before the move: the session it started adds nothing after it.
      await sql(`update "user" set email = $2 where id = $1`, [
        clinic.staffUserId,
        clinic.staffEmail,
      ]);
      await sql(
        `update device_recoveries set revoked_at = now(), revoked_reason = 'replaced' where user_id = $1 and revoked_at is null and used_at is null`,
        [clinic.staffUserId],
      );
      await postLink(await issue(clinic));
      const [s] = await sessionsOf(clinic.staffUserId);
      const session = { userId: clinic.staffUserId, sessionTokenHash: hashSessionToken(s!.token) };
      const started = await startPasskeyRegistration({ session });
      if (!started.ok) throw new Error(started.reason);
      await sql(`update "user" set email = 'moved@radiance.test' where id = $1`, [
        clinic.staffUserId,
      ]);
      mocks.sent.length = 0;
      expect(await finish(session, started.options.challenge, "Front desk Mac")).toEqual({
        ok: false,
        reason: "needs_step_up",
      });
      expect(await passkeys(clinic.staffUserId)).toEqual([]);
      expect(mocks.sent).toEqual([]);
    });

    test("while a change is open, a claimed link adds no device, so O3 never goes to the address being retired", async () => {
      const clinic = await seedClinic("raddrretire");
      await goLive(clinic.clinicId);
      await postLink(await issue(clinic));
      const [s] = await sessionsOf(clinic.staffUserId);
      const session = { userId: clinic.staffUserId, sessionTokenHash: hashSessionToken(s!.token) };
      const started = await startPasskeyRegistration({ session });
      if (!started.ok) throw new Error(started.reason);
      await openChangeBehindTheAppsBack(clinic, "front@radiance.test");
      expect(
        await passkeyEnrolDecision(clinic.staffUserId, session.sessionTokenHash),
      ).toMatchObject({
        allowed: false,
      });
      mocks.sent.length = 0;
      expect(await finish(session, started.options.challenge, "Front desk Mac")).toEqual({
        ok: false,
        reason: "needs_step_up",
      });
      expect(await passkeys(clinic.staffUserId)).toEqual([]);
      expect(mocks.sent).toEqual([]);
    });
  });

  describe("a claim no session comes of", () => {
    test("when the link is ended between the claim and the session, the session is deleted and the page says it was stopped", async () => {
      const clinic = await seedClinic("rbindlost");
      const token = await issue(clinic);
      const original = auth.api.startLinkSession.bind(auth.api);
      const spy = vi.spyOn(auth.api, "startLinkSession").mockImplementationOnce((async (
        ...args: Parameters<typeof original>
      ) => {
        const started = await original(...args);
        // The operator presses End this link in that moment.
        await op("endDeviceRecovery", { clinicId: clinic.clinicId });
        return started;
      }) as typeof original);
      try {
        expect(await postLink(token)).toBe(`/recover/${token}`);
      } finally {
        spy.mockRestore();
      }
      expect(await sessionsOf(clinic.staffUserId)).toEqual([]);
      expect(
        renderToStaticMarkup(await RecoverPage({ params: Promise.resolve({ token }) })),
      ).toContain("This link was stopped.");
      expect((await events("device_recovery_unfinished"))[0]!.metadata).toMatchObject({
        code: "ended_meanwhile",
        sessionEnded: true,
      });
    });

    test("when no session can be started, the link stays spent, nobody is signed in, and the page says plainly a new one is needed", async () => {
      const clinic = await seedClinic("rnosession");
      const token = await issue(clinic);
      const spy = vi
        .spyOn(auth.api, "startLinkSession")
        .mockRejectedValueOnce(new Error("the session store is down"));
      try {
        expect(await postLink(token)).toBe(`/recover/${token}`);
      } finally {
        spy.mockRestore();
      }
      expect(await sessionsOf(clinic.staffUserId)).toEqual([]);
      expect(await lookUpDeviceRecovery(token)).toEqual({ ok: false, reason: "unfinished" });
      const page = renderToStaticMarkup(await RecoverPage({ params: Promise.resolve({ token }) }));
      expect(page).toContain("This link didn&#x27;t finish signing you in.");
      expect(page).toContain("it can&#x27;t be used again");
      expect((await events("device_recovery_unfinished"))[0]!.metadata).toMatchObject({
        code: "session_failed",
        sessionEnded: false,
      });
      // The console shows it opened and unfinished; the operator ends it and sends another.
      expect(await op("getClinicDevices", { clinicId: clinic.clinicId })).toMatchObject({
        recoveries: [{ state: "claimed" }],
      });
      await op("endDeviceRecovery", { clinicId: clinic.clinicId });
      await issue(clinic);
    });
  });

  test("a spent link presented again and again writes one refusal every ten minutes, not one per try", async () => {
    const clinic = await seedClinic("rthrottle");
    const token = await issue(clinic);
    await op("endDeviceRecovery", { clinicId: clinic.clinicId });
    const elsewhere = await issue(await seedClinic("rthrottle-other"));
    for (let i = 0; i < 3; i += 1) {
      expect(await postLink(token, elsewhere)).toBe(`/recover/${token}`);
    }
    expect(await events("device_recovery_refused")).toHaveLength(1);
    await sql(
      `update security_events set occurred_at = now() - interval '11 minutes' where event = 'device_recovery_refused'`,
    );
    await postLink(token, elsewhere);
    expect(await events("device_recovery_refused")).toHaveLength(2);
  });

  test("the trigger's window and the CHECK are DEVICE_RECOVERY_TTL_HOURS, the number the email states", async () => {
    const [fn] = await sql<{ src: string }>(
      `select prosrc as src from pg_proc where proname = 'app_device_recovery_guard'`,
    );
    const hours = [...fn!.src.matchAll(/interval '(\d+) hours'/g)].map((m) => Number(m[1]));
    expect(hours).toEqual([DEVICE_RECOVERY_TTL_HOURS]);
    const [check] = await sql<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'device_recoveries_window_check'`,
    );
    expect(check!.def).toContain(
      `'${String(DEVICE_RECOVERY_TTL_HOURS).padStart(2, "0")}:00:00'::interval`,
    );
    expect(DEVICE_RECOVERY_LINK_ENTRY.fixture.validHours).toBe(DEVICE_RECOVERY_TTL_HOURS);
  });

  test("an issue for a clinic there is none of is refused and recorded too", async () => {
    const nowhere = randomUUID();
    expect(await op("issueDeviceRecovery", { clinicId: nowhere, calledBack: true })).toEqual({
      status: "refused",
      message: "No such clinic.",
    });
    expect(await events("device_recovery_issue_refused")).toEqual([
      {
        actor_label: "ops@healdesk.test",
        user_id: null,
        metadata: { code: "no_clinic", clinicId: nowhere },
      },
    ]);
  });

  test("a data-only restore brings links back as they were once the guard is off, as docs/handover.md says, and not with it on", async () => {
    const handover = readFileSync(join(process.cwd(), "..", "..", "docs", "handover.md"), "utf8");
    expect(handover).toContain(
      "ALTER TABLE device_recoveries DISABLE TRIGGER device_recoveries_guard;",
    );
    expect(handover).toContain(
      "ALTER TABLE device_recoveries ENABLE TRIGGER device_recoveries_guard;",
    );

    const clinic = await seedClinic("rrestore");
    await postLink(await issue(clinic));
    await lapse(clinic.staffUserId);
    const before = await sql<Record<string, unknown>>(
      `select * from device_recoveries order by created_at`,
    );
    expect(before).toHaveLength(1);
    const columns = Object.keys(before[0]!);
    const reload = async (client: { query: (t: string, v?: unknown[]) => Promise<unknown> }) => {
      await client.query(`delete from device_recoveries`);
      for (const row of before) {
        await client.query(
          `insert into device_recoveries (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
          columns.map((c) => row[c]),
        );
      }
    };
    const client = await getMigratorPool().connect();
    try {
      // With the guard on, the claimed link is refused.
      await client.query("begin");
      await expect(reload(client)).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback");
      // The handover's steps: off by name, the load, on again.
      await client.query("begin");
      await client.query(`alter table device_recoveries disable trigger device_recoveries_guard`);
      await reload(client);
      await client.query(`alter table device_recoveries enable trigger device_recoveries_guard`);
      await client.query("commit");
    } finally {
      client.release();
    }
    expect(await sql(`select * from device_recoveries order by created_at`)).toEqual(before);
    const [enabled] = await sql<{ on: string }>(
      `select tgenabled as on from pg_trigger where tgname = 'device_recoveries_guard'`,
    );
    expect(enabled!.on).toBe("O");
  });

  describe("the Continue button, at the page, with the browser's own cookies", () => {
    // The session cookie is set inside startLinkSession, by Better Auth's
    // nextCookies plugin, which imports "next/headers.js" from inside
    // node_modules, where no test mock reaches. So each call records the
    // Set-Cookie it makes into the response it runs in, as that plugin
    // would: the value is the session's token, as Better Auth's cookie is.
    beforeAll(() => {
      const original = auth.api.startLinkSession.bind(auth.api);
      vi.spyOn(auth.api, "startLinkSession").mockImplementation((async (
        ...args: Parameters<typeof original>
      ) => {
        const started = await original(...args);
        const [row] = await sql<{ token: string }>(`select token from session where id = $1`, [
          started.sessionId,
        ]);
        jars.getStore()?.set.push({ name: SESSION_COOKIE, value: `${row!.token}.signature` });
        return started;
      }) as typeof original);
    });

    afterAll(() => {
      vi.restoreAllMocks();
    });

    test("two POSTs at once: one claims, and only its response sets a session cookie", async () => {
      const clinic = await seedClinic("rrace");
      const token = await issue(clinic);
      const a: Jar = { sent: new Map(), set: [] };
      const b: Jar = { sent: new Map(), set: [] };
      // Both tabs rendered while the link worked, then both pressed at once.
      const [tabA, tabB] = [await pageAction(token), await pageAction(token)];
      const landed = await Promise.all([submit(tabA, token, a), submit(tabB, token, b)]);
      expect([...landed].sort()).toEqual([`/c/${clinic.slug}/protect`, `/recover/${token}`].sort());
      const winner = landed[0] === `/c/${clinic.slug}/protect` ? a : b;
      const loser = winner === a ? b : a;
      expect(sessionCookiesSet(winner)).toHaveLength(1);
      expect(loser.set).toEqual([]);

      // The one session there is, the one the cookie names, holds the link.
      const sessions = await sessionsOf(clinic.staffUserId);
      expect(sessions).toHaveLength(1);
      expect(decodeURIComponent(sessionCookiesSet(winner)[0]!).split(".")[0]).toBe(
        sessions[0]!.token,
      );
      const [row] = await sql<{ session_token_hash: Buffer }>(
        `select session_token_hash from device_recoveries`,
      );
      expect(
        Buffer.from(row!.session_token_hash).equals(hashSessionToken(sessions[0]!.token)),
      ).toBe(true);
    });

    test("a losing POST never replaces the session cookie the browser already holds", async () => {
      const clinic = await seedClinic("rkeep");
      const token = await issue(clinic);
      const browser: Jar = { sent: new Map(), set: [] };
      await postLink(token, token, browser);
      const [held] = sessionCookiesSet(browser);
      expect(held).toBeDefined();

      // The same browser, a stale tab submitting the spent link: nothing set.
      const fresh = await issue(await seedClinic("rkeep-other"));
      const again: Jar = { sent: new Map([[SESSION_COOKIE, held!]]), set: [] };
      expect(await postLink(token, fresh, again)).toBe(`/recover/${token}`);
      expect(again.set).toEqual([]);
      expect(await sessionsOf(clinic.staffUserId)).toHaveLength(1);
      expect((await events("device_recovery_refused")).at(-1)!.metadata).toMatchObject({
        code: "used",
      });
    });
  });

  describe("removeClinicDevices: O3's promise", () => {
    async function fixture(label: string) {
      const clinic = await seedClinic(label);
      const keep = await seedPasskey(clinic.staffUserId, "Front desk Mac");
      const strange = await seedPasskey(clinic.staffUserId, "Unknown iPhone");
      await sql(
        `insert into user_factors (user_id, kind, secret_sealed, last_step) values ($1, 'totp', '{"v":1}'::jsonb, 0)`,
        [clinic.staffUserId],
      );
      for (let i = 0; i < 10; i += 1) {
        await sql(`insert into user_backup_codes (user_id, code_hash) values ($1, $2)`, [
          clinic.staffUserId,
          createHash("sha256").update(randomBytes(8)).digest(),
        ]);
      }
      await startSession(clinic.staffUserId);
      await startSession(clinic.staffUserId);
      return { clinic, keep, strange };
    }

    test("needs the call back; then the device named goes, every session ends, the backup resets, an open link ends, and O3 says healdesk did it", async () => {
      const { clinic, keep, strange } = await fixture("rremove");
      const link = await issue(clinic);
      mocks.sent.length = 0;

      expect(
        await op("removeClinicDevices", { clinicId: clinic.clinicId, factorIds: [strange] }),
      ).toMatchObject({ status: "refused" });
      expect(await sessionsOf(clinic.staffUserId)).toHaveLength(2);
      expect((await passkeys(clinic.staffUserId)).filter((p) => !p.revoked_at)).toHaveLength(2);

      expect(
        await op("removeClinicDevices", {
          clinicId: clinic.clinicId,
          factorIds: [strange],
          calledBack: true,
        }),
      ).toEqual({
        status: "done",
        removedDevices: 1,
        sessionsEnded: 2,
        backupReset: true,
        codesRevoked: 10,
      });
      const left = (await passkeys(clinic.staffUserId)).filter((p) => !p.revoked_at);
      expect(left.map((p) => p.id)).toEqual([keep]);
      expect(await sessionsOf(clinic.staffUserId)).toHaveLength(0);
      expect(
        await sql(
          `select 1 from user_factors where user_id = $1 and kind = 'totp' and revoked_at is null`,
          [clinic.staffUserId],
        ),
      ).toHaveLength(0);
      expect(await lookUpDeviceRecovery(link)).toEqual({ ok: false, reason: "ended" });

      const [event] = await events("operator_signed_out");
      expect(event).toMatchObject({
        actor_label: "ops@healdesk.test",
        user_id: clinic.staffUserId,
        metadata: {
          clinicId: clinic.clinicId,
          calledBack: true,
          factorIds: [strange],
          devicesRemoved: 1,
          sessionsEnded: 2,
          recoveriesRevoked: 1,
        },
      });
      expect(mocks.sent.map((m) => [m.to, m.kind])).toEqual([
        [clinic.staffEmail, "device_changed"],
      ]);
      expect(mocks.sent[0]!.text).toContain("at your clinic's request and after calling it back");
    });

    test("a device that is not this sign-in's stops the whole action", async () => {
      const { clinic } = await fixture("rremove-own");
      const other = await fixture("rremove-other");
      expect(
        await op("removeClinicDevices", {
          clinicId: clinic.clinicId,
          factorIds: [other.strange],
          calledBack: true,
        }),
      ).toMatchObject({ status: "refused" });
      expect(await sessionsOf(clinic.staffUserId)).toHaveLength(2);
      expect((await passkeys(other.clinic.staffUserId)).filter((p) => !p.revoked_at)).toHaveLength(
        2,
      );
      expect(await events("operator_signed_out")).toEqual([]);
      expect((await events("operator_sign_out_refused")).map((e) => e.metadata)).toEqual([
        { code: "not_this_sign_in", clinicId: clinic.clinicId },
      ]);
    });
  });

  test("the clinic's own Someone left ends an open link too", async () => {
    const clinic = await seedClinic("rleft");
    const device = await seedPasskey(clinic.staffUserId, "Front desk Mac");
    const { binding } = await startSession(clinic.staffUserId);
    await sql(
      `insert into step_ups (session_token_hash, user_id, factor_id, device_label) values ($1, $2, $3, 'Front desk Mac')`,
      [binding.sessionTokenHash, clinic.staffUserId, device],
    );
    const link = await issue(clinic);
    expect(await someoneLeft({ session: binding, removeFactorIds: [] })).toMatchObject({
      ok: true,
    });
    expect(await lookUpDeviceRecovery(link)).toEqual({ ok: false, reason: "ended" });
    const [row] = await sql<{ revoked_reason: string }>(
      `select revoked_reason from device_recoveries`,
    );
    expect(row!.revoked_reason).toBe("someone_left");
  });

  test("the paying browser, for its seven days, may add the sign-in's first passkey ever after go-live; no other browser may, and never once one has existed", async () => {
    const clinic = await seedClinic("rpaid");
    await goLive(clinic.clinicId);
    const { binding } = await startSession(clinic.staffUserId);

    expect(await passkeyEnrolDecision(clinic.staffUserId, binding.sessionTokenHash)).toEqual({
      allowed: false,
      codeRoute: false,
      hasPasskey: false,
    });
    expect(
      await passkeyEnrolDecision(clinic.staffUserId, binding.sessionTokenHash, undefined, {
        payingBrowser: true,
      }),
    ).toEqual({ allowed: true, basis: "paying_browser" });

    const started = await startPasskeyRegistration({ session: binding, payingBrowser: true });
    if (!started.ok) throw new Error(started.reason);
    expect(started.basis).toBe("paying_browser");
    // The cookie gone by the time the passkey comes back: refused.
    expect(await finish(binding, started.options.challenge, "Mac")).toEqual({
      ok: false,
      reason: "needs_step_up",
    });
    const again = await startPasskeyRegistration({ session: binding, payingBrowser: true });
    if (!again.ok) throw new Error(again.reason);
    mocks.sent.length = 0;
    expect(
      await finish(binding, again.options.challenge, "Mac", { payingBrowser: true }),
    ).toMatchObject({ ok: true });
    // The first, in the browser that paid: no device email (Annex X5, O3).
    expect(mocks.sent).toEqual([]);

    // Removed again, the window does not reopen: "first ever".
    await sql(`update user_factors set revoked_at = now() where user_id = $1`, [
      clinic.staffUserId,
    ]);
    const later = await startSession(clinic.staffUserId);
    expect(
      await passkeyEnrolDecision(clinic.staffUserId, later.binding.sessionTokenHash, undefined, {
        payingBrowser: true,
      }),
    ).toMatchObject({ allowed: false, hasPasskey: false });
  });

  test("the account page's read: devices by name, the backup, open sessions, and whether a link alone can add one", async () => {
    const clinic = await seedClinic("rview");
    await seedPasskey(clinic.staffUserId, "Front desk Mac");
    await startSession(clinic.staffUserId);
    await goLive(clinic.clinicId);
    const view = await op("getClinicDevices", { clinicId: clinic.clinicId });
    expect(view).toMatchObject({
      clinicId: clinic.clinicId,
      hasSignIn: true,
      devices: [{ label: "Front desk Mac", lastUsedAt: null }],
      hasBackup: false,
      backupCodesLeft: 0,
      sessions: 1,
      patientDataMayExist: true,
      recoveries: [],
    });
    expect(JSON.stringify(view)).not.toMatch(/token|@example-clinic/);
    expect(await op("getClinicDevices", { clinicId: randomUUID() })).toBeUndefined();
  });
});
