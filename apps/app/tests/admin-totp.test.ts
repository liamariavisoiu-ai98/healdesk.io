import { createHmac } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  burnRecoveryCode,
  enrolAdminTotp,
  getAdminTotpState,
  markStepUsed,
  proposeAdminTotp,
  verifyAdminTotpCode,
} from "@/lib/ops/admin-totp";
import { isMutating, isOpName, parseEnvelope } from "@/lib/ops/api";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
} from "./setup/db";

/**
 * The administrator's second factor.
 *
 * There is one login into a console that issues booking credentials, resends
 * executed contracts and starts a six-year retention clock, and this is the
 * factor that stops a leaked password from being the whole of it. So these
 * tests do not walk the happy path for reassurance; they walk it far enough to
 * have something to attack, and then attack it.
 *
 * Five failures are hunted specifically, and each is invisible to a test that
 * merely checks that a correct code is accepted:
 *
 *   1. **Read-then-write on the step counter.** "Has this code been used? No?
 *      Use it." passes every sequential assertion anybody writes and loses the
 *      race in production, letting an intercepted code be accepted twice inside
 *      its own window. The concurrency test fires simultaneous submissions,
 *      because a race declared fixed on one lucky interleaving is not fixed.
 *
 *   2. **A secret stored in the clear.** A refactor that stores the base32
 *      string still verifies every code perfectly, so nothing downstream would
 *      notice. The test reads the row back as the owner and looks for the
 *      secret in it.
 *
 *   3. **An application that can disenrol or re-point the factor.** If the app
 *      role can delete the row or write a new secret, then anybody who reaches
 *      the application can swap in their own authenticator, and the second
 *      factor is decoration. Both are attempted here as the runtime role.
 *
 *   4. **A recovery code that can be added.** Spending one is ordinary;
 *      APPENDING one is a permanent bypass minted by whoever compromised the
 *      app. The trigger has to refuse it.
 *
 *   5. **Team management surviving the removal.** `listTeam`, `inviteTeammate`
 *      and `revokeInvitation` are gone, and "gone" has to mean the dispatcher
 *      does not know the names, not that the console stopped calling them.
 */

/**
 * Enrolment proposals are signed with a subkey of the provisioning secret, and
 * `proposalKey()` throws rather than falling back when it is unset — an empty
 * key is a forgeable proposal, which is an attacker-chosen second factor. The
 * route already refuses every request without it, so this is what a running
 * deployment looks like rather than a test-only convenience.
 */
process.env.HEALDESK_PROVISION_SECRET ??= "admin-totp-test-provision-secret";

const describeDb = hasTestDatabase ? describe : describe.skip;

/**
 * An independent HOTP, deliberately not imported from the module under test.
 *
 * A test that derives its expected code with the same function it is testing
 * proves only that the function agrees with itself: an implementation that
 * truncated the wrong four bytes would pass. This is RFC 4226 §5.3 written out
 * from the specification, so agreement between the two is evidence.
 */
function codeFor(secretBase32: string, step: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (const character of secretBase32) {
    acc = (acc << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest.readUInt8(19) & 0x0f;
  const truncated = digest.readUInt32BE(offset) & 0x7fff_ffff;
  return String(truncated % 1_000_000).padStart(6, "0");
}

function currentStep(at = Date.now()): number {
  return Math.floor(at / 1000 / 30);
}

/** Propose, confirm, and hand back the secret so a test can produce codes. */
async function enrol(): Promise<{ secret: string; recoveryCodes: string[] }> {
  const proposed = proposeAdminTotp("healdesk.io@gmail.com");
  const result = await enrolAdminTotp(
    proposed.proposal,
    codeFor(proposed.secret, currentStep()),
  );

  if (result.status !== "enrolled") {
    throw new Error(`enrolment failed: ${result.status}`);
  }

  return { secret: proposed.secret, recoveryCodes: result.recoveryCodes };
}

// -----------------------------------------------------------------------------
// The dispatcher. No database needed, and no database SHOULD be needed.
// -----------------------------------------------------------------------------

describe("the operation allow-list", () => {
  test("team management is not an operation any more", () => {
    // Removed with the invitation system. Gone means the dispatcher does not
    // know the name, so a console still calling it gets an unknown-operation
    // 400 rather than quietly working against a half-removed feature.
    expect(isOpName("listTeam")).toBe(false);
    expect(isOpName("inviteTeammate")).toBe(false);
    expect(isOpName("revokeInvitation")).toBe(false);
  });

  test("a crafted op cannot walk into the prototype", () => {
    // The reason the list is an array checked with `includes` and not an object
    // of handlers: every one of these is a property of a plain object.
    for (const attempt of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
    ]) {
      expect(isOpName(attempt)).toBe(false);
    }
  });

  test("everything that writes is classified as mutating", () => {
    // The classification decides what an operator is told after a 500: "reload
    // before trying again" versus "that failed". Getting it wrong on a write
    // invites a second connect link or a second termination attempt.
    for (const op of [
      "toggleJob",
      "issueConnectLink",
      "resendAgreementCopy",
      "markAgreementTerminated",
      "enrolAdminTotp",
      "verifyAdminTotpStep",
      "burnRecoveryCode",
      "sendSignInAlert",
    ] as const) {
      expect(isMutating(op), op).toBe(true);
    }

    for (const op of [
      "listClinics",
      "listJobs",
      "searchAgreements",
      "getAgreement",
      "getAdminTotpState",
    ] as const) {
      expect(isMutating(op), op).toBe(false);
    }
  });

  test("an operator named in the body is ignored, not honoured", () => {
    // The whole point of the new identity model: nothing in a request can
    // choose who an action is attributed to. The envelope simply has no field
    // for it any more, so a caller sending one gets it dropped on the floor.
    const parsed = parseEnvelope(
      JSON.stringify({
        op: "listJobs",
        args: {},
        operator: { userId: "somebody", email: "attacker@example.com" },
        context: { ipAddress: "203.0.113.4", userAgent: "Firefox" },
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.envelope)).toEqual(["op", "args", "context"]);
    expect(parsed.envelope.context.ipAddress).toBe("203.0.113.4");
  });

  test("an unknown operation is refused before anything else happens", () => {
    const parsed = parseEnvelope(JSON.stringify({ op: "dropEverything" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // Names nothing back. Not the op, not a suggestion.
    expect(parsed.outcome.body).toEqual({
      error: "Unknown operation.",
      code: "unknown_operation",
    });
  });
});

// -----------------------------------------------------------------------------
// The secret, the counter and the row
// -----------------------------------------------------------------------------

describeDb("admin second factor", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    // Only the owner can clear it. That is the point of the grants, and it is
    // why this is not in the shared truncateAll(): a helper the app role can
    // call would be a helper that disenrols the factor.
    await getMigratorPool().query("delete from admin_totp");
  });

  afterAll(async () => {
    await getMigratorPool().query("delete from admin_totp");
    await closePools();
  });

  test("there can only ever be one row", async () => {
    await enrol();

    await expect(
      getMigratorPool().query(
        `insert into admin_totp (id, secret_ciphertext)
         values (2, '{"ciphertext":"x","iv":"x","authTag":"x","wrappedDek":"x","keyVersion":"x"}'::jsonb)`,
      ),
    ).rejects.toThrow();
  });

  test("the secret is not stored in the clear", async () => {
    const { secret } = await enrol();

    const { rows } = await getMigratorPool().query<{ stored: string }>(
      "select secret_ciphertext::text as stored from admin_totp where id = 1",
    );

    // The whole row as text, so a secret hidden in any field of the envelope
    // would still be found. If this ever fails, every copy of this database is
    // a list of working authenticators.
    expect(rows[0]?.stored).toBeDefined();
    expect(rows[0]?.stored).not.toContain(secret);
    expect(rows[0]?.stored).toContain("authTag");
  });

  test("a row whose secret is not sealed cannot be written at all", async () => {
    // The constraint that turns "somebody simplified this into storing the
    // base32 string" from a silent catastrophe into a failed INSERT.
    await expect(
      getMigratorPool().query(
        `insert into admin_totp (id, secret_ciphertext)
         values (1, '"JBSWY3DPEHPK3PXP"'::jsonb)`,
      ),
    ).rejects.toThrow();
  });

  test("the application cannot disenrol or re-point the factor", async () => {
    await enrol();
    const app = getAppPool();

    // 3a. No DELETE. A factor the app can delete is a factor an attacker who
    //     reaches the app can delete, and then sign in with the password alone.
    await expect(app.query("delete from admin_totp")).rejects.toThrow(
      /permission denied/i,
    );

    // 3b. No UPDATE of the secret. Column-scoped grant refuses it before the
    //     trigger even runs.
    await expect(
      app.query(
        `update admin_totp set secret_ciphertext = '{"ciphertext":"x","iv":"x","authTag":"x","wrappedDek":"x","keyVersion":"x"}'::jsonb`,
      ),
    ).rejects.toThrow(/permission denied/i);

    // 3c. Nor the enrolment date, which is what a "reset" would clear.
    await expect(
      app.query("update admin_totp set enrolled_at = now()"),
    ).rejects.toThrow(/permission denied/i);
  });

  test("the step counter only moves forward", async () => {
    await enrol();

    expect(await markStepUsed(1_000)).toBe(true);
    // The same step again: this is the replay, and it must fail.
    expect(await markStepUsed(1_000)).toBe(false);
    // And a lower one, which is what an attacker replaying an older code needs.
    expect(await markStepUsed(999)).toBe(false);
    expect(await markStepUsed(1_001)).toBe(true);
  });

  test("the database refuses a decreasing step even when asked directly", async () => {
    await enrol();
    await markStepUsed(2_000);

    // The conditional UPDATE is a line of code somebody can rewrite. The
    // trigger is what survives that.
    await expect(
      getAppPool().query("update admin_totp set last_used_step = 5"),
    ).rejects.toThrow(/only ever moves forward/i);
  });

  test("two simultaneous submissions of one code produce exactly one success", async () => {
    const { secret } = await enrol();
    const code = codeFor(secret, currentStep());

    // Fired together, not in sequence. A read-then-write implementation passes
    // every other test in this file and fails this one.
    const results = await Promise.all([
      verifyAdminTotpCode(code),
      verifyAdminTotpCode(code),
      verifyAdminTotpCode(code),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const result of results) {
      if (!result.ok) expect(result.reason).toBe("already_used");
    }
  });

  test("a code from the drift window is accepted, and then spent", async () => {
    const { secret } = await enrol();
    const step = currentStep();

    // A phone thirty seconds slow. Accepted once.
    const previous = await verifyAdminTotpCode(codeFor(secret, step - 1));
    expect(previous).toEqual({ ok: true, step: step - 1 });

    // And now the CURRENT code still works, because it is a later step. This is
    // the case a naive "last used step" check breaks: it must not lock the
    // administrator out of the code their authenticator is showing.
    const now = await verifyAdminTotpCode(codeFor(secret, step));
    expect(now.ok).toBe(true);

    // But the drifted one is spent for good.
    expect(await verifyAdminTotpCode(codeFor(secret, step - 1))).toEqual({
      ok: false,
      reason: "already_used",
    });
  });

  /**
   * RFC 6238 appendix B, against the code that actually runs.
   *
   * `codeFor` above is an independent HOTP, which catches this module
   * disagreeing with a second opinion — but two implementations can agree and
   * both be wrong, and dynamic truncation is exactly the step where that
   * happens: taking the offset from the wrong end of the digest, or masking
   * with 0xff instead of 0x0f, produces a self-consistent generator that no
   * authenticator on earth agrees with. The published vectors are the only
   * check that settles it, and the failure they catch is total — every code the
   * owner's phone shows would be refused, and nothing but a real Google
   * Authenticator would reveal it.
   *
   * The vectors are the SHA-1 rows, truncated to the six digits this module
   * emits (RFC 6238 prints eight; the six are the low digits of the same
   * dynamic-truncation value, because both are DBC mod 10^Digit).
   *
   * They also exercise the drift window at an arbitrary point on the clock:
   * `verifyAdminTotpCode` is asked for each vector at that vector's own instant
   * rather than at "now", so a code that only verified against the current step
   * would fail here.
   *
   * The times increase, which the forward-only step counter requires — an
   * accepted code spends its step, so the vectors could not be replayed in a
   * different order. That ordering is a property of the list, not a workaround:
   * it is the same constraint a real authenticator operates under.
   */
  test("the arithmetic matches the RFC 6238 published vectors", async () => {
    // "12345678901234567890", the RFC's SHA-1 seed, as base32.
    const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    // Enrol the RFC's seed rather than a generated one, by handing back a
    // proposal carrying it. Signing it with the same subkey the module uses is
    // what makes this a test of the arithmetic and not of the enrolment path.
    const body = Buffer.from(
      JSON.stringify({ s: seed, t: Date.now() }),
      "utf8",
    ).toString("base64url");
    const key = createHmac("sha256", process.env.HEALDESK_PROVISION_SECRET as string)
      .update("healdesk.admin-totp.enrolment.v1")
      .digest();
    const proposal = `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;

    const enrolled = await enrolAdminTotp(proposal, codeFor(seed, currentStep()));
    expect(enrolled.status).toBe("enrolled");

    const vectors: Array<{ unixSeconds: number; code: string }> = [
      { unixSeconds: 59, code: "287082" },
      { unixSeconds: 1_111_111_109, code: "081804" },
      { unixSeconds: 1_111_111_111, code: "050471" },
      { unixSeconds: 1_234_567_890, code: "005924" },
      { unixSeconds: 2_000_000_000, code: "279037" },
      { unixSeconds: 20_000_000_000, code: "353130" },
    ];

    for (const vector of vectors) {
      expect(
        await verifyAdminTotpCode(vector.code, new Date(vector.unixSeconds * 1000)),
        `RFC 6238 t=${vector.unixSeconds}`,
      ).toEqual({ ok: true, step: Math.floor(vector.unixSeconds / 30) });
    }
  });

  /**
   * The window is ±1 step, and the far side of it has to be closed.
   *
   * A drift window is a tolerance for a wrong clock and nothing else: every
   * extra step is another thirty seconds in which a code somebody watched over
   * a shoulder is still worth something. A test that only checks that ±1 is
   * ACCEPTED cannot tell a window of one from a window of five, which is the
   * direction this constant drifts when somebody is debugging a support ticket
   * about a phone that will not sync.
   */
  test("a code two steps away is refused, in both directions", async () => {
    const { secret } = await enrol();
    // A fixed instant, so the assertions cannot straddle a step boundary that
    // arrived between two lines of the test.
    const at = new Date(1_700_000_000_000);
    const step = Math.floor(at.getTime() / 1000 / 30);

    expect(await verifyAdminTotpCode(codeFor(secret, step + 2), at)).toEqual({
      ok: false,
      reason: "incorrect",
    });
    expect(await verifyAdminTotpCode(codeFor(secret, step - 2), at)).toEqual({
      ok: false,
      reason: "incorrect",
    });

    // And the edge of the window still works, so the two refusals above are the
    // window being one step wide rather than the secret being wrong.
    expect(await verifyAdminTotpCode(codeFor(secret, step + 1), at)).toEqual({
      ok: true,
      step: step + 1,
    });
  });

  test("a wrong code is refused and spends nothing", async () => {
    const { secret } = await enrol();
    const step = currentStep();

    expect(await verifyAdminTotpCode("000000")).toEqual({
      ok: false,
      reason: "incorrect",
    });
    expect(await verifyAdminTotpCode("not a code")).toEqual({
      ok: false,
      reason: "incorrect",
    });

    // The counter must not have moved: otherwise anybody able to submit garbage
    // could advance it past the administrator's real code and lock them out.
    expect(await verifyAdminTotpCode(codeFor(secret, step))).toEqual({
      ok: true,
      step,
    });
  });

  test("nothing verifies before enrolment", async () => {
    expect(await getAdminTotpState()).toEqual({
      enrolled: false,
      enrolledAt: null,
      recoveryCodesRemaining: 0,
    });

    expect(await verifyAdminTotpCode("123456")).toEqual({
      ok: false,
      reason: "not_enrolled",
    });
  });

  test("enrolment needs a code derived from the proposed secret", async () => {
    const proposed = proposeAdminTotp("healdesk.io@gmail.com");

    // A code from a DIFFERENT secret. This is the proof-of-possession: without
    // it, an authenticator that never scanned the QR would still be "enrolled",
    // and the administrator would find out at the next sign-in.
    const other = proposeAdminTotp("healdesk.io@gmail.com");
    expect(
      await enrolAdminTotp(proposed.proposal, codeFor(other.secret, currentStep())),
    ).toEqual({ status: "rejected", reason: "code_incorrect" });

    // Nothing was written by the failure.
    expect((await getAdminTotpState()).enrolled).toBe(false);

    const enrolled = await enrolAdminTotp(
      proposed.proposal,
      codeFor(proposed.secret, currentStep()),
    );
    expect(enrolled.status).toBe("enrolled");
  });

  test("a tampered proposal is not a proposal", async () => {
    const proposed = proposeAdminTotp("healdesk.io@gmail.com");
    const forged = proposeAdminTotp("healdesk.io@gmail.com");

    // The attacker's own secret, carried on the body of one proposal with the
    // MAC of another. Without the MAC check this enrols an authenticator
    // nobody at healdesk holds.
    const [, mac] = proposed.proposal.split(".");
    const [body] = forged.proposal.split(".");

    expect(
      await enrolAdminTotp(
        `${body}.${mac}`,
        codeFor(forged.secret, currentStep()),
      ),
    ).toEqual({ status: "rejected", reason: "proposal_expired" });
    expect((await getAdminTotpState()).enrolled).toBe(false);
  });

  test("a second enrolment does not replace the first", async () => {
    const { secret } = await enrol();

    const second = proposeAdminTotp("healdesk.io@gmail.com");
    expect(
      await enrolAdminTotp(second.proposal, codeFor(second.secret, currentStep())),
    ).toEqual({ status: "already_enrolled" });

    // The original secret still verifies, which is the assertion that matters:
    // "already enrolled" would be cold comfort if the row had been overwritten.
    expect((await verifyAdminTotpCode(codeFor(secret, currentStep()))).ok).toBe(
      true,
    );
  });

  test("a recovery code works exactly once, whoever asks first", async () => {
    const { recoveryCodes } = await enrol();
    const code = recoveryCodes[0];
    expect(code).toBeDefined();
    if (!code) return;

    expect((await getAdminTotpState()).recoveryCodesRemaining).toBe(
      recoveryCodes.length,
    );

    // Simultaneously, because this is the entire second factor in one string:
    // two sessions redeeming it at once must produce one admission.
    const results = await Promise.all([
      burnRecoveryCode(code),
      burnRecoveryCode(code),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);

    expect(await burnRecoveryCode(code)).toEqual({
      ok: false,
      reason: "incorrect",
    });
    expect((await getAdminTotpState()).recoveryCodesRemaining).toBe(
      recoveryCodes.length - 1,
    );
  });

  test("a recovery code is accepted however it was written down", async () => {
    const { recoveryCodes } = await enrol();
    const code = recoveryCodes[0];
    if (!code) throw new Error("no recovery codes");

    // Lower case, no separator, surrounding spaces. All of these are how a code
    // comes back off a piece of paper, and none of them should be the reason
    // somebody cannot get in.
    const retyped = ` ${code.replace("-", "").toLowerCase()} `;
    expect(await burnRecoveryCode(retyped)).toMatchObject({ ok: true });
  });

  test("the application cannot mint itself a recovery code", async () => {
    await enrol();

    // Spending one is ordinary. Adding one is a permanent bypass, and the
    // column-level grant cannot tell the two apart — only the trigger can.
    await expect(
      getAppPool().query(
        "update admin_totp set recovery_code_hashes = recovery_code_hashes || repeat('a', 64)",
      ),
    ).rejects.toThrow(/only be spent/i);
  });

  test("recovery code hashes are digests, not codes", async () => {
    await enrol();

    await expect(
      getMigratorPool().query(
        "update admin_totp set recovery_code_hashes = array['ABCDE-FGHIJ']",
      ),
    ).rejects.toThrow();
  });

  test("state never carries the secret", async () => {
    const { secret } = await enrol();
    const state = await getAdminTotpState();

    // This value crosses an app boundary on its way to a browser-facing page.
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(state.enrolled).toBe(true);
    expect(state.enrolledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
