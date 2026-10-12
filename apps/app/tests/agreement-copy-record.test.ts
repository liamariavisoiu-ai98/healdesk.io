import { randomUUID } from "node:crypto";

import {
  assentSentence,
  currentBaaTemplate,
  prepareBaa,
  type BaaVariables,
} from "@healdesk/catalog";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { unsafeDb } from "@/db";
import { baaAcceptances } from "@/db/schema";
import {
  deliverSignedCopy,
  listCopyDeliveries,
  type SignedCopyDelivery,
} from "@/lib/agreements";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";

/**
 * What the database ends up holding about a delivered copy.
 *
 * The PDF has its own suite and the mail format has another; neither of them
 * touches the part that would be read out in a dispute. That part is three
 * facts and their relationship to each other:
 *
 *   1. **`copy_sent_at` is stamped by Postgres.** It sits beside `accepted_at`
 *      in the ops panel and would sit beside it in front of a regulator, and
 *      `accepted_at` is `defaultNow()`. An application-side `new Date()` would
 *      let a skewed container clock decide whether the copy went out before the
 *      signature it is a copy of. The test below moves the PROCESS clock years
 *      into the future and requires the stored date not to follow it, which is
 *      the only way to tell the two clocks apart on one machine.
 *
 *   2. **The first delivery is not overwritten.** drizzle/0025 raises on any
 *      attempt to change `copy_sent_at` or `copy_document_sha256`, so a resend
 *      written as a plain UPDATE would turn a mail that went out into a failure
 *      report. The `is null` predicate is what keeps a resend idempotent.
 *
 *   3. **A resend's digest is still findable.** Because of (2) the row cannot
 *      hold it, so it lives in security_events and `listCopyDeliveries` is the
 *      supported way to get at it. A digest nobody can find is not evidence.
 *
 * The transport is mocked out. It is a different slice with its own tests, and
 * a copy record is not a thing about SMTP: what matters here is what was
 * written down about a send, not how the send was made.
 */

const transport = vi.hoisted(() => ({
  calls: [] as { to: string; bytes: number }[],
  /** Swapped per test; the shape is AgreementCopyResult. */
  result: { sent: true, status: "sent" } as {
    sent: boolean;
    status: string;
    reason?: string;
  },
}));

vi.mock("@/lib/email/agreement-copy", () => ({
  sendAgreementCopy: async (request: { to: string; pdf: Uint8Array }) => {
    transport.calls.push({ to: request.to, bytes: request.pdf.byteLength });
    return transport.result;
  },
}));

const describeDb = hasTestDatabase ? describe : describe.skip;

const VARS: BaaVariables = {
  clinicLegalName: "Radiance Med Spa",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  signatoryEmail: "alex@radiance.test",
  effectiveDate: "2026-08-18",
  specialty: "Med spa",
  isCoveredEntity: false,
  attributionMode: "estimated",
  connectedPlatform: null,
  outboundMessaging: true,
  // Read by BAA 1.3.0, the current version, which renders nothing without them.
  bookingSystem: "none",
  calendarAccount: "workspace_no_baa",
};

const PREPARED = prepareBaa(currentBaaTemplate(), VARS);

/**
 * A signed acceptance, written the way signAgreement writes one: unbound, and
 * naming only the columns the runtime role may insert (drizzle/0066 keeps the
 * organisation, binding and termination columns behind their definers).
 */
async function seedAcceptance(): Promise<string> {
  const variables = {
    ...VARS,
    appliedClauses: PREPARED.clauseIds,
    displayedHashVerified: true,
  };
  const { rows } = await unsafeDb.execute<{ id: string }>(sql`
    insert into baa_acceptances
      (user_id, document_version, document_hash, rendered_text, variables, assent_label,
       accepted_by_name, accepted_by_email, accepted_by_title, ip_address, user_agent)
    values
      (null, ${PREPARED.version}, ${PREPARED.hash}, ${PREPARED.text},
       ${JSON.stringify(variables)}::jsonb,
       ${assentSentence(VARS.clinicLegalName)},
       ${VARS.signatoryName}, ${VARS.signatoryEmail}, ${VARS.signatoryTitle ?? null},
       '203.0.113.42', 'Mozilla/5.0')
    returning id`);

  return rows[0]!.id;
}

/**
 * An operator to attribute a resend to.
 *
 * security_events.user_id is a real foreign key, and a violation there would be
 * swallowed by traceCopy's catch — leaving a test that fails by finding no
 * event, which says nothing about the thing under test.
 */
async function seedOperator(): Promise<{ userId: string; label: string }> {
  const userId = randomUUID();
  const label = `ops-${userId.slice(0, 8)}@healdesk.test`;
  await getMigratorPool().query(
    `insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)`,
    [userId, "Ops", label],
  );
  return { userId, label };
}

async function readCopyColumns(agreementId: string) {
  const [row] = await unsafeDb
    .select({
      acceptedAt: baaAcceptances.acceptedAt,
      copySentAt: baaAcceptances.copySentAt,
      copyDocumentSha256: baaAcceptances.copyDocumentSha256,
    })
    .from(baaAcceptances)
    .where(eq(baaAcceptances.id, agreementId));
  return row!;
}

/** Narrow a delivery to the sent case, so the digest is reachable. */
function sentCopy(
  result: SignedCopyDelivery,
): Extract<SignedCopyDelivery, { status: "sent" }> {
  expect(result.status).toBe("sent");
  return result as Extract<SignedCopyDelivery, { status: "sent" }>;
}

describeDb("the record of a delivered copy", () => {
  beforeAll(async () => {
    await runMigrations();
    // Once, before anything opens the application pool. Truncating between
    // tests deadlocks against the connections `unsafeDb` is holding, and it is
    // not needed: every test seeds its own acceptance and asks only about that
    // one, which is also what makes them honest — a query that answered with
    // another agreement's deliveries would pass a suite with one row in it.
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    transport.calls.length = 0;
    transport.result = { sent: true, status: "sent" };
  });

  afterAll(async () => {
    // Only the harness's pools. The application pool that `unsafeDb` opens is
    // left to the process, as it is in every other DB-backed suite here:
    // closing a handle that other test files may already be sharing is a worse
    // failure than a connection that dies with the worker.
    await closePools();
  });

  test("stamps copy_sent_at from Postgres, not from this process's clock", async () => {
    const agreementId = await seedAcceptance();

    /**
     * Only Date is faked, and only for the call.
     *
     * Faking the timers as well would stall the pg driver's own timeouts. This
     * is the whole experiment: on one machine the two clocks agree, so the only
     * way to prove which one wrote the column is to move one of them.
     */
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-03-04T05:06:07.000Z"));
    let result: SignedCopyDelivery;
    try {
      result = await deliverSignedCopy(agreementId, { kind: "signature" });
    } finally {
      vi.useRealTimers();
    }

    const delivery = sentCopy(result);
    expect(delivery.firstCopy).toBe(true);
    expect(transport.calls).toHaveLength(1);

    const row = await readCopyColumns(agreementId);
    expect(row.copySentAt).not.toBeNull();

    // The application believed it was 2031. The column agrees with the
    // database's own clock instead, to the minute — which is what an
    // application-side `new Date()` could not do, and what a hard-coded year
    // would stop testing the moment the calendar caught up with it.
    const { rows } = await getMigratorPool().query<{ at: Date }>(
      "select now() as at",
    );
    expect(
      Math.abs(row.copySentAt!.getTime() - rows[0]!.at.getTime()),
    ).toBeLessThan(60_000);

    // And the copy cannot predate the signature it is a copy of.
    expect(row.copySentAt!.getTime()).toBeGreaterThanOrEqual(
      row.acceptedAt.getTime(),
    );
    // The pair is written together; the table's CHECK requires it.
    expect(row.copyDocumentSha256).toBe(delivery.sha256);
  });

  test("keeps the first delivery and records the resend's digest where it can be found", async () => {
    const agreementId = await seedAcceptance();
    const operator = await seedOperator();

    const first = sentCopy(
      await deliverSignedCopy(agreementId, { kind: "signature" }),
    );
    const stamped = await readCopyColumns(agreementId);

    const second = sentCopy(
      await deliverSignedCopy(agreementId, {
        kind: "resend",
        actorLabel: operator.label,
        userId: operator.userId,
      }),
    );

    expect(first.firstCopy).toBe(true);
    // Not an error and not an overwrite: the `is null` predicate matches no
    // row, so the write-once trigger never fires and the resend still reports
    // the mail that went out.
    expect(second.firstCopy).toBe(false);
    expect(transport.calls).toHaveLength(2);

    const after = await readCopyColumns(agreementId);
    expect(after.copySentAt!.getTime()).toBe(stamped.copySentAt!.getTime());
    expect(after.copyDocumentSha256).toBe(first.sha256);

    // Both deliveries are readable, newest first, each carrying the digest of
    // the file that went out on that send.
    const deliveries = await listCopyDeliveries(agreementId);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((d) => d.trigger)).toEqual(["resend", "signature"]);
    expect(deliveries.map((d) => d.firstCopy)).toEqual([false, true]);
    expect(deliveries.map((d) => d.sha256)).toEqual([
      second.sha256,
      first.sha256,
    ]);
    for (const delivery of deliveries) {
      expect(delivery.deliveredAt.getTime()).toBeGreaterThanOrEqual(
        stamped.acceptedAt.getTime(),
      );
    }
  });

  test("lists nothing for a copy that never went out", async () => {
    const agreementId = await seedAcceptance();
    transport.result = {
      sent: false,
      status: "failed",
      reason: "550 5.1.1 user unknown: alex@radiance.test",
    };

    const result = await deliverSignedCopy(agreementId, { kind: "signature" });
    expect(result.status).toBe("failed");

    // The visible state an operator counts, and no delivery to find.
    const row = await readCopyColumns(agreementId);
    expect(row.copySentAt).toBeNull();
    expect(row.copyDocumentSha256).toBeNull();
    expect(await listCopyDeliveries(agreementId)).toEqual([]);
  });

  test("answers nothing rather than everything for an id that is not one", async () => {
    const agreementId = await seedAcceptance();
    await deliverSignedCopy(agreementId, { kind: "signature" });

    // A malformed id is refused before the query, and a well-formed one that
    // names no agreement matches no events — never another agreement's.
    expect(await listCopyDeliveries("not-a-uuid")).toEqual([]);
    expect(await listCopyDeliveries(randomUUID())).toEqual([]);
  });
});
