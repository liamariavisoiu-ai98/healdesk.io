/**
 * Set the administrator password.
 *
 *   npx tsx apps/web/scripts/set-admin-password.ts
 *
 * ## Why this exists rather than "just edit .env.local"
 *
 * The stored value is a scrypt hash, not the password, so it cannot be written
 * by hand. Deriving it needs the exact parameters the verifier re-derives with,
 * and a mismatch fails closed in a way that looks like a wrong password — the
 * worst kind of configuration error, because it is indistinguishable from the
 * thing it is not.
 *
 * ## Why the password is read from a hidden prompt and never an argument
 *
 * A command-line argument is recorded in shell history, is visible to every
 * other process on the machine through `ps`, and on a shared box outlives the
 * session. An environment variable is only marginally better. So this reads from
 * the terminal with echo disabled, holds the value for as long as it takes to
 * derive a hash, and never writes it anywhere.
 *
 * The plaintext is not stored, not logged, and not recoverable from the value
 * this writes. Losing it means running this again, which is the correct
 * trade for the only credential to the only admin surface.
 */

import { createInterface } from "node:readline";
import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * These four numbers are part of the stored format and are re-read from it at
 * verification time rather than assumed, so changing them here only affects new
 * passwords. An existing hash keeps verifying under the parameters it was made
 * with.
 */
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

/** Long enough that scrypt is the expensive part of guessing, not the search. */
const MIN_LENGTH = 12;

const ENV_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".env.local",
);

function hash(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    // scrypt's default maxmem is below what N=16384 needs; without this it
    // throws rather than deriving, which reads as a code bug at 2am.
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/**
 * Read one line with the terminal's echo disabled.
 *
 * `readline` has no first-class hidden mode, so this mutes the output stream
 * for the duration of the question. The `\n` afterwards is written by hand,
 * because the newline the user typed was swallowed along with everything else.
 */
function askHidden(question: string): Promise<string> {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const output = rl as unknown as { output?: NodeJS.WriteStream };
    const write = output.output?.write.bind(output.output);

    process.stdout.write(question);
    if (output.output && write) {
      output.output.write = ((chunk: string, ...rest: unknown[]) => {
        // Let the prompt itself through; swallow the echoed keystrokes.
        if (chunk.includes(question)) return write(chunk, ...(rest as []));
        return true;
      }) as typeof output.output.write;
    }

    rl.question("", (answer) => {
      if (output.output && write) output.output.write = write;
      process.stdout.write("\n");
      rl.close();
      resolveAnswer(answer);
    });
  });
}

/**
 * Every `$` is escaped, and this is not cosmetic.
 *
 * Next.js loads `.env.local` through `@next/env`, which runs dotenv-expand over
 * every value so that one variable can reference another with `$OTHER`. A
 * scrypt hash is `scrypt$16384$8$1$<salt>$<key>`, and every one of those six
 * fields after the first looks exactly like a variable reference. Measured, not
 * assumed: written unescaped, `scrypt$16384$8$1$Rf9…==$dQ2…==` is handed to the
 * application as `scrypt6384==`, because `$16384`, `$8`, `$1`, `$Rf9` and `$dQ2`
 * all expand to the empty string.
 *
 * Quoting does not help. Single quotes, double quotes and no quotes were all
 * tried against the loader this app actually uses and all three are mangled
 * identically; a backslash before the `$` is the only thing dotenv-expand
 * honours.
 *
 * The failure it produces is the worst-shaped one available. `parseScryptHash`
 * splits on `$`, gets one field instead of six, and returns null — which is the
 * same answer as "no hash configured" — so the sign-in page renders "Not
 * configured." straight after this script has said "Written". The operator has
 * a correct password, a correct file, and a door that denies a password exists.
 */
function escapeForDotenv(value: string): string {
  return value.replace(/\$/g, "\\$");
}

/**
 * Replace the line if it is there, append it if it is not, and leave every
 * other line exactly as it was. Rewriting the whole file from a parsed model
 * would drop the comments, and the comments in that file are load-bearing.
 */
function upsert(contents: string, key: string, value: string): string {
  const line = `${key}="${escapeForDotenv(value)}"`;
  const lines = contents.split("\n");
  const index = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));
  if (index >= 0) {
    lines[index] = line;
    return lines.join("\n");
  }
  const body = contents.replace(/\n+$/, "");
  return `${body}\n${line}\n`;
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(
      "This needs a terminal: it reads the password with echo disabled.\n" +
        "Run it directly rather than through a pipe.",
    );
    process.exit(1);
  }

  console.log("Set the healdesk administrator password.\n");
  console.log("Nothing you type is echoed, stored, or logged. Only a scrypt");
  console.log("hash is written, and the password cannot be read back from it.\n");

  const password = await askHidden("New password: ");
  if (password.length < MIN_LENGTH) {
    console.error(
      `\nToo short. ${MIN_LENGTH} characters minimum; nothing was written.`,
    );
    process.exit(1);
  }

  const again = await askHidden("Type it again: ");
  if (password !== again) {
    console.error("\nThose did not match. Nothing was written.");
    process.exit(1);
  }

  const encoded = hash(password);

  if (!existsSync(ENV_PATH)) {
    console.error(`\nNo file at ${ENV_PATH}. Nothing was written.`);
    process.exit(1);
  }

  const before = readFileSync(ENV_PATH, "utf8");
  let after = upsert(before, "HEALDESK_ADMIN_PASSWORD_HASH", encoded);

  // The old shared-password variable is what this replaces. Leaving it behind
  // is an unused live credential sitting in a file, which is worse than an
  // absent one.
  after = after
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("HEALDESK_ADMIN_PASSWORD="))
    .join("\n");

  writeFileSync(ENV_PATH, after);

  console.log("\nWritten to apps/web/.env.local as HEALDESK_ADMIN_PASSWORD_HASH.");
  if (before.includes("HEALDESK_ADMIN_PASSWORD=")) {
    console.log("Removed the old HEALDESK_ADMIN_PASSWORD line.");
  }
  console.log("\nRestart the web app for it to take effect.");
  console.log("Your authenticator (HEALDESK_ADMIN_TOTP_SECRET) is unchanged.");
}

main().catch((error: unknown) => {
  // Never print the error object: a throw from deep in readline can carry the
  // buffer it was reading at the time.
  console.error(
    "\nFailed:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exit(1);
});
