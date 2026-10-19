import { toE164 } from "@healdesk/connectors";

/**
 * Which line forwarded a call to AYA, as the carrier said it: the SIP
 * `Diversion` header (RFC 5806) and `History-Info` (RFC 7044), which a
 * forwarding carrier adds when it sends a call on to another number.
 *
 * The voice agent has one use for it: a call plainly forwarded from the
 * clinic's own published line, with the caller's number kept, is proof that
 * the clinic's call forwarding works, so phone's clinic step is met without
 * an operator or a test window (lib/onboarding/forwarding-test.ts,
 * observeForwardingCall). A call that carries neither header proves nothing
 * about forwarding: AYA's own number can also be dialled directly, by staff
 * trying it from a mobile, and that call must not take phone live.
 *
 * Retell turns these two headers of an inbound call into the call's dynamic
 * variables, named in lower case (`diversion`, `history-info`), and lists
 * them in `custom_sip_headers` where the call came over SIP (Retell's
 * "Inbound custom SIP headers"). Both are read. Whether Retell's own numbers
 * receive the header from the forwarding carrier is not yet seen on a real
 * call: until it is, a clinic's own "Test it now" is what proves forwarding.
 *
 * ⚠️ The numbers parsed here are kept in memory for the call only and never
 * stored: the one fact written is whether the clinic's published number was
 * among them. A Diversion chain can, in principle, name a patient's own
 * phone that forwarded to the clinic.
 */

/** Which forwarding condition the carrier named for this hop. */
export type ForwardCondition = "busy" | "no_answer" | "all" | "unknown";

export type ForwardedFrom = {
  /** The number that forwarded the call, E.164. */
  numberE164: string;
  condition: ForwardCondition;
};

/** Long enough for any real header; a longer one is not parsed. */
const MAX_HEADER_CHARS = 4096;
/** A real chain is one to three hops. */
const MAX_ENTRIES = 10;

/** RFC 5806's reason values, as the forwarding condition they mean. */
function diversionCondition(reason: string | undefined): ForwardCondition {
  switch (reason?.toLowerCase()) {
    case "user-busy":
      return "busy";
    case "no-answer":
    case "unavailable":
    case "out-of-service":
      return "no_answer";
    case "unconditional":
      return "all";
    default:
      return "unknown";
  }
}

/** RFC 4458's cause values on a History-Info entry, as the condition they mean. */
function causeCondition(cause: string | undefined): ForwardCondition {
  switch (cause) {
    case "486":
      return "busy";
    case "408":
    case "480":
    case "503":
      return "no_answer";
    case "302":
      return "all";
    default:
      return "unknown";
  }
}

/** A header's entries: split on commas outside angle brackets and quotes. */
function entries(header: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") depth += 1;
    else if (!quoted && ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0 && !quoted) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((e) => e.trim()).filter(Boolean);
}

/** The telephone number a SIP or tel URI names, E.164, or null when it names none. */
function uriNumber(entry: string): string | null {
  const match = /(?:sips?|tel):([^@;>,?\s]+)/i.exec(entry);
  if (!match) return null;
  let user = match[1]!;
  try {
    user = decodeURIComponent(user);
  } catch {
    return null;
  }
  // Visual separators only: a user part with letters is a name, not a number.
  if (!/^\+?[\d\s().-]+$/.test(user)) return null;
  return toE164(user) ?? null;
}

/** Diversion: every entry is a line that forwarded the call, the latest first. */
export function parseDiversion(header: string): ForwardedFrom[] {
  if (header.length > MAX_HEADER_CHARS) return [];
  const out: ForwardedFrom[] = [];
  for (const entry of entries(header).slice(0, MAX_ENTRIES)) {
    const numberE164 = uriNumber(entry);
    if (!numberE164) continue;
    // The reason is a header parameter, after the URI's closing bracket where there is one.
    const params = entry.includes(">") ? entry.slice(entry.lastIndexOf(">") + 1) : entry;
    const reason = /;\s*reason\s*=\s*"?([a-z-]+)"?/i.exec(params)?.[1];
    out.push({ numberE164, condition: diversionCondition(reason) });
  }
  return out;
}

/**
 * History-Info: the targets the call was sent to, in order. Every entry but
 * the last is a number the call was forwarded from; the last is where it
 * arrived, AYA's own number. The cause of a retarget rides on the entry
 * that was left (`?Reason=SIP;cause=486`, percent-encoded).
 */
export function parseHistoryInfo(header: string): ForwardedFrom[] {
  if (header.length > MAX_HEADER_CHARS) return [];
  const all = entries(header).slice(0, MAX_ENTRIES + 1);
  const out: ForwardedFrom[] = [];
  for (const entry of all.slice(0, -1)) {
    const numberE164 = uriNumber(entry);
    if (!numberE164) continue;
    let decoded = entry;
    try {
      decoded = decodeURIComponent(entry);
    } catch {
      // Keep the raw entry: an unreadable cause is "unknown".
    }
    const cause = /cause\s*=\s*(\d{3})/i.exec(decoded)?.[1];
    out.push({ numberE164, condition: causeCondition(cause) });
  }
  return out;
}

function stringField(source: unknown, name: string): string | null {
  if (!source || typeof source !== "object") return null;
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (key.toLowerCase() === name && typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * The lines that forwarded a call, from Retell's call object (`call_details`
 * on the custom-LLM socket): its dynamic variables and its custom SIP
 * headers, Diversion first. Empty when the call carries neither header.
 */
export function forwardedFromCall(call: unknown): ForwardedFrom[] {
  if (!call || typeof call !== "object") return [];
  const record = call as Record<string, unknown>;
  const sources = [record.retell_llm_dynamic_variables, record.custom_sip_headers];
  const out: ForwardedFrom[] = [];
  const seen = new Set<string>();
  const add = (list: ForwardedFrom[]) => {
    for (const hop of list) {
      if (seen.has(hop.numberE164) || out.length >= MAX_ENTRIES) continue;
      seen.add(hop.numberE164);
      out.push(hop);
    }
  };
  for (const source of sources) {
    const diversion = stringField(source, "diversion");
    if (diversion) add(parseDiversion(diversion));
  }
  for (const source of sources) {
    const history = stringField(source, "history-info");
    if (history) add(parseHistoryInfo(history));
  }
  return out;
}

/** The hop that forwarded the call from `published`, the clinic's own line, or null. */
export function forwardedFromLine(
  forwardedFrom: readonly ForwardedFrom[] | undefined,
  published: string | null,
): ForwardedFrom | null {
  if (!published || !forwardedFrom) return null;
  return forwardedFrom.find((hop) => hop.numberE164 === published) ?? null;
}
