/**
 * What /admin/map finds live, gathered on the server for `assess()`.
 *
 * Everything here answers yes or no, a mode, or a date. No key's value
 * leaves this file: Vercel's keys are tested for presence where they are
 * read, the AWS host answers presence itself (apps/app
 * lib/ops/key-presence.ts), and the live checks report only whether they
 * passed. The result is what the browser gets, through `assess()`.
 *
 * The checks run together and each settles on its own, with its own
 * timeout, so a host in standby makes its own bridges grey without taking
 * the rest of the map with it.
 *
 * Server-side only: it reads the environment and sends GitHub tokens.
 */

import { credentialKeyStatus, keyPresence } from "@/lib/admin/ops-client";
import { isMarketingStoreConfigured, marketingSheetId, parseServiceAccount } from "@/lib/sheets/client";

import { checkGithubToken, type TokenCheck } from "./github-token";
import { readRotations } from "./key-rotations";
import { KEYS, type HostReach, type LiveInputs, type ProofResult } from "./system-map";

if (typeof window !== "undefined") {
  throw new Error("lib/admin/system-map-live is server-side only: it reads the environment.");
}

/** The image's placeholder for an unset parameter; a value pasted on Vercel by mistake counts as unset too. */
const UNSET_PLACEHOLDER = "__unset__";

function isSet(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed) && trimmed !== UNSET_PLACEHOLDER;
}

/**
 * Presence of each Vercel key, the way the code that uses it decides: the
 * Sheet's two count only when lib/sheets/client would accept them, since a
 * key file that does not parse is as good as none.
 */
export function vercelPresence(): Record<string, boolean> {
  const present: Record<string, boolean> = {};
  for (const key of KEYS) {
    if (key.home !== "vercel" || !key.env) continue;
    present[key.env] = isSet(process.env[key.env]);
  }
  present.MARKETING_SHEET_ID = marketingSheetId() !== null;
  present.GOOGLE_SERVICE_ACCOUNT_JSON = parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) !== null;
  return present;
}

export function stripeMode(value: string | undefined): "test" | "live" | null {
  if (!isSet(value)) return null;
  const match = /^(?:sk|rk)_(test|live)_/.exec(value!.trim());
  return match ? (match[1] as "test" | "live") : null;
}

async function host(): Promise<HostReach> {
  const answer = await keyPresence();
  if (answer.ok) return { state: "answered", present: answer.data.present, stripeMode: answer.data.stripeMode };
  switch (answer.code) {
    case "unconfigured":
      return { state: "unconfigured" };
    case "forbidden":
      return {
        state: "refused",
        message: "it does not accept this console's HEALDESK_ADMIN_EMAIL. The Vercel and AWS copies must be the same address.",
      };
    case "outdated":
      // An engine deployed before this check existed does not know the
      // question. That is not a broken seal, and saying so would send the
      // owner to rotate a secret that is fine.
      return { state: "silent", message: "it runs an older version without this check: deploy the engine (deploy-app.yml) to see its keys" };
    case "refused":
      return {
        state: "refused",
        message:
          "most often the two copies of HEALDESK_PROVISION_SECRET (Vercel and AWS) differ, or a clock is badly off; the exact reason is in the logs.",
      };
    case "failed":
      // The engine answers 503 before anything runs when its own copy of
      // HEALDESK_PROVISION_SECRET or HEALDESK_ADMIN_EMAIL is missing; the
      // ops client cannot tell that from a 503 the load balancer gives.
      return {
        state: "silent",
        message: "it answered with a server error; if the host is on, check that it has HEALDESK_PROVISION_SECRET and HEALDESK_ADMIN_EMAIL",
      };
    case "timeout":
      return { state: "silent", message: "no answer in time" };
    case "unreachable":
      return { state: "silent", message: "nothing answered at its address" };
    default:
      return { state: "silent", message: "it answered with an error" };
  }
}

/** Asked alongside the presence check, and counted only when the host answered that. */
async function kmsProof(asked: ReturnType<typeof credentialKeyStatus>, reach: HostReach): Promise<ProofResult | undefined> {
  const status = await asked;
  if (reach.state !== "answered" || !status.ok) return undefined;
  if (status.data.ok) return { ok: true, detail: "The engine locked and unlocked a test value with the key safe just now." };
  return { ok: false, detail: `The engine could not use the key safe just now (${status.data.error ?? "failed"}).` };
}

function tokenProof(check: TokenCheck | null): ProofResult | undefined {
  if (!check) return undefined;
  if (check.ok) return { ok: true, detail: "GitHub accepted the token just now." };
  if (check.reason === "rejected") return { ok: false, detail: "GitHub rejected the token: it has expired, been revoked, or was pasted wrong." };
  return undefined;
}

export async function gatherLive(now: Date = new Date()): Promise<LiveInputs> {
  const actionsToken = process.env.HEALDESK_GITHUB_ACTIONS_TOKEN?.trim();
  const feedToken = process.env.GITHUB_TOKEN?.trim();

  // Both reads to the host start together, so a host that is slow to answer
  // costs one timeout, not two in a row.
  const keySafe = credentialKeyStatus();
  const [reach, actions, feed, rotations] = await Promise.all([
    host(),
    actionsToken ? checkGithubToken(actionsToken) : Promise.resolve(null),
    feedToken ? checkGithubToken(feedToken) : Promise.resolve(null),
    readRotations(),
  ]);
  const kms = await kmsProof(keySafe, reach);

  const expiresAt: Record<string, Date> = {};
  if (actions?.ok && actions.expiresAt) expiresAt["vercel.HEALDESK_GITHUB_ACTIONS_TOKEN"] = actions.expiresAt;
  if (feed?.ok && feed.expiresAt) expiresAt["vercel.GITHUB_TOKEN"] = feed.expiresAt;

  const proofs: LiveInputs["proofs"] = {};
  const actionsProof = tokenProof(actions);
  if (actionsProof) proofs["github-actions"] = actionsProof;
  const feedProof = tokenProof(feed);
  if (feedProof) proofs["github-feed"] = feedProof;
  if (kms) proofs.kms = kms;
  if (isMarketingStoreConfigured()) {
    proofs.sheet = rotations.ok
      ? { ok: true, detail: "Read the Sheet just now." }
      : { ok: false, detail: "The Sheet could not be read just now: check that it is still shared with the robot account." };
  }

  return {
    now,
    vercel: vercelPresence(),
    vercelStripeMode: stripeMode(process.env.STRIPE_SECRET_KEY),
    host: reach,
    proofs,
    expiresAt,
    rotatedAt: rotations.ok ? rotations.last : {},
    rotationLog: rotations.ok ? "read" : "unavailable",
  };
}
