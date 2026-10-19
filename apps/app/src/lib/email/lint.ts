import { allPlans, CHANNELS, isPlanId, PACKAGES, TREATMENT_NAMES } from "@healdesk/catalog";

import { publicOrigin } from "@/lib/public-url";

import { carriesUnsubscribe, isLinkEmail, isEmailKind, type EmailKind } from "./kind-rules";

/**
 * The checks every email passes (Annex X4), in one place so the sender, the
 * tests and `npm run email:seed` ask the same questions.
 *
 * Two of them run on every send, not only in tests, because they guard what a
 * vendor without a business associate agreement receives:
 *
 *   - the PAYLOAD ALLOWLIST. A notice's payload is a jsonb column, not a type,
 *     so a field the template's type never declared can still be stored. The
 *     sender refuses any payload holding something outside the list: ids,
 *     counts, cents, ISO dates, plan and channel names, the clinic's name,
 *     masked addresses, the clinic's own numbers and public URLs. Not
 *     assertNoPhiInReport, which would refuse a masked address and the clinic's
 *     own number, and would miss a treatment name entirely;
 *   - the LINK SCANNER, over the bodies and the headers: https, our public
 *     origin or a payment page Stripe hosts, never HEALDESK_APP_URL, and a
 *     single-use token only in the kinds that mint one.
 *
 * The copy lint and the subject rules are about wording, which is fixed in the
 * templates, so they run over every template in the tests and in the seed
 * script, not on each send: a clinic whose own name happens to contain a
 * listed word must still get its email.
 */

// -----------------------------------------------------------------------------
// The payload allowlist
// -----------------------------------------------------------------------------

export class PayloadNotAllowedError extends Error {
  constructor(path: string, why: string) {
    // The path and the reason, never the value: the value is what was refused.
    super(`Refusing to render: payload field "${path}" ${why}`);
    this.name = "PayloadNotAllowedError";
  }
}

type ValueClass =
  | "id"
  | "count"
  | "cents"
  | "date"
  | "category"
  | "planId"
  | "planName"
  | "channel"
  | "clinicName"
  | "deviceName"
  | "masked"
  | "phone"
  | "url"
  | "flag"
  | "rows";

/** Counters that do not end in Count, Days, Hours, Minutes or Percent. */
const COUNT_KEYS: ReadonlySet<string> = new Set([
  "count",
  "attempts",
  "attempt",
  "used",
  "included",
  "locations",
  "repeats",
  "written",
  "matched",
  "exceptions",
  "deleted",
  "failures",
  "processed",
  "deferred",
  "months",
  "units",
]);

/**
 * Closed vocabularies: a notice kind, a status, a meter, an interval. The
 * value is checked to be a bare token, so none of them can carry a sentence.
 */
const CATEGORY_KEYS: ReadonlySet<string> = new Set([
  "event",
  "kind",
  "status",
  "type",
  "code",
  "op",
  "job",
  "provider",
  "resource",
  "outcome",
  "source",
  "signal",
  "transport",
  "meter",
  "purpose",
  "decision",
  "phase",
  "field",
  "interval",
  "overageMode",
  "mode",
  // How a clinic's calls reach us, so a suspension, an end of service or a
  // plan change that drops voice can print the steps for undoing forwarding
  // from catalog forwardingInstructions(...).undo; and the one action a
  // waiting channel needs (L4). Catalog ids, never words.
  "carrier",
  "phoneSystem",
  "routing",
  "waitingOn",
  // O3: what happened to a device (added, removed, locked).
  "change",
  // B1: the Terms version accepted at checkout ("2026-10-07.1").
  "version",
  // O9: the Knowledge section or Settings card to fix (lib/engine/practice
  // PRACTICE_SECTIONS), a closed vocabulary that never names the service.
  "section",
  // L15: the Meta app switched Off ("instagram"), an id, never a name.
  "platform",
  // L25 and I3: a support-chat escalation's topic and what is wrong, each an
  // id from lib/support/escalation-fields.ts's fixed lists, never words.
  "topic",
  "symptom",
]);

/** The class a key's value must belong to, or null when the key is not on the list. */
function classOfKey(key: string): ValueClass | null {
  // An opening date never enters a payload (X4); opening dates are gone.
  if (/open(ing|s)/i.test(key)) return null;
  if (key === "clinicName") return "clinicName";
  if (key === "deviceName") return "deviceName";
  if (key === "planName") return "planName";
  if (key === "planId" || key === "plan" || key === "boughtPlanId") return "planId";
  if (key === "channel" || key === "channels") return "channel";
  if (key === "rows" || /Rows$/.test(key)) return "rows";
  if (/^(is|has|was|can|will)[A-Z]/.test(key)) return "flag";
  if (/Cents$/.test(key)) return "cents";
  if (/Url$/.test(key)) return "url";
  if (/E164$/.test(key)) return "phone";
  if (/Masked$/.test(key)) return "masked";
  if (key === "id" || /Ids?$/.test(key)) return "id";
  // Before the date rule: `waitingOn` names a waiting state ("forwarding"),
  // not a day, and as a date every L4 payload would be refused at send time.
  if (CATEGORY_KEYS.has(key)) return "category";
  if (/(At|On)$/.test(key) || key === "windowStart" || key === "windowEnd") return "date";
  if (COUNT_KEYS.has(key) || /(Count|Days|Hours|Minutes|Percent)$/.test(key)) return "count";
  return null;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CATEGORY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const E164 = /^\+[1-9]\d{6,14}$/;
/**
 * Every name a payload may print for a plan: a package at its steps ("AYA
 * Voice + Web Chat, 500 minutes and 300 conversations"), or a package's name
 * alone ("AYA Voice"). A plan id is checked by parsing it (isPlanId), since
 * the grid of packages and usage steps (owner, 13 October 2026) is 495 plans;
 * their names are listed once, here, because a name cannot be parsed back
 * without guessing at its spelling.
 */
const PLAN_NAMES: ReadonlySet<string> = new Set([
  ...allPlans().map((p) => p.name),
  ...PACKAGES.map((p) => p.name),
]);
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_ARRAY = 200;
const MAX_DEPTH = 3;

/**
 * Refuse a payload holding anything outside the allowlist. Throws
 * PayloadNotAllowedError naming the field, never its value.
 */
export function assertPayloadAllowed(payload: unknown, kind?: EmailKind): void {
  if (!isPlainObject(payload)) {
    throw new PayloadNotAllowedError("(payload)", "is not an object.");
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) {
    throw new PayloadNotAllowedError("(payload)", `is over ${MAX_PAYLOAD_BYTES} bytes.`);
  }
  checkObject(payload, "", 0, kind);
}

function checkObject(
  value: Record<string, unknown>,
  prefix: string,
  depth: number,
  kind: EmailKind | undefined,
): void {
  for (const [key, field] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const cls = classOfKey(key);
    if (!cls) {
      throw new PayloadNotAllowedError(
        path,
        "is not on the allowlist: ids, counts, cents, ISO dates, plan and channel names, " +
          "the clinic's name, masked addresses, the clinic's own numbers and public URLs.",
      );
    }
    checkValue(field, cls, path, depth, kind);
  }
}

function checkValue(
  value: unknown,
  cls: ValueClass,
  path: string,
  depth: number,
  kind: EmailKind | undefined,
): void {
  if (value === null) return;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) {
      throw new PayloadNotAllowedError(path, `has more than ${MAX_ARRAY} entries.`);
    }
    if (cls !== "id" && cls !== "channel" && cls !== "rows") {
      throw new PayloadNotAllowedError(path, "may not be a list.");
    }
    value.forEach((item, i) => checkValue(item, cls, `${path}[${i}]`, depth, kind));
    return;
  }

  const fail = (why: string): never => {
    throw new PayloadNotAllowedError(path, why);
  };

  switch (cls) {
    case "rows":
      if (!isPlainObject(value)) fail("must be a list of rows.");
      if (depth >= MAX_DEPTH) fail("is nested too deeply.");
      checkObject(value as Record<string, unknown>, path, depth + 1, kind);
      return;
    case "id":
      if (typeof value !== "string" || !ID.test(value)) fail("must be an opaque id.");
      return;
    case "count":
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        fail("must be a count.");
      }
      return;
    case "cents":
      if (typeof value !== "number" || !Number.isInteger(value)) fail("must be whole cents.");
      return;
    case "date":
      if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
        fail("must be an ISO date.");
      }
      return;
    case "category":
      if (typeof value !== "string" || !CATEGORY.test(value)) fail("must be a bare category.");
      return;
    case "planId":
      if (!isPlanId(value)) fail("must be a catalog plan id.");
      return;
    case "planName":
      if (typeof value !== "string" || !PLAN_NAMES.has(value)) fail("must be a catalog plan name.");
      return;
    case "channel":
      if (typeof value !== "string" || !(CHANNELS as readonly string[]).includes(value)) {
        fail("must be a channel id.");
      }
      return;
    case "clinicName":
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 120 ||
        /[@\r\n]|:\/\/|\d{7,}/.test(value)
      ) {
        fail("must be a clinic's name.");
      }
      return;
    case "deviceName":
      if (!isAllowedDeviceName(value)) fail("must be a device's name.");
      return;
    case "masked":
      if (typeof value !== "string" || value.length > 120 || !/[*•]{2,}/.test(value)) {
        fail("must be masked.");
      }
      return;
    case "phone":
      if (typeof value !== "string" || !E164.test(value)) fail("must be an E.164 number.");
      return;
    case "url": {
      if (typeof value !== "string") fail("must be a URL.");
      const problem = linkProblem(value as string, kind);
      if (problem) fail(`is not a link an email may carry: ${problem}`);
      return;
    }
    case "flag":
      if (typeof value !== "boolean") fail("must be true or false.");
      return;
  }
}

/**
 * What staff called one of their own devices ("Front desk Mac"), the one
 * free-text field O3 and O4 carry: the user_factors CHECK's rules, and
 * nothing that could be an address, a link or a number someone could call.
 * The device's own name may break the last three (a label is only checked
 * for what the database can hold), so a writer that queues one asks here
 * first and leaves the name out rather than have the sender refuse the email
 * for good.
 */
export function isAllowedDeviceName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 60 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069@]|:\/\/|\d{7,}/.test(value)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// -----------------------------------------------------------------------------
// The link scanner
// -----------------------------------------------------------------------------

export class LinkNotAllowedError extends Error {
  constructor(problems: readonly string[]) {
    super(`Refusing to send: ${problems.join("; ")}`);
    this.name = "LinkNotAllowedError";
  }
}

/**
 * Payment pages Stripe hosts, which the billing emails link to (the hosted
 * invoice and receipt, the billing portal). Each URL is Stripe's own
 * capability link to one invoice, so it may carry Stripe's token; nothing of
 * ours rides on it.
 */
export const THIRD_PARTY_LINK_ORIGINS: readonly string[] = [
  "https://invoice.stripe.com",
  "https://pay.stripe.com",
  "https://billing.stripe.com",
];

/**
 * Where a token-bearing link of OURS may go even outside a link email: the
 * one-click stop link of an optional or commercial kind. Its token stops one
 * optional email for one clinic and signs no one in.
 */
export const UNSUBSCRIBE_PATH_PREFIX = "/email/stop/";

/** Anything shaped like a URL with a scheme, in text or in an attribute. */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)\]]+/gi;
/** Attribute values that a mail client may fetch or follow, whatever their scheme. */
const ATTRIBUTE_PATTERN =
  /\b(?:href|src|action|background|poster|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL_PATTERN = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
/**
 * What a credential looks like in a link: a long base64url run in mixed case.
 * Every single-use token here is 32 random bytes as base64url (43 characters),
 * and the chance one of those has no capital letter is negligible, while a
 * clinic's slug, a UUID or a hex id is all lower case and never trips it.
 */
const TOKEN_SHAPED = /^[A-Za-z0-9_-]{32,}$/;

/** Every link in a piece of text or HTML, deduplicated, in order of appearance. */
export function findLinks(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(URL_PATTERN)) found.push(match[0]);
  for (const match of content.matchAll(ATTRIBUTE_PATTERN)) found.push(match[1] ?? match[2] ?? "");
  for (const match of content.matchAll(CSS_URL_PATTERN)) found.push(match[1] ?? "");
  return [...new Set(found.map(unescapeEntities).filter((link) => link.trim() !== ""))];
}

function unescapeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** The origins an email from apps/app may link to. Read at call time, never at module scope. */
function allowedOrigins(): string[] {
  return [publicOrigin(), ...THIRD_PARTY_LINK_ORIGINS];
}

function internalOrigin(): string | null {
  const raw = process.env.HEALDESK_APP_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Why one link may not appear in an email of this kind, or null when it may. */
export function linkProblem(link: string, kind?: EmailKind | string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return "a link that is not an absolute URL";
  }

  const ours = publicOrigin();
  const internal = internalOrigin();
  if (internal && url.origin === internal) {
    return "a link to HEALDESK_APP_URL, the internal origin that must never reach a browser";
  }
  const developmentOrigin = process.env.NODE_ENV !== "production" && url.origin === ours;
  if (url.protocol !== "https:" && !developmentOrigin) {
    return `a ${url.protocol.replace(":", "")} link (https only)`;
  }
  if (!allowedOrigins().includes(url.origin)) {
    return `a link to ${url.origin}, which is not a public origin of ours`;
  }
  if (url.username || url.password) return "a link with credentials in it";

  if (url.origin === ours) {
    const kindKnown = typeof kind === "string" && isEmailKind(kind);
    if (url.pathname.startsWith(UNSUBSCRIBE_PATH_PREFIX)) {
      if (!kindKnown || !carriesUnsubscribe(kind)) {
        return "a stop link in an email that is neither optional nor commercial";
      }
    } else if (carriesToken(url) && (!kindKnown || !isLinkEmail(kind))) {
      return "a single-use token in an email that is not a link email";
    }
  }
  return null;
}

function carriesToken(url: URL): boolean {
  const segments = url.pathname.split("/").filter(Boolean);
  const values = [...url.searchParams.values()];
  return [...segments, ...values].some(
    (part) => TOKEN_SHAPED.test(part) && /[A-Z]/.test(part) && /[a-z]/.test(part),
  );
}

export type MessageParts = {
  subject: string;
  text: string;
  html: string;
  headers?: Readonly<Record<string, string>>;
};

/** Every link problem in a whole message: subject, both bodies and the headers. */
export function linkProblems(message: MessageParts, kind?: EmailKind | string): string[] {
  const problems: string[] = [];
  if (findLinks(message.subject).length > 0) problems.push("a link in the subject");
  const headerValues = Object.values(message.headers ?? {}).join("\n");
  for (const link of findLinks([message.text, message.html, headerValues].join("\n"))) {
    const problem = linkProblem(link, kind);
    if (problem) problems.push(problem);
  }
  return [...new Set(problems)];
}

/** The sender's runtime check: throws LinkNotAllowedError on the first message with a problem. */
export function assertLinksAllowed(message: MessageParts, kind?: EmailKind | string): void {
  const problems = linkProblems(message, kind);
  if (problems.length > 0) throw new LinkNotAllowedError(problems);
}

// -----------------------------------------------------------------------------
// The copy lint and the subject rules (tests and the seed script)
// -----------------------------------------------------------------------------

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const WEEKDAYS = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";

const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  // Nothing client-facing signals that we are new (the owner's decision).
  {
    pattern: /\b(pilot|beta|early access|first clinics|founding|cohort)\b/i,
    why: "a newness word",
  },
  // The claims rules (CLAUDE.md, "Claims and copy").
  { pattern: /\brevenue\b/i, why: '"revenue"' },
  { pattern: /\bHIPAA[- ]compliant\b/i, why: '"HIPAA compliant"' },
  { pattern: /\blive in two minutes\b/i, why: '"live in two minutes"' },
  { pattern: /\bwith every clinic\b/i, why: '"with every clinic"' },
  { pattern: /(?<!\bdeposits )\bcollected\b/i, why: '"collected" outside "deposits collected"' },
  // A promise needs its date (X1.3).
  { pattern: /\bwithin one business day\b/i, why: '"within one business day"' },
  // Opening dates are gone: a channel is sold only once it is ready.
  { pattern: /\bopening dates?\b/i, why: "an opening date" },
  { pattern: /\bcoming soon\b/i, why: "an opening date" },
  {
    pattern: new RegExp(
      `\\b(opens?|opening|launch(?:es|ing)?|goes live|go live)\\b[^.\\n]{0,40}?\\b(${WEEKDAYS}|${MONTHS}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2})\\b`,
      "i",
    ),
    why: "an opening date",
  },
];

/** Lower case, and every run of anything but letters and digits to one space. */
function wordsOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The HTML as a reader sees it: tags and the head removed, entities restored. */
export function visibleText(html: string): string {
  return unescapeEntities(
    html
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  );
}

/** What the copy lint refuses in this text: one reason per problem found. */
export function copyProblems(text: string): string[] {
  const problems: string[] = [];
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(text)) problems.push(why);
  }
  const haystack = ` ${wordsOf(text)} `;
  for (const name of TREATMENT_NAMES) {
    const needle = wordsOf(name);
    if (needle && haystack.includes(` ${needle} `)) problems.push(`a treatment name ("${name}")`);
  }
  return [...new Set(problems)];
}

export const MAX_SUBJECT_CHARS = 70;

/** A subject's problems: too long, or carrying a link. */
export function subjectProblems(subject: string): string[] {
  const problems: string[] = [];
  if ([...subject].length > MAX_SUBJECT_CHARS) {
    problems.push(`over ${MAX_SUBJECT_CHARS} characters`);
  }
  if (findLinks(subject).length > 0 || /\bwww\./i.test(subject)) problems.push("a link");
  return problems;
}
