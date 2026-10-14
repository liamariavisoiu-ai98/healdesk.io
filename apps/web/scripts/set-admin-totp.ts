/**
 * Make the administrator's authenticator secret.
 *
 *   npm run admin:totp -w @healdesk/web
 *   npm run admin:totp -w @healdesk/web -- you@example.com
 *
 * ## What it does, in order
 *
 *   1. Generates 20 random bytes and writes them as unpadded base32, the
 *      format `HEALDESK_ADMIN_TOTP_SECRET` takes (`src/lib/admin/totp.ts`).
 *   2. Prints the otpauth URI and a QR code of it, for the authenticator app
 *      to scan, labelled with the account's address: the argument, or
 *      `HEALDESK_ADMIN_EMAIL` from the environment (`apps/web/.env.local` is
 *      read if it exists).
 *   3. Asks for a code from the app and checks it against the new secret with
 *      the verifier the sign-in route uses, so a QR that was not scanned, or a
 *      phone whose clock is out, is found here rather than at the sign-in form
 *      with the old secret already replaced.
 *   4. Only then prints the line to run and the value to paste into Vercel.
 *
 * ## Why the secret is never written to disk
 *
 * Every other script in this directory that makes a credential writes it
 * into `.env.local`. This one does not, on purpose: the value is one of the two
 * factors to the console, and a file holding it sits beside a file holding the
 * other (`HEALDESK_ADMIN_PASSWORD_HASH`), which is two factors in one place on
 * a laptop instead of in a Vercel project behind its own second factor. So it
 * exists in this process's memory, in the terminal, and in the authenticator,
 * and nowhere else until you paste it. For local development, put it in
 * `apps/web/.env.local` yourself if you want to sign in there, and know that
 * you have.
 *
 * ## Replacing a lost or exposed authenticator
 *
 * Run this again. The new secret replaces the old one when the deployment that
 * carries the new value goes live, and every code from the old one stops
 * working then. There are no recovery codes (owner, 14 October 2026): the way
 * back in after losing the phone is this script and the Vercel account, which
 * has its own second factor.
 */

import { createInterface } from "node:readline/promises";

import { toString as qrToString } from "qrcode";

import {
  TOTP_SECRET_VARIABLE,
  adminTotpUri,
  base32Decode,
  generateAdminTotpSecret,
  matchTotpStep,
  totpStep,
} from "../src/lib/admin/totp";

/** Three tries at the code: a mistype, a code that ticked over, and one more. */
const ATTEMPTS = 3;

/** Shape only: the address is a label in the authenticator, not a login here. */
function looksLikeEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Four-character groups, for typing in by hand when the camera will not focus. */
function grouped(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? [secret]).join(" ");
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(
      "This needs a terminal: it asks for a code from your authenticator app\n" +
        "before it prints anything to paste. Run it directly rather than through a pipe.",
    );
    process.exit(1);
  }

  const email = (process.argv[2] ?? process.env.HEALDESK_ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!looksLikeEmail(email)) {
    console.error(
      "Which account? Pass the admin address as an argument, or set HEALDESK_ADMIN_EMAIL:\n" +
        "  npm run admin:totp -w @healdesk/web -- you@example.com",
    );
    process.exit(1);
  }

  const secret = generateAdminTotpSecret();
  const key = base32Decode(secret);
  if (key === null) throw new Error("the generated secret did not decode");
  const uri = adminTotpUri(secret, email);

  console.log(`A new authenticator secret for ${email}.\n`);
  console.log("Scan this with your authenticator app (it is labelled healdesk):\n");
  console.log(await qrToString(uri, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
  console.log("Or add it by hand, as a time-based key:");
  console.log(`  ${grouped(secret)}\n`);
  console.log(`otpauth URI:\n  ${uri}\n`);
  console.log("Nothing has been written anywhere, and nothing changes until the");
  console.log("value is in Vercel and a new deployment is live.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let confirmed = false;
  try {
    for (let attempt = 1; attempt <= ATTEMPTS && !confirmed; attempt += 1) {
      const answer = (await rl.question("Code from the authenticator: ")).replace(/\s+/g, "");
      if (matchTotpStep(key, answer, totpStep(Date.now())) !== null) {
        confirmed = true;
      } else if (attempt < ATTEMPTS) {
        console.log("That code does not match this secret. Try the next one the app shows.");
      }
    }
  } finally {
    rl.close();
  }

  if (!confirmed) {
    console.error(
      "\nNo code matched, so there is nothing to paste. Check that the phone sets its\n" +
        "clock automatically, delete the entry you just scanned, and run this again.",
    );
    process.exit(1);
  }

  console.log("\nConfirmed: the authenticator holds this secret.\n");
  console.log("Add it to apps/web's Vercel project, for Production, as a Sensitive variable:\n");
  console.log(`  vercel env add ${TOTP_SECRET_VARIABLE} production --sensitive\n`);
  console.log("and paste this value when it asks (or, in the dashboard, Settings,");
  console.log("Environment Variables, with Sensitive ticked):\n");
  console.log(`  ${secret}\n`);
  console.log(`If ${TOTP_SECRET_VARIABLE} is already set, remove it first`);
  console.log(`(vercel env rm ${TOTP_SECRET_VARIABLE} production), then add it again.`);
  console.log("Redeploy for it to take effect. From then on only this authenticator");
  console.log("entry signs in: delete any older healdesk entry from your phone.\n");
  console.log("This value was printed here and written nowhere else. Clear this");
  console.log("terminal's scrollback if anyone else can read it.");
}

main().catch((error: unknown) => {
  // The message only: an error object from deep in readline or the QR encoder
  // can carry the buffer it was working on, which here would be the secret.
  console.error("\nFailed:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
