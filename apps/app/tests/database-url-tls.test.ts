import { parse } from "pg-connection-string";
import { afterEach, describe, expect, test, vi } from "vitest";

import { env } from "@/lib/env";
import { getBoss } from "@/lib/queue/boss";

/**
 * A production database URL must ask for verified TLS (src/lib/env.ts,
 * requireVerifiedTls). The URL is the only place TLS is decided for pg-boss,
 * so a URL without sslmode=verify-full either connects the worker's queue in
 * plaintext or accepts any certificate, and nothing else in the process
 * would notice. These pin the refusal, its silence about the value, and the
 * two places it must stay out of the way: `next build` and anything that is
 * not production.
 */

const PASSWORD = "s3cret-pass-word";
const HOST = "healdesk-production.abc123.us-east-1.rds.amazonaws.com";
const BASE = `postgresql://healdesk_app:${PASSWORD}@${HOST}:5432/healdesk`;
const BUNDLE = "sslrootcert=/etc/ssl/rds/us-east-1-bundle.pem";

function inProduction(url: string): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PHASE", "");
  vi.stubEnv("DATABASE_URL", url);
}

/** The thrown message, which must name the variable and nothing of its value. */
function refusal(): string {
  try {
    env.databaseUrl();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("env.databaseUrl() accepted the URL");
}

describe("DATABASE_URL in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("accepts sslmode=verify-full, with or without the CA bundle beside it", () => {
    for (const url of [
      `${BASE}?sslmode=verify-full`,
      `${BASE}?sslmode=verify-full&${BUNDLE}`,
      `${BASE}?${BUNDLE}&sslmode=verify-full`,
      `postgres://healdesk_app:${PASSWORD}@${HOST}/healdesk?application_name=web&sslmode=verify-full`,
    ]) {
      inProduction(url);
      expect(env.databaseUrl(), url).toBe(url);
    }
  });

  test("refuses a URL with no sslmode, which leaves pg-boss in plaintext", () => {
    inProduction(`${BASE}?${BUNDLE}`);
    expect(refusal()).toMatch(/^DATABASE_URL must carry sslmode=verify-full in production/);
    inProduction(BASE);
    expect(refusal()).toMatch(/^DATABASE_URL must carry sslmode=verify-full/);
  });

  test("refuses every weaker sslmode, including the ones pg 8 still verifies", () => {
    for (const mode of [
      "disable",
      "no-verify",
      "allow",
      "prefer",
      "require",
      "verify-ca",
      "VERIFY-FULL",
      "",
    ]) {
      inProduction(`${BASE}?sslmode=${mode}&${BUNDLE}`);
      expect(refusal(), mode).toMatch(/^DATABASE_URL must carry sslmode=verify-full/);
    }
  });

  test("refuses a repeated sslmode unless every copy says verify-full, because pg keeps the last", () => {
    inProduction(`${BASE}?sslmode=verify-full&sslmode=no-verify`);
    expect(refusal()).toMatch(/sslmode=verify-full/);
    inProduction(`${BASE}?sslmode=no-verify&sslmode=verify-full`);
    expect(refusal()).toMatch(/sslmode=verify-full/);
    inProduction(`${BASE}?sslmode=verify-full&sslmode=verify-full`);
    expect(env.databaseUrl()).toContain("sslmode=verify-full");
  });

  test("refuses what the URL parser cannot read rather than guessing", () => {
    for (const url of [
      `host=${HOST} user=healdesk_app password=${PASSWORD} sslmode=verify-full`,
      `/var/run/postgresql healdesk`,
      `//healdesk_app:${PASSWORD}@${HOST}/healdesk?sslmode=verify-full`,
    ]) {
      inProduction(url);
      expect(refusal(), url).toMatch(/^DATABASE_URL could not be read as a URL/);
    }
  });

  test("refuses a URL pg would re-encode before reading it, where the two reads can differ", () => {
    // An unencoded space or a bare % in the password makes pg-connection-string
    // re-encode the whole URL first, after which `ssl%6Dode` is no longer
    // sslmode to pg, while the URL parser on its own still decodes it to one.
    const disguised = `postgresql://healdesk_app:pass word@${HOST}/healdesk?ssl%6Dode=verify-full`;
    expect(new URL(disguised).searchParams.getAll("sslmode")).toEqual(["verify-full"]);
    expect(parse(disguised).sslmode).toBeUndefined();

    for (const url of [
      disguised,
      `postgresql://healdesk_app:pass word@${HOST}/healdesk?sslmode=verify-full`,
      `postgresql://healdesk_app:100%off@${HOST}/healdesk?sslmode=verify-full`,
      `postgresql://healdesk_app:${PASSWORD}@${HOST}/healdesk?sslmode=verify-full&x=%zz`,
    ]) {
      inProduction(url);
      expect(refusal(), url).toMatch(/^DATABASE_URL could not be read as a URL/);
    }

    // Percent-encoded, the same password is fine.
    const encoded = `postgresql://healdesk_app:${encodeURIComponent("pass word 100%off")}@${HOST}/healdesk?sslmode=verify-full`;
    inProduction(encoded);
    expect(env.databaseUrl()).toBe(encoded);
  });

  test("accepts only what pg itself reads as verify-full, with TLS on", () => {
    // pg is the reader that matters: every URL the check lets through must
    // mean sslmode=verify-full to pg-connection-string, which pg and pg-boss
    // both parse with. (No sslrootcert here: parse() would read the file.)
    for (const url of [
      `${BASE}?sslmode=verify-full`,
      `${BASE}?ssl%6Dode=verify%2Dfull`,
      `${BASE}?sslmode=verify-full&ssl=0&uselibpqcompat=true`,
      `${BASE}?sslmode=verify-full&sslmode=verify-full#sslmode=disable`,
      `postgresql://healdesk_app:${encodeURIComponent("p@ss w%rd/?#&=")}@${HOST}:5432/healdesk?sslmode=verify-full`,
    ]) {
      inProduction(url);
      expect(env.databaseUrl(), url).toBe(url);
      const read = parse(url);
      expect(read.sslmode, url).toBe("verify-full");
      expect(read.ssl, url).toEqual({});
    }
  });

  test("never puts the URL, its password or its host in the message", () => {
    for (const url of [`${BASE}?sslmode=no-verify`, BASE, `host=${HOST} password=${PASSWORD}`]) {
      inProduction(url);
      const message = refusal();
      expect(message).toContain("DATABASE_URL");
      expect(message).not.toContain(PASSWORD);
      expect(message).not.toContain(HOST);
      expect(message).not.toContain("healdesk_app");
    }
  });

  test("guards the worker's queue too, before pg-boss opens a connection", async () => {
    // pg-boss takes TLS only from the URL, so this is the client the check
    // exists for. Port 1 on localhost: if the check let it through, the
    // failure would be a refused connection, not this message.
    inProduction("postgresql://healdesk_app:x@127.0.0.1:1/healdesk?sslmode=no-verify");
    await expect(getBoss()).rejects.toThrow(/^DATABASE_URL must carry sslmode=verify-full/);
  });

  test("still says unset before anything else when there is no URL at all", () => {
    inProduction("");
    expect(refusal()).toMatch(/^DATABASE_URL is not set/);
  });

  test("stays out of `next build`, which imports every route under NODE_ENV=production", () => {
    // CI builds with its service container's plaintext URL, and the image
    // builds with a placeholder; neither connects.
    inProduction(`${BASE}?sslmode=disable`);
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    expect(env.databaseUrl()).toBe(`${BASE}?sslmode=disable`);
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    expect(refusal()).toMatch(/sslmode=verify-full/);
  });

  test("leaves development and tests alone, where local containers run without TLS", () => {
    for (const mode of ["development", "test"]) {
      vi.stubEnv("NODE_ENV", mode);
      vi.stubEnv(
        "DATABASE_URL",
        "postgres://healdesk_app:ci@localhost:5432/healdesk_test?sslmode=disable",
      );
      expect(env.databaseUrl(), mode).toContain("sslmode=disable");
    }
  });
});
