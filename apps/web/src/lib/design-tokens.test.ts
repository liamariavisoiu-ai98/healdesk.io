import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * The design tokens of 12 October 2026, held to: three corner radii, three
 * shadows, and the shared durations and easings (globals.css, "Design
 * tokens"). Each was a single source in the stylesheet and dozens of values
 * written out where they were used, which is how the site came to have 23
 * different corners. A value outside the set is what this file fails on, in
 * the markup's classes and in the stylesheet alike.
 *
 * What is not a token, and allowed: `rounded-full` and `rounded-none`, which
 * are shapes; the soul's blob radii (two values with a slash); a hairline or
 * a ring drawn with box-shadow (`0 0 0 Npx`), and an inset highlight in front
 * of a shadow token; and the periods of ambient loops (`infinite`), which are
 * rhythms rather than timings.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const SOURCES = files(SRC).map((path) => ({ path: path.slice(SRC.length), text: readFileSync(path, "utf8") }));
const CSS = readFileSync(join(SRC, "app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Class-shaped tokens of one kind, with any variant prefix, in every source file. */
function classes(pattern: RegExp) {
  const found: string[] = [];
  for (const { path, text } of SOURCES) {
    for (const match of text.matchAll(pattern)) found.push(`${path}: ${match[0]}`);
  }
  return found;
}

/** Every value of one property in the stylesheet. */
function declarations(property: string) {
  const re = new RegExp(`(?<![\\w-])${property}\\s*:\\s*([^;{}]*);`, "g");
  return [...CSS.matchAll(re)].map((match) => match[1]!.replace(/\s+/g, " ").trim());
}

describe("three corner radii", () => {
  test("the markup uses rounded-sm, -md, -lg, -full or -none, on any side", () => {
    const stray = classes(/(?<![\w-])rounded(?:-(?:tl|tr|bl|br|ss|se|es|ee|t|r|b|l|s|e))?(?:-[\w.[\]]+)?(?![\w[\]-])/g).filter(
      (hit) => !/rounded(?:-(?:tl|tr|bl|br|ss|se|es|ee|t|r|b|l|s|e))?-(?:sm|md|lg|full|none)$/.test(hit),
    );
    // Prose says "rounded" too; only a class is a radius.
    expect(stray.filter((hit) => !/: rounded$/.test(hit))).toEqual([]);
  });

  test("the stylesheet's corners are the tokens, a pill, nothing, or a blob", () => {
    const stray = declarations("border-radius").filter(
      (value) =>
        !/^var\(--radius-(sm|md|lg)\)$/.test(value) &&
        !/^min\(var\(--radius-(sm|md|lg)\), \d+%\)$/.test(value) &&
        !["0", "9999px", "50%", "inherit"].includes(value) &&
        !value.includes("/"),
    );
    expect(stray).toEqual([]);
  });

  test("Tailwind's own scale is cleared, so a stray size builds nothing", () => {
    expect(CSS).toMatch(/--radius-\*: initial;/);
    expect(CSS).toMatch(/--radius-sm: 6px;/);
  });
});

describe("three shadows", () => {
  test("the markup uses shadow-sm, -md, -lg or -none, and no shadow written out", () => {
    const stray = classes(/(?<![\w-])shadow(?:-[\w.[\]()/,-]+)?(?![\w[\]-])/g).filter(
      (hit) => !/shadow-(?:sm|md|lg|none)$/.test(hit) && !/: shadow$/.test(hit),
    );
    expect(stray).toEqual([]);
  });

  test("the stylesheet's shadows are the tokens, behind at most a ring or an inset highlight", () => {
    const stray = declarations("box-shadow").filter((value) => {
      if (value === "none") return false;
      const layers = value.split(/,(?![^(]*\))/).map((layer) => layer.trim());
      return !layers.every(
        (layer) => /^var\(--shadow-(sm|md|lg)\)$/.test(layer) || /^0 0 0 [\d.]+px /.test(layer) || /^inset 0 1px 0 /.test(layer),
      );
    });
    expect(stray).toEqual([]);
  });
});

describe("shared durations and easings", () => {
  test("the markup's durations are fast, base, slow or slower, and its easings are the tokens", () => {
    expect(classes(/(?<![\w-])duration-(?!fast\b|base\b|slow\b|slower\b)[\w[\]]+/g)).toEqual([]);
    expect(classes(/(?<![\w-])ease-(?!standard\b|out\b|in-out\b|spring\b|linear\b)[\w[\]().,-]+/g)).toEqual([]);
  });

  test("every transition and every one-off animation in the stylesheet times itself with the tokens", () => {
    const stray: string[] = [];
    for (const property of ["transition", "animation"]) {
      for (const value of declarations(property)) {
        for (const item of value.split(/,(?![^(]*\))/)) {
          if (item.includes("infinite") || item.trim() === "none") continue;
          // The duration is a token; a time written out beside it is a delay.
          const times = [...item.matchAll(/(?<![\w.-])(\d+(?:\.\d+)?m?s)(?![\w-])/g)].map((m) => m[1]!);
          const timed = item.includes("var(--duration-") || times.every((t) => /^0(?:\.01)?m?s$/.test(t));
          if (!timed) stray.push(`${property}: ${item.trim()}`);
          if (/cubic-bezier|(?<![\w-])ease(?:-in|-out|-in-out)?(?![\w-])/.test(item)) stray.push(`${property}: ${item.trim()}`);
        }
      }
    }
    expect(stray).toEqual([]);
  });
});
