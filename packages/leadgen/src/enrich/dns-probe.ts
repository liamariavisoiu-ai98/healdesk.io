import { Resolver } from "node:dns/promises";

/**
 * Booking platforms found through DNS, when the page gives nothing away.
 *
 * The blind spot this closes: a platform serving from the clinic's own domain
 * has no vendor hostname in the page, so href matching is structurally unable
 * to see it. But the DNS record underneath still points at the vendor —
 * `book.clinic.com` is a CNAME to `customhosts1.zenoti.com`, and no amount of
 * white-labelling changes that, because the vendor has to terminate the
 * request somewhere they control.
 *
 * ## What this is worth, measured rather than hoped
 *
 * An adversarial review measured the real yield at roughly 1.2–1.8% net-new
 * in-segment clinics — perhaps 55–80 across 4,512, not the 8% a naive count of
 * "flips" suggests. Most flips turn out to be either already caught by the
 * language model's own guess, or patient-portal logins rather than booking, or
 * marketing agencies that are not targets at all.
 *
 * It earns its place anyway because it is free and needs nobody's cooperation:
 * public DNS over HTTPS, no scraping, no terms of service to breach, and no
 * request to the clinic's own servers. But it is a supplement to the signature
 * table, not a substitute, and the honest expectation is dozens of clinics
 * rather than hundreds.
 */

/** Subdomains worth asking about. Ordered by how often they actually resolve. */
const BOOKING_SUBDOMAINS = [
  "book",
  "booking",
  "bookings",
  "schedule",
  "scheduling",
  "appointments",
  "appointment",
  "portal",
  "patient",
  "patients",
  "my",
  "client",
  "clients",
  "online",
  "reserve",
  "widget",
] as const;

/**
 * CNAME targets that identify a platform.
 *
 * Every entry was observed in live DNS during research, not inferred from
 * vendor marketing. Matching is a suffix test on the resolved target, so
 * regional shards (`customhosts1amrs14.zenoti.com`) match their parent.
 */
const CNAME_SIGNATURES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["zenoti", ["zenoti.com"]],
  ["aesthetic-record", ["myaestheticrecord.com"]],
  ["gohighlevel", ["msgsndr.com", "leadconnectorhq.com", "ludicrous.cloud"]],
  ["zoho-bookings", ["zohohost.com", "zohobooks.com"]],
  ["boulevard", ["boulevard.io", "joinblvd.com", "blvd.app", "blvd.co"]],
  ["mangomint", ["mangomint.com"]],
  ["meevo", ["meevo.com"]],
  ["symplast", ["symplast.com"]],
  ["patientnow", ["patientnow.com", "mypatientnow.com"]],
  ["mindbody", ["mindbodyonline.com", "healcode.com"]],
  ["klara", ["klara.com"]],
  ["drchrono", ["drchrono.com"]],
  ["phreesia", ["phreesia.com", "phreesia.me", "phreesia.net"]],
  ["vsappointments", ["vsappointments.com"]],
  ["prospyr", ["prospyrmed.com"]],
];

/** SPF includes that name a platform. Read from the apex TXT records. */
const SPF_SIGNATURES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["gohighlevel", ["spf.leadconnectorhq.com"]],
  ["zoho-bookings", ["sender.zohobooks.com", "zcsend.net"]],
];

export type DnsFinding = {
  domain: string;
  platform: string;
  /** The record that proved it, so a human can re-check in one command. */
  evidence: string;
  source: "cname" | "spf";
};

export type DnsProbeOptions = {
  concurrency?: number;
  /** Resolvers to spread queries across. */
  servers?: readonly string[];
  onProgress?: (done: number, total: number) => void;
};

function matchTarget(
  target: string,
  table: ReadonlyArray<readonly [string, readonly string[]]>,
): string | null {
  const t = target.toLowerCase().replace(/\.$/, "");
  for (const [platform, suffixes] of table) {
    if (suffixes.some((s) => t === s || t.endsWith(`.${s}`))) return platform;
  }
  return null;
}

/**
 * One domain: probe its booking subdomains and its apex SPF.
 *
 * The wildcard control is the important part. Plenty of domains answer every
 * subdomain query — a catch-all A record, a parked-domain service, an
 * overzealous CDN — and without checking, every one of those looks like it has
 * sixteen booking subdomains. A random label nobody would ever register is
 * asked first, and if it resolves, the domain's subdomain answers carry no
 * information and are discarded.
 */
export async function probeDomain(
  domain: string,
  resolver: Resolver,
  nonce: string,
): Promise<DnsFinding[]> {
  const findings: DnsFinding[] = [];
  const bare = domain.replace(/^www\./, "");

  let wildcard = false;
  try {
    await resolver.resolveCname(`${nonce}.${bare}`);
    wildcard = true;
  } catch {
    // The expected outcome: the nonce does not resolve, so real answers mean
    // something.
  }

  if (!wildcard) {
    for (const sub of BOOKING_SUBDOMAINS) {
      try {
        const targets = await resolver.resolveCname(`${sub}.${bare}`);
        for (const target of targets) {
          const platform = matchTarget(target, CNAME_SIGNATURES);
          if (platform) {
            findings.push({
              domain: bare,
              platform,
              evidence: `${sub}.${bare} CNAME ${target}`,
              source: "cname",
            });
          }
        }
      } catch {
        // NXDOMAIN is the common case and carries no information.
      }
    }
  }

  try {
    const txt = await resolver.resolveTxt(bare);
    for (const record of txt.flat()) {
      if (!record.toLowerCase().startsWith("v=spf1")) continue;
      const platform = matchTarget2(record, SPF_SIGNATURES);
      if (platform) {
        findings.push({
          domain: bare,
          platform,
          evidence: `TXT ${record.slice(0, 90)}`,
          source: "spf",
        });
      }
    }
  } catch {
    // No TXT records, or the lookup failed. Neither is evidence.
  }

  // One finding per platform. A clinic with book. and booking. both pointing at
  // Zenoti is one Zenoti customer, not two.
  const seen = new Set<string>();
  return findings.filter((f) =>
    seen.has(f.platform) ? false : (seen.add(f.platform), true),
  );
}

/** SPF includes are substrings of a record, not a resolved hostname. */
function matchTarget2(
  record: string,
  table: ReadonlyArray<readonly [string, readonly string[]]>,
): string | null {
  const r = record.toLowerCase();
  for (const [platform, needles] of table) {
    if (needles.some((n) => r.includes(n))) return platform;
  }
  return null;
}

export async function probeDomains(
  domains: readonly string[],
  options: DnsProbeOptions = {},
): Promise<DnsFinding[]> {
  const concurrency = Math.max(1, options.concurrency ?? 12);
  const servers = options.servers ?? ["8.8.8.8", "1.1.1.1", "9.9.9.9"];
  const findings: DnsFinding[] = [];

  // A fixed nonce per run rather than a random one, so a re-run asks the same
  // questions and can be compared against the last.
  const nonce = "nx-healdesk-control";
  let cursor = 0;
  let done = 0;

  const worker = async (slot: number): Promise<void> => {
    const resolver = new Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers([servers[slot % servers.length]!]);

    for (;;) {
      const index = cursor++;
      if (index >= domains.length) return;

      try {
        findings.push(...(await probeDomain(domains[index]!, resolver, nonce)));
      } catch {
        // A resolver failure is not a finding either way.
      }

      done += 1;
      if (done % 50 === 0) options.onProgress?.(done, domains.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, domains.length) }, (_, i) =>
      worker(i),
    ),
  );

  options.onProgress?.(done, domains.length);
  return findings;
}
