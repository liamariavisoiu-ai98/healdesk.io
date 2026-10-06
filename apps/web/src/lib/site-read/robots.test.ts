import { describe, expect, test } from "vitest";

import { parseRobots, robotsAllows, type Robots } from "./robots";

const rules = (text: string): Robots => ({ kind: "rules", rules: parseRobots(text) });

describe("robots.txt, as RFC 9309 reads it", () => {
  test("a site that disallows everyone disallows us", () => {
    const robots = rules("User-agent: *\nDisallow: /\n");
    expect(robotsAllows(robots, "/")).toBe(false);
    expect(robotsAllows(robots, "/services")).toBe(false);
  });

  test("a group naming us replaces the * group, in either case and with a version", () => {
    const robots = rules(
      [
        "User-agent: *",
        "Disallow: /",
        "",
        "User-agent: HealdeskBot/1.0",
        "Disallow: /private",
      ].join("\n"),
    );
    expect(robotsAllows(robots, "/services")).toBe(true);
    expect(robotsAllows(robots, "/private/x")).toBe(false);
    const shouting = rules("User-agent: HEALDESKBOT\nDisallow: /\nUser-agent: *\nAllow: /\n");
    expect(robotsAllows(shouting, "/")).toBe(false);
  });

  test("another bot's group does not apply to us", () => {
    const robots = rules("User-agent: Googlebot\nDisallow: /\n");
    expect(robotsAllows(robots, "/")).toBe(true);
  });

  test("consecutive user-agent lines share a group, and other lines do not split it", () => {
    const robots = rules(
      "User-agent: otherbot\nSitemap: https://x.com/s.xml\nUser-agent: healdeskbot\nDisallow: /team\n",
    );
    expect(robotsAllows(robots, "/team")).toBe(false);
  });

  test("the longest match wins, and an allow wins a tie", () => {
    const robots = rules(
      "User-agent: *\nDisallow: /services\nAllow: /services/menu\nDisallow: /a\nAllow: /a\n",
    );
    expect(robotsAllows(robots, "/services/laser")).toBe(false);
    expect(robotsAllows(robots, "/services/menu")).toBe(true);
    expect(robotsAllows(robots, "/a")).toBe(true);
  });

  test("wildcards and the end anchor", () => {
    const robots = rules("User-agent: *\nDisallow: /*.php$\nDisallow: /*?\nDisallow: /tmp*/x\n");
    expect(robotsAllows(robots, "/index.php")).toBe(false);
    expect(robotsAllows(robots, "/index.php5")).toBe(true);
    expect(robotsAllows(robots, "/pricing?utm=1")).toBe(false);
    expect(robotsAllows(robots, "/tmp123/x/y")).toBe(false);
    expect(robotsAllows(robots, "/pricing")).toBe(true);
  });

  test("an empty Disallow allows everything, and comments are ignored", () => {
    expect(robotsAllows(rules("User-agent: * # everyone\nDisallow: # nothing\n"), "/")).toBe(true);
  });

  test("rules before any user-agent line belong to no group", () => {
    expect(robotsAllows(rules("Disallow: /\n"), "/")).toBe(true);
  });

  test("robots.txt itself is always allowed", () => {
    expect(robotsAllows(rules("User-agent: *\nDisallow: /\n"), "/robots.txt")).toBe(true);
  });

  test("no file allows everything; a server error allows nothing", () => {
    expect(robotsAllows({ kind: "allow-all" }, "/")).toBe(true);
    expect(robotsAllows({ kind: "disallow-all" }, "/")).toBe(false);
  });

  test("a hostile pattern cannot make matching slow", () => {
    const pattern = `/${"a*".repeat(400)}b`;
    const robots = rules(`User-agent: *\nDisallow: ${pattern}\n`);
    const started = performance.now();
    expect(robotsAllows(robots, `/${"a".repeat(2_000)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a pattern past the length cap errs toward not reading", () => {
    // A Disallow is cut short, which widens it.
    const disallow = rules(`User-agent: *\nDisallow: /${"x".repeat(2_000)}\n`);
    expect(robotsAllows(disallow, `/${"x".repeat(1_500)}`)).toBe(false);
    // An Allow is dropped, so the Disallow it would have beaten still holds.
    const allow = rules(`User-agent: *\nDisallow: /x\nAllow: /${"x".repeat(2_000)}\n`);
    expect(robotsAllows(allow, `/${"x".repeat(2_000)}`)).toBe(false);
  });
});
