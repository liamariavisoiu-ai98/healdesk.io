import { isIP } from "node:net";

/**
 * The address a browser-facing request came from, as far as our own proxies
 * can vouch for it.
 *
 * On AWS every request reaches the app through the load balancer, which
 * appends the address it accepted the connection from to `X-Forwarded-For`
 * and keeps whatever the request already carried to the left of it. A browser
 * can send `X-Forwarded-For: 198.51.100.1` and the balancer passes it on, so
 * the FIRST entry is whatever the client typed, and reading it would let
 * anyone choose the address in an audit row or open a fresh per-address
 * throttle window with every request. Only entries our own proxies appended
 * can be believed, and they are the ones on the right.
 *
 * TRUSTED_PROXY_HOPS is how many of our proxies append to the header: one,
 * the ALB. The web task's TLS sidecar (infra/aws/images/tls-proxy) must pass
 * the header through untouched, which nginx does unless told to append; a
 * proxy that appends, there or anywhere in front of the app, needs this count
 * to grow with it, or every request records that proxy's address. One hop is
 * also right off AWS: Vercel replaces the header with the client's address
 * alone, and with no proxy at all (`next start` on a laptop) Next fills an
 * absent header from the socket.
 *
 * Only for requests a browser makes. The routes apps/web calls with a signed
 * request (/api/provision, /api/agreements and its PDF) keep reading the
 * first entry: for /api/agreements apps/web puts the signer's address there,
 * the entry the balancer appends is Vercel's, and nobody else can make the
 * request at all.
 */
export const TRUSTED_PROXY_HOPS = 1;

/**
 * The client address, or undefined when the header is missing, holds fewer
 * entries than the trusted hops, or the entry there is not an IP address.
 *
 * The load balancer writes `ip:port` and `[ipv6]:port` when client-port
 * preservation is on (routing.http.xff_client_port.enabled), so the port is
 * dropped. An IPv6 zone (`fe80::1%eth0`) is refused: it means nothing off the
 * host, and node's isIP accepts one of any length.
 */
export function clientIp(headers: Pick<Headers, "get">): string | undefined {
  const header = headers.get("x-forwarded-for");
  if (header === null) return undefined;

  // Counted exactly, empty entries included: dropping one would shift a
  // client-written entry into the trusted position.
  const chain = header.split(",").map((entry) => entry.trim());
  const entry = chain[chain.length - TRUSTED_PROXY_HOPS];
  if (!entry) return undefined;

  const address = withoutPort(entry);
  return address.includes("%") || isIP(address) === 0 ? undefined : address;
}

function withoutPort(entry: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry);
  if (bracketed) return bracketed[1]!;
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(entry);
  return ipv4WithPort ? ipv4WithPort[1]! : entry;
}
