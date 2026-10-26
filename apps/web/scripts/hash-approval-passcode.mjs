/**
 * Make the hash of the one approval passcode (lane P7h; owner, 26 October
 * 2026), for the Vercel variable HEALDESK_APPROVAL_PASSCODE_HASH:
 *
 *   node apps/web/scripts/hash-approval-passcode.mjs
 *
 * It asks for the six digits twice at a hidden prompt, prints one line,
 * `scrypt$N$r$p$<salt>$<key>`, and nothing else: the passcode is never an
 * argument (shell history, `ps`), never written to a file, never printed.
 * Paste the line into Vercel (healdesk project, Settings, Environment
 * Variables, Production, Sensitive), then redeploy. Run it again to change
 * the passcode; the old one stops working at the next deployment.
 *
 * lib/admin/approval-passcode.ts reads N, r and p from the string, so the
 * numbers below can change without a code change. They are the admin
 * password's (scripts/set-admin-password.ts): scrypt is what makes each of a
 * million guesses cost something, and the console's lockout (five wrong
 * tries, fifteen minutes) is what bounds how many are made.
 */

import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

/** One terminal for both questions; its echo is muted while a question waits. */
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const write = rl.output.write.bind(rl.output);
let muted = false;
rl.output.write = (chunk, ...rest) => (muted ? true : write(chunk, ...rest));
rl.on("close", () => {
  if (muted) {
    write("\nStopped. Nothing was made.\n");
    process.exit(1);
  }
});

function askHidden(question) {
  return new Promise((resolve) => {
    write(question);
    muted = true;
    rl.question("", (answer) => {
      muted = false;
      write("\n");
      resolve(answer.trim());
    });
  });
}

if (!process.stdin.isTTY) {
  console.error("This needs a terminal: it reads the passcode with echo off. Run it directly, not through a pipe.");
  process.exit(1);
}

const first = await askHidden("Approval passcode (6 digits, not shown): ");
if (!/^[0-9]{6}$/.test(first)) {
  console.error("The passcode is exactly six digits. Nothing was made.");
  process.exit(1);
}
if (/^(\d)\1{5}$/.test(first) || "0123456789".includes(first) || "9876543210".includes(first)) {
  console.error("Pick six digits that are not all the same and not a run. Nothing was made.");
  process.exit(1);
}
const second = await askHidden("Again: ");
if (second !== first) {
  console.error("The two did not match. Nothing was made.");
  process.exit(1);
}

rl.close();
const salt = randomBytes(16);
const key = scryptSync(first, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
console.log(`scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`);
