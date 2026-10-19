import type { ReactNode } from "react";
import { prerender } from "react-dom/static";

/**
 * A page's HTML as a browser receives it, async server components and all.
 *
 * renderToStaticMarkup cannot wait for a component that awaits its data
 * (the setup wizard's calendar, deposits and channels steps do), so a page
 * with one is prerendered instead: every async component resolved, the whole
 * document in one string.
 */
export async function renderPage(element: ReactNode): Promise<string> {
  const { prelude } = await prerender(element);
  const reader = prelude.getReader();
  const decoder = new TextDecoder();
  let html = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html + decoder.decode();
}
