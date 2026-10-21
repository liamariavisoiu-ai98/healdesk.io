import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  GOOGLE_CALENDAR_DISCLOSURE,
  GOOGLE_CALENDAR_DISCLOSURE_DPA,
  googleCalendarDisclosureSha256,
  renderGoogleCalendarDisclosure,
  type GoogleCalendarDisclosure,
} from "@healdesk/catalog";
import { FAKE_GOOGLE_CLIENT } from "@healdesk/connectors";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import type { EmailToSend } from "@/lib/email/send";
import { effectiveBookingMode } from "@/lib/booking/mode";
import { calendarLinkPage, issueCalendarLink } from "@/lib/connections/calendar-links";
import { getCalendarConnection } from "@/lib/connections/google-calendar";
import { beginGoogleSignIn, GoogleConnectError } from "@/lib/connections/google-oauth";
import { readCalendarCard } from "@/lib/portal/settings-calendar";
import { calendarStep } from "@/lib/setup/calendar";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import {
  inTenant,
  seedCalendarTerms,
  seedClinic,
  seedGoogleConnection,
  type SeededClinic,
} from "./setup/factories";

/**
 * The Google Calendar notice is shown, ticked and recorded in the practice's
 * own wording (packages/catalog/src/google-calendar-disclosure.ts, released
 * with the Data Protection Agreement on 20 October 2026). A practice under the
 * BAA keeps the wording, version and hash it always had; a practice under the
 * DPA is never told healdesk signs business associate agreements for it, and
 * a vet's never calls a person a patient. Each surface that shows the notice
 * (setup's calendar step, Settings → Calendar, the /calendar/<token> page)
 * and the acceptance that records it read one reader
 * (lib/connections/calendar-disclosure.ts), so what was shown is what is
 * stored.
 */

const sent = vi.hoisted(() => [] as EmailToSend[]);
vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return {
    ...actual,
    sendEmail: async (email: EmailToSend) => {
      sent.push(email);
      return { status: "sent", messageId: `m-${sent.length}` };
    },
  };
});
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "calendar-disclosure-test" } as const;
const SLOW = 90_000;
const ORIGIN = "https://app.healdesk.test";
const ENV = ["BETTER_AUTH_URL", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

const BAA_SHA256 = "5b3fa42bf21ce7ab880bb869f16f19d6953f87b576f67b0c431eb8eb273387d5";

type Practice = SeededClinic & { name: string };

/** A clinic whose calendar terms let healdesk write, as the practice `kind` says. */
async function practice(
  label: string,
  kind: "baa" | "dpa-vet" | "dpa-people",
): Promise<Practice> {
  const clinic = await seedClinic(label);
  await seedCalendarTerms(clinic);
  const pool = getMigratorPool();
  if (kind === "baa") {
    await pool.query(
      `update clinics set regulatory_regime = 'hipaa-if-covered', agreement_kind = 'baa' where id = $1`,
      [clinic.clinicId],
    );
  } else if (kind === "dpa-vet") {
    await pool.query(
      `update clinics set specialty = 'veterinary', regulatory_regime = 'non-hipaa',
                          agreement_kind = 'dpa', is_covered_entity = false where id = $1`,
      [clinic.clinicId],
    );
  } else {
    await pool.query(
      `update clinics set regulatory_regime = 'hipaa-if-covered', agreement_kind = 'dpa',
                          is_covered_entity = false where id = $1`,
      [clinic.clinicId],
    );
  }
  return { ...clinic, name: `${label} Clinic` };
}

/** What each surface shows the practice, before anyone is sent to Google. */
async function shown(clinic: Practice): Promise<GoogleCalendarDisclosure[]> {
  const step = await calendarStep({ id: clinic.clinicId, name: clinic.name }, { actor: ACTOR });
  if (step.kind !== "google") throw new Error(`setup's calendar step is ${step.kind}`);
  const card = await readCalendarCard({
    slug: clinic.slug,
    clinicId: clinic.clinicId,
    clinicName: clinic.name,
    settings: { bookingSystem: "google_calendar", autoConfirmBookings: true, bookingDetail: "generic" },
    actor: ACTOR,
  });
  const before = sent.length;
  expect((await issueCalendarLink(clinic.clinicId, { reason: "ops", rule: "useful" })).status).toBe(
    "issued",
  );
  const token = /\/calendar\/([A-Za-z0-9_-]{43})/.exec(sent.slice(before).at(-1)!.text)![1]!;
  const page = await calendarLinkPage(token);
  if (page.state !== "connect") throw new Error(`the link page is ${page.state}`);
  return [step.disclosure, card.disclosure, page.disclosure];
}

/** Ticked on `version`: the state row's version and hash, or the refusal's code. */
async function accept(clinic: Practice, version: string) {
  try {
    await beginGoogleSignIn({
      clinicId: clinic.clinicId,
      via: { kind: "portal", userId: clinic.staffUserId, returnTo: "portal" },
      disclosureVersion: version,
      actor: { type: "user", userId: clinic.staffUserId, label: "clinic portal" },
    });
  } catch (error) {
    if (error instanceof GoogleConnectError) return error.code;
    throw error;
  }
  const { rows } = await getMigratorPool().query<{ version: string; sha: string }>(
    `select disclosure_version as version, encode(disclosure_sha256, 'hex') as sha
       from google_oauth_states where target_clinic_id = $1
      order by created_at desc limit 1`,
    [clinic.clinicId],
  );
  return rows[0]!;
}

async function acceptedVersions(clinicId: string): Promise<unknown[]> {
  return inTenant(clinicId, async (client) =>
    (
      await client.query<{ version: unknown }>(
        `select metadata->>'version' as version from audit_log
          where clinic_id = $1 and metadata->>'event' = 'calendar_disclosure_accepted'`,
        [clinicId],
      )
    ).rows.map((r) => r.version),
  );
}

describeDb("the Google Calendar notice, in the practice's own wording", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    for (const key of ENV) saved[key] = process.env[key];
    process.env.BETTER_AUTH_URL = ORIGIN;
    process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
  }, 60_000);

  afterAll(async () => {
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await closePools();
  });

  test(
    "a practice under the BAA is shown, and records, the BAA's wording, with its version and hash unchanged",
    async () => {
      {
        const clinic = await practice("cd-baa", "baa");
        const expected = renderGoogleCalendarDisclosure({ clinicName: clinic.name });
        for (const disclosure of await shown(clinic)) {
          expect(disclosure).toEqual(expected);
          expect(disclosure.version).toBe("google-calendar-disclosure/1");
          expect(disclosure.paragraphs[3]).toContain(
            "under business associate agreements with healdesk that are signed before any patient's information is processed",
          );
        }
        expect(await accept(clinic, GOOGLE_CALENDAR_DISCLOSURE_DPA.patients.version)).toBe("disclosure");
        expect(await accept(clinic, GOOGLE_CALENDAR_DISCLOSURE.version)).toEqual({
          version: "google-calendar-disclosure/1",
          sha: BAA_SHA256,
        });
        expect(googleCalendarDisclosureSha256(GOOGLE_CALENDAR_DISCLOSURE)).toBe(BAA_SHA256);
        expect(await acceptedVersions(clinic.clinicId)).toEqual(["google-calendar-disclosure/1"]);
      }
      // A clinic from before agreement_kind, with none recorded, reads as the BAA's.
      const legacy = await practice("cd-legacy", "baa");
      await getMigratorPool().query(`update clinics set agreement_kind = null where id = $1`, [
        legacy.clinicId,
      ]);
      expect((await shown(legacy)).map((d) => d.version)).toEqual([
        "google-calendar-disclosure/1",
        "google-calendar-disclosure/1",
        "google-calendar-disclosure/1",
      ]);
    },
    SLOW,
  );

  test(
    "a vet under the DPA is shown and records the DPA's client wording, which never calls a person a patient",
    async () => {
      const vet = await practice("cd-vet", "dpa-vet");
      const expected = renderGoogleCalendarDisclosure(
        { clinicName: vet.name },
        GOOGLE_CALENDAR_DISCLOSURE_DPA.clients,
      );
      for (const disclosure of await shown(vet)) {
        expect(disclosure).toEqual(expected);
        expect(disclosure.version).toBe("google-calendar-disclosure-dpa-clients/1");
        const words = [disclosure.heading, ...disclosure.paragraphs, disclosure.tickLabel].join(" ");
        expect(words).not.toMatch(/\bpatients?\b/i);
        expect(words).not.toMatch(/business associate/i);
        expect(words).toContain("Your data protection agreement with healdesk requires healdesk");
        expect(words).toContain("When your assistant offers a client times");
      }
      // The BAA's version, ticked on a page the vet was never shown, is refused.
      expect(await accept(vet, GOOGLE_CALENDAR_DISCLOSURE.version)).toBe("disclosure");
      expect(await accept(vet, GOOGLE_CALENDAR_DISCLOSURE_DPA.patients.version)).toBe("disclosure");
      expect(await accept(vet, GOOGLE_CALENDAR_DISCLOSURE_DPA.clients.version)).toEqual({
        version: "google-calendar-disclosure-dpa-clients/1",
        sha: googleCalendarDisclosureSha256(GOOGLE_CALENDAR_DISCLOSURE_DPA.clients),
      });
      expect(await acceptedVersions(vet.clinicId)).toEqual(["google-calendar-disclosure-dpa-clients/1"]);

      // A connection accepted under it books: it is not an outdated notice.
      const { connectionId } = await seedGoogleConnection(vet.clinicId);
      await inTenant(vet.clinicId, (client) =>
        client.query(
          `update provider_connections
              set metadata = jsonb_set(metadata, '{disclosureVersion}', to_jsonb($2::text))
            where id = $1`,
          [connectionId, GOOGLE_CALENDAR_DISCLOSURE_DPA.clients.version],
        ),
      );
      expect(await getCalendarConnection(vet.clinicId)).toMatchObject({ disclosureCurrent: true });
      const mode = await effectiveBookingMode(vet.clinicId, { actor: ACTOR });
      expect(mode.reasons.map((r) => r.code)).not.toContain("calendar_disclosure_outdated");
    },
    SLOW,
  );

  test(
    "a practice under the DPA whose patients are people gets the DPA's wording, in its own word",
    async () => {
      const spa = await practice("cd-dpa-spa", "dpa-people");
      for (const disclosure of await shown(spa)) {
        expect(disclosure.version).toBe("google-calendar-disclosure-dpa-patients/1");
        expect(disclosure.paragraphs[3]).toContain("When your assistant offers a patient times");
        expect(disclosure.paragraphs.join(" ")).not.toMatch(/business associate/i);
      }
      expect(await accept(spa, GOOGLE_CALENDAR_DISCLOSURE.version)).toBe("disclosure");
      expect(await accept(spa, GOOGLE_CALENDAR_DISCLOSURE_DPA.patients.version)).toEqual({
        version: "google-calendar-disclosure-dpa-patients/1",
        sha: googleCalendarDisclosureSha256(GOOGLE_CALENDAR_DISCLOSURE_DPA.patients),
      });
    },
    SLOW,
  );
});

describe("one reader chooses the notice", () => {
  /** Every source file under src/, read as text. */
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory()
        ? sources(path)
        : /\.tsx?$/.test(name)
          ? [path]
          : [];
    });
  }

  test("nothing in apps/app renders the notice, or records an acceptance, but through the practice's wording", () => {
    const root = join(process.cwd(), "src");
    const users = sources(root)
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return /renderGoogleCalendarDisclosure\(|GOOGLE_CALENDAR_DISCLOSURE\b(?!_)/.test(text);
      })
      .map((path) => path.slice(root.length + 1));
    expect(users).toEqual(["lib/connections/calendar-disclosure.ts"]);
  });
});
