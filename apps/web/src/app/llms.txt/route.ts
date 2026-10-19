import { FAMILIES, FAMILY_ORDER, livePieces, piecePath } from "@/lib/content/registry";
import { absoluteUrl } from "@/lib/seo";
import { site } from "@/lib/site";

/**
 * /llms.txt: a short Markdown index of the pages that say what healdesk is
 * and what it has published, in the format proposed at llmstxt.org.
 *
 * Optional and cheap. Google says these files neither help nor hurt in
 * Search, and no AI search engine documents reading one; it is here because
 * it costs nothing to keep true, and it is generated from the same registry
 * as the sitemap so it can never list a draft or miss a new page.
 */
export const dynamic = "force-static";

export function GET(): Response {
  const lines: string[] = [
    `# ${site.name}`,
    "",
    `> ${site.entityDescription}`,
    "",
    `${site.name} sells this AI receptionist. Its guides and research below are sourced and dated, rank no vendor, and close with a short note on how ${site.agent} handles the question.`,
    "",
    "## Product",
    "",
    `- [Pricing](${absoluteUrl("/pricing")}): every product's monthly price per 100 minutes or conversations, and the setup fee`,
    `- [About ${site.name}](${absoluteUrl("/about")}): what the company is, and how it sources and corrects what it publishes`,
  ];

  for (const family of FAMILY_ORDER) {
    const pieces = livePieces(family);
    if (pieces.length === 0) continue;
    lines.push("", `## ${FAMILIES[family].plural}`, "");
    for (const piece of pieces) {
      lines.push(`- [${piece.title}](${absoluteUrl(piecePath(piece))}): ${piece.description}`);
    }
  }

  lines.push("", "## Reference", "", `- [Glossary](${absoluteUrl("/glossary")}): one-sentence definitions of the terms`);

  return new Response(`${lines.join("\n")}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
