import type { InboundNotice, Verdict } from "./notice";
import type { ParsedMail } from "./parse";

/**
 * Whether an inbound email really comes from the domain in its From (lane
 * P7g, review of 26 October 2026). A From line is whatever the sender typed,
 * so an email is attributed to a clinic, joined to a clinic's case, or
 * acknowledged only when it is AUTHENTICATED:
 *
 *   - a DKIM signature that passed and is ALIGNED with the From domain: its
 *     d= is that domain, or a parent or subdomain of it (with at least two
 *     labels, so "d=com" aligns with nothing); or
 *   - DMARC passed (which already requires an aligned SPF or DKIM pass);
 *
 * and SES's DKIM verdict did not fail. Unsigned mail, mail signed only by
 * some other domain, and mail whose verdicts are unknown are not
 * authenticated: they become a case about no clinic, with no acknowledgement.
 *
 * Where the verdicts come from. SES's notice carries spam, virus, SPF, DKIM
 * and DMARC verdicts but not the signing domain. SES also writes its own
 * headers at the TOP of the stored message: X-SES-Spam-Verdict,
 * X-SES-Virus-Verdict and "Authentication-Results: amazonses.com; spf=...;
 * dkim=pass header.i=@example.com; dmarc=...". Only the topmost of each is
 * read, and the Authentication-Results only when its authserv-id is
 * amazonses.com: SES prepends its headers, so anything a sender wrote under
 * the same names sits below them and is never read. The notice's verdicts
 * win where it has them; the headers fill the rest, which is all of them for
 * a message the hourly sweep reads (it has no notice).
 *
 * A forwarded email (the owner's mailbox forwards hello@ to SES) normally
 * keeps the original signature, since forwarding leaves the body and the
 * signed headers alone, so a clinic's own DKIM still passes aligned at SES.
 */

export type Verdicts = InboundNotice["verdicts"];

export type Authentication = {
  /** The notice's verdicts, each UNKNOWN filled from SES's own headers. */
  verdicts: Verdicts;
  /** The domains (d=, or header.i's domain) whose DKIM signature passed, per SES. */
  dkimPassDomains: string[];
};

const SES_AUTHSERV = "amazonses.com";

function topmost(mail: ParsedMail, name: string): string | null {
  return mail.headers.get(name)?.[0] ?? null;
}

/** An Authentication-Results result word, as SES's verdict words. */
export function verdictOfResult(result: string): Verdict {
  switch (result.toLowerCase()) {
    case "pass":
      return "PASS";
    case "fail":
    case "softfail":
    case "hardfail":
    case "permfail":
      return "FAIL";
    case "none":
    case "neutral":
    case "policy":
      return "GRAY";
    case "temperror":
    case "permerror":
      return "PROCESSING_FAILED";
    default:
      return "UNKNOWN";
  }
}

function verdictHeader(value: string | null): Verdict {
  const word = value?.trim().toUpperCase() ?? "";
  return (["PASS", "FAIL", "GRAY", "PROCESSING_FAILED", "DISABLED"] as const).find((v) => v === word) ?? "UNKNOWN";
}

function domainOf(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/^@/, "");
  const domain = v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && domain.length <= 253 ? domain : null;
}

type Results = { spf: Verdict; dkim: Verdict; dmarc: Verdict; dkimPassDomains: string[] };

/** SES's own Authentication-Results (the topmost, authserv-id amazonses.com); null when there is none. */
export function sesAuthenticationResults(mail: ParsedMail): Results | null {
  const value = topmost(mail, "authentication-results");
  if (!value || value.length > 8 * 1024) return null;
  // Comments out ("(spfCheck: ...)"), one level, which is all SES writes.
  const parts = value.replace(/\([^()]{0,1024}\)/g, " ").split(";");
  const authserv = (parts.shift() ?? "").trim().split(/\s+/)[0]?.toLowerCase();
  if (authserv !== SES_AUTHSERV) return null;
  const out: Results = { spf: "UNKNOWN", dkim: "UNKNOWN", dmarc: "UNKNOWN", dkimPassDomains: [] };
  let dkimSeen = false;
  for (const part of parts) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const [method, result = ""] = (tokens[0] ?? "").toLowerCase().split("=");
    const verdict = verdictOfResult(result);
    if (method === "spf" && out.spf === "UNKNOWN") out.spf = verdict;
    else if (method === "dmarc" && out.dmarc === "UNKNOWN") out.dmarc = verdict;
    else if (method === "dkim") {
      // Any signature that passed makes it PASS; else the first result.
      if (!dkimSeen || verdict === "PASS") out.dkim = out.dkim === "PASS" ? "PASS" : verdict;
      dkimSeen = true;
      if (verdict === "PASS") {
        const prop = tokens.slice(1).find((t) => /^header\.d=/i.test(t)) ?? tokens.slice(1).find((t) => /^header\.i=/i.test(t));
        const domain = prop ? domainOf(prop.slice(prop.indexOf("=") + 1)) : null;
        if (domain && !out.dkimPassDomains.includes(domain)) out.dkimPassDomains.push(domain);
      }
    }
  }
  return out;
}

/** The notice's verdicts, each UNKNOWN filled from SES's own headers, and the domains whose DKIM passed. */
export function authenticate(mail: ParsedMail, notice: Pick<InboundNotice, "verdicts">): Authentication {
  const results = sesAuthenticationResults(mail);
  const fromHeaders: Verdicts = {
    spam: verdictHeader(topmost(mail, "x-ses-spam-verdict")),
    virus: verdictHeader(topmost(mail, "x-ses-virus-verdict")),
    spf: results?.spf ?? "UNKNOWN",
    dkim: results?.dkim ?? "UNKNOWN",
    dmarc: results?.dmarc ?? "UNKNOWN",
  };
  const pick = (k: keyof Verdicts): Verdict => (notice.verdicts[k] !== "UNKNOWN" ? notice.verdicts[k] : fromHeaders[k]);
  return {
    verdicts: { spam: pick("spam"), virus: pick("virus"), spf: pick("spf"), dkim: pick("dkim"), dmarc: pick("dmarc") },
    dkimPassDomains: results?.dkimPassDomains ?? [],
  };
}

/**
 * Whether SES's NOTICE itself (not the headers in the stored message) says
 * the mail passed: its DKIM verdict PASS, and its SPF and DMARC verdicts
 * PASS wherever the notice has them (UNKNOWN: not in the notice, not
 * counted). A support change runs on its own (DIRECT, lib/support/actions)
 * only for mail whose notice says so: the headers are safe to read only
 * because SES prepends its own, and a change healdesk makes unasked rests on
 * SES's own word as well. A message the hourly sweep reads has no notice,
 * so it never passes here.
 */
export function noticeVerdictsPass(notice: Pick<InboundNotice, "verdicts">): boolean {
  const { dkim, spf, dmarc } = notice.verdicts;
  if (dkim !== "PASS") return false;
  return [spf, dmarc].every((v) => v === "UNKNOWN" || v === "PASS");
}

/** Whether a DKIM signature that passed is aligned with this domain: the same, or a parent or subdomain. */
export function alignedDkimPass(auth: Authentication, domain: string): boolean {
  const from = domain.toLowerCase();
  return auth.dkimPassDomains.some((d) => d === from || from.endsWith(`.${d}`) || d.endsWith(`.${from}`));
}

/** Whether the From address is authenticated: aligned DKIM or DMARC passed, and DKIM did not fail. */
export function isAuthenticated(auth: Authentication, from: string | null): boolean {
  if (!from) return false;
  const domain = from.slice(from.lastIndexOf("@") + 1);
  if (!domain || auth.verdicts.dkim === "FAIL") return false;
  return alignedDkimPass(auth, domain) || auth.verdicts.dmarc === "PASS";
}
