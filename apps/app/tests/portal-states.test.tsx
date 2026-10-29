import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { EmptyState, ErrorState, LoadingState } from "@/app/c/[slug]/states";

describe("portal states", () => {
  test("empty state: one sentence, optional action, polite live region only when asked", () => {
    const plain = renderToStaticMarkup(<EmptyState>Nothing here yet.</EmptyState>);
    expect(plain).toContain("Nothing here yet.");
    expect(plain).not.toContain("aria-live");
    const live = renderToStaticMarkup(
      <EmptyState live action={<a href="/x">Go</a>}>
        No match.
      </EmptyState>,
    );
    expect(live).toContain('role="status"');
    expect(live).toContain('aria-live="polite"');
    expect(live).toContain('href="/x"');
  });

  test("error state: alert role, our words, opaque reference only", () => {
    const html = renderToStaticMarkup(<ErrorState reference="d1g3st" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again in a moment");
    expect(html).toContain("Reference: d1g3st");
    expect(html).not.toMatch(/stack|Error:|at \w+ \(/i);
    expect(renderToStaticMarkup(<ErrorState />)).not.toContain("Reference");
  });

  test("loading state: spoken label, decorative blocks, pulse only when motion is allowed", () => {
    const html = renderToStaticMarkup(<LoadingState label="Loading billing" rows={2} />);
    expect(html).toContain("Loading billing");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("motion-safe:animate-pulse");
    expect(html).not.toMatch(/(^|\s)animate-pulse/);
    expect(html.match(/h-14/g)).toHaveLength(2);
  });
});
