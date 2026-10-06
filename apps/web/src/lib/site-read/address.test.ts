import { describe, expect, test } from "vitest";

import { refusedAddress } from "./address";

/**
 * Every address a read connects to passes through refusedAddress first, so
 * each refused block is pinned here at its edges, in each notation an
 * address can arrive in: from DNS, from a URL, from a redirect.
 */

describe("refusedAddress, IPv4", () => {
  test.each([
    ["0.0.0.0", "this network"],
    ["0.255.255.255", "this network"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["100.127.255.255", "carrier-grade NAT"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "link-local, where cloud metadata lives"],
    ["169.254.0.1", "link-local, where cloud metadata lives"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.0.0.8", "protocol assignments"],
    ["192.0.2.10", "documentation"],
    ["192.88.99.1", "6to4 relay"],
    ["192.168.0.1", "private"],
    ["192.168.255.255", "private"],
    ["198.18.0.1", "benchmarking"],
    ["198.19.255.255", "benchmarking"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["224.0.0.1", "multicast or reserved"],
    ["239.255.255.250", "multicast or reserved"],
    ["240.0.0.1", "multicast or reserved"],
    ["255.255.255.255", "multicast or reserved"],
  ])("refuses %s (%s)", (address, label) => {
    expect(refusedAddress(address)).toBe(label);
  });

  test.each([
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    // The neighbours of each refused block are public.
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
  ])("allows %s", (address) => {
    expect(refusedAddress(address)).toBeNull();
  });
});

describe("refusedAddress, IPv6", () => {
  test.each([
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["fc00::1", "unique local"],
    ["fd12:3456:789a::1", "unique local"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "unique local"],
    ["fe80::1", "link-local"],
    ["febf::1", "link-local"],
    ["fec0::1", "site-local"],
    ["ff02::1", "multicast"],
    ["100::1", "discard"],
    ["64:ff9b:1::1", "local NAT64"],
    ["2001::1", "Teredo"],
    ["2001:db8::1", "documentation"],
    ["3fff:fff::1", "documentation"],
  ])("refuses %s (%s)", (address, label) => {
    expect(refusedAddress(address)).toBe(label);
  });

  // The ranges that carry an IPv4 address are refused whatever it is, in
  // either notation, and the reason says what the IPv4 address was.
  test.each([
    ["::ffff:127.0.0.1", "IPv4-mapped (carries 127.0.0.1, loopback)"],
    ["::ffff:7f00:1", "IPv4-mapped (carries 127.0.0.1, loopback)"],
    [
      "::ffff:169.254.169.254",
      "IPv4-mapped (carries 169.254.169.254, link-local, where cloud metadata lives)",
    ],
    [
      "::ffff:a9fe:a9fe",
      "IPv4-mapped (carries 169.254.169.254, link-local, where cloud metadata lives)",
    ],
    ["::ffff:10.0.0.1", "IPv4-mapped (carries 10.0.0.1, private)"],
    ["::ffff:8.8.8.8", "IPv4-mapped (carries 8.8.8.8, public)"],
    ["0:0:0:0:0:ffff:c0a8:101", "IPv4-mapped (carries 192.168.1.1, private)"],
    ["::127.0.0.1", "IPv4-compatible (carries 127.0.0.1, loopback)"],
    ["::a00:1", "IPv4-compatible (carries 10.0.0.1, private)"],
    ["64:ff9b::7f00:1", "NAT64 (carries 127.0.0.1, loopback)"],
    ["64:ff9b::8.8.8.8", "NAT64 (carries 8.8.8.8, public)"],
    ["2002:7f00:1::", "6to4 (carries 127.0.0.1, loopback)"],
    ["2002:808:808::1", "6to4 (carries 8.8.8.8, public)"],
  ])("refuses %s, which carries an IPv4 address", (address, label) => {
    expect(refusedAddress(address)).toBe(label);
  });

  test.each(["4000::1", "8000::1", "1::1", "e000::1"])(
    "refuses %s, outside global unicast",
    (address) => {
      expect(refusedAddress(address)).toBe("not global unicast");
    },
  );

  test.each([
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2a00:1450:4009:81f::200e",
    "2400:cb00::1",
  ])("allows %s", (address) => {
    expect(refusedAddress(address)).toBeNull();
  });

  test("refuses an address scoped to an interface", () => {
    expect(refusedAddress("fe80::1%eth0")).not.toBeNull();
  });
});

test.each([
  "",
  "localhost",
  "example.com",
  "010.0.0.1",
  "1.2.3",
  "1.2.3.4.5",
  "::g",
  "1:2:3:4:5:6:7:8:9",
  "[::1]",
])("refuses %j, which is not a plain address", (value) => {
  expect(refusedAddress(value)).not.toBeNull();
});
