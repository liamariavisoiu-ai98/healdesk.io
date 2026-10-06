import { isIP } from "node:net";

/**
 * The addresses the site read refuses to connect to.
 *
 * The website a buyer types at checkout is a URL a stranger chooses and our
 * server fetches, which is the shape of server-side request forgery: name an
 * address inside a network, or the cloud metadata service at
 * 169.254.169.254, and the server fetches it on your behalf. So every address
 * a read would connect to, whether it came from DNS, from the URL itself or
 * from a redirect, is checked here first, and fetch.ts connects to exactly the
 * address that passed (docs/design/funnel-onboarding-portal-2026-10-06.md,
 * Part B).
 *
 * The list is the plan's, plus the other special-purpose blocks
 * (documentation, benchmarking, relays, protocol assignments). None of them
 * hosts a clinic's website, so refusing them costs nothing. For IPv6 the rule
 * is stricter still: only global unicast, 2000::/3, is allowed at all, minus
 * the blocks inside it that tunnel to IPv4 or are reserved.
 *
 * An IPv6 address that carries an IPv4 one (mapped ::ffff:a.b.c.d, the old
 * compatible ::a.b.c.d, NAT64 64:ff9b::, 6to4 2002::) is refused whatever the
 * IPv4 address is, and the reason names it, so a log shows that ::ffff:7f00:1
 * was loopback and not merely "IPv6".
 */

type Range = { network: number[]; bits: number; label: string; embeds?: "low32" | "6to4" };

const V4_RANGES: Range[] = [
  ["0.0.0.0", 8, "this network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local, where cloud metadata lives"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4 relay"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  // 224/4 multicast and everything above it (240/4 reserved, the broadcast address).
  ["224.0.0.0", 3, "multicast or reserved"],
].map(([address, bits, label]) => ({
  network: v4Octets(address as string)!,
  bits: bits as number,
  label: label as string,
}));

const V6_RANGES: Range[] = [
  ["::", 128, "unspecified"],
  ["::1", 128, "loopback"],
  ["::ffff:0:0", 96, "IPv4-mapped", "low32"],
  ["::", 96, "IPv4-compatible", "low32"],
  ["64:ff9b::", 96, "NAT64", "low32"],
  ["64:ff9b:1::", 48, "local NAT64"],
  ["100::", 64, "discard"],
  ["2001::", 32, "Teredo"],
  ["2001:db8::", 32, "documentation"],
  ["2002::", 16, "6to4", "6to4"],
  ["3fff::", 20, "documentation"],
  ["fc00::", 7, "unique local"],
  ["fe80::", 10, "link-local"],
  ["fec0::", 10, "site-local"],
  ["ff00::", 8, "multicast"],
].map(([address, bits, label, embeds]) => ({
  network: v6Bytes(address as string)!,
  bits: bits as number,
  label: label as string,
  embeds: embeds as Range["embeds"],
}));

const GLOBAL_UNICAST: Range = { network: v6Bytes("2000::")!, bits: 3, label: "global unicast" };

function v4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    octets.push(Number(part));
  }
  return octets;
}

/** Sixteen bytes, or null. Handles `::` and a dotted IPv4 tail. */
function v6Bytes(address: string): number[] | null {
  let head = address;
  let tail: number[] = [];
  const lastColon = address.lastIndexOf(":");
  if (address.slice(lastColon + 1).includes(".")) {
    const v4 = v4Octets(address.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    // Keep the colon when it is half of a "::", so "::ffff:1.2.3.4" and
    // "::1.2.3.4" still expand around it.
    head = address.slice(0, address[lastColon - 1] === ":" ? lastColon + 1 : lastColon);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const left = groups(halves[0]);
  const right = groups(halves[1]);
  const words = 8 - tail.length / 2;
  let hextets: string[];
  if (halves.length === 2) {
    const missing = words - left.length - right.length;
    if (missing < 1) return null;
    hextets = [...left, ...Array<string>(missing).fill("0"), ...right];
  } else {
    hextets = left;
  }
  if (hextets.length !== words) return null;
  const bytes: number[] = [];
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/i.test(hextet)) return null;
    const value = parseInt(hextet, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return [...bytes, ...tail];
}

function inRange(bytes: readonly number[], range: Range): boolean {
  let bits = range.bits;
  for (let i = 0; bits > 0; i += 1, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((bytes[i]! & mask) !== (range.network[i]! & mask)) return false;
  }
  return true;
}

function refusedV4(octets: readonly number[]): string | null {
  return V4_RANGES.find((range) => inRange(octets, range))?.label ?? null;
}

function describeEmbedded(range: Range, bytes: readonly number[]): string {
  const v4 = range.embeds === "6to4" ? bytes.slice(2, 6) : bytes.slice(12, 16);
  return `${range.label} (carries ${v4.join(".")}, ${refusedV4(v4) ?? "public"})`;
}

/**
 * Why this address is refused, or null when the read may connect to it. Any
 * string that is not a plain IPv4 or IPv6 address is refused.
 */
export function refusedAddress(address: string): string | null {
  const family = isIP(address);
  if (family === 4) {
    const octets = v4Octets(address);
    return octets ? refusedV4(octets) : "not an address";
  }
  if (family !== 6) return "not an address";
  // A zone index names an interface on this machine, which is the point of refusing it.
  if (address.includes("%")) return "scoped to a local interface";
  const bytes = v6Bytes(address);
  if (!bytes) return "not an address";
  const range = V6_RANGES.find((candidate) => inRange(bytes, candidate));
  if (range) return range.embeds ? describeEmbedded(range, bytes) : range.label;
  return inRange(bytes, GLOBAL_UNICAST) ? null : "not global unicast";
}
