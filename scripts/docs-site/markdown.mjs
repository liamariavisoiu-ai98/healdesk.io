/**
 * A small Markdown renderer, scoped to what docs/ actually uses.
 *
 * Deliberately not a dependency. The four documents use a narrow, surveyed
 * subset — headings, pipe tables, blockquotes, flat lists, a couple of fences,
 * and inline bold/code/links — and a general parser would add a package to a
 * production repo for an internal tool while giving less control over the
 * output structure, which the page needs for its section anchors.
 *
 * If a doc ever grows nested lists or reference links, extend this rather than
 * reaching for a library: the constraint is what keeps the output predictable.
 */

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Slug used for both the nav target and the deep link. */
export const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);

/**
 * Inline formatting.
 *
 * Code spans are lifted out first and replaced with a sentinel, so their
 * contents are never re-interpreted as emphasis or a link — `**` inside a code
 * span is a literal, and a naive ordering turns it into a tag.
 */
function inline(text) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `@@CODE${codes.length - 1}@@`;
  });

  out = escapeHtml(out);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    // Cross-doc links point at sibling markdown files; rewrite them to routes
    // in this site so the page never navigates away to a raw .md.
    const local = href.match(/^\.\/([\w-]+)\.md(#.*)?$/);
    const target = local ? `#/${local[1]}${local[2] ?? ""}` : href;

    // Two separate holes were open here, and both mattered because this page
    // carries a token that authorises an endpoint which edits the repository:
    //
    //   [x](javascript:…)          → script execution on click
    //   [x]("onmouseover="alert(1) → the quote closed the attribute and the
    //                                rest became new attributes
    //
    // So: allow only schemes that navigate, and escape the value that lands
    // inside the quotes. escapeHtml above ran on the whole string before the
    // href was extracted, so it is NOT sufficient on its own.
    const safe = /^(https?:\/\/|mailto:|#|\/|\.\/|[\w./-]+$)/i.test(target);
    if (!safe) return label;

    const attr = target.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const external = /^https?:/i.test(target);
    return `<a href="${attr}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*]+)\*/g, "$1<em>$2</em>");

  return out.replace(/@@CODE(\d+)@@/g, (_m, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}

const isTableRow = (l) => /^\s*\|/.test(l);
const isTableDivider = (l) => /^\s*\|[\s:|-]+\|?\s*$/.test(l);
const cells = (l) =>
  l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

/**
 * Render Markdown to HTML.
 *
 * Returns the headings alongside the HTML so the caller can build a nav without
 * re-parsing the output.
 */
export function render(markdown) {
  const lines = markdown.split("\n");
  const html = [];
  const headings = [];
  const state = { list: null };
  let i = 0;

  const closeList = () => {
    if (state.list) {
      html.push(state.list === "ul" ? "</ul>" : "</ol>");
      state.list = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      closeList();
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      html.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (isTableRow(line) && isTableDivider(lines[i + 1] ?? "")) {
      closeList();
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && isTableRow(lines[i])) body.push(cells(lines[i++]));
      html.push(
        `<div class="tw"><table><thead><tr>${head
          .map((c) => `<th>${inline(c)}</th>`)
          .join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }

    // Collected whole, then rendered recursively, so the numbered lists inside
    // the verbatim vendor emails keep their structure.
    if (/^>\s?/.test(line)) {
      closeList();
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      html.push(`<blockquote>${render(body.join("\n")).html}</blockquote>`);
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      const text = h[2].trim();
      const id = slug(text);
      if (level <= 3) headings.push({ level, text, id });
      html.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      closeList();
      html.push("<hr>");
      i += 1;
      continue;
    }

    const ul = line.match(/^[-*]\s+(.*)$/);
    const ol = line.match(/^(\d+)\.\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (state.list !== want) {
        closeList();
        html.push(want === "ul" ? "<ul>" : "<ol>");
        state.list = want;
      }
      // Continuation lines are indented and belong to the item just opened.
      const parts = [ul ? ul[1] : ol[2]];
      i += 1;
      while (
        i < lines.length &&
        /^\s{2,}\S/.test(lines[i]) &&
        !/^\s*[-*]\s/.test(lines[i]) &&
        !/^\s*\d+\.\s/.test(lines[i])
      ) {
        parts.push(lines[i].trim());
        i += 1;
      }
      html.push(`<li>${inline(parts.join(" "))}</li>`);
      continue;
    }

    if (line.trim() === "") {
      closeList();
      i += 1;
      continue;
    }

    closeList();
    const para = [line.trim()];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}\s|>|\s*[-*]\s|\d+\.\s|\s*```|\s*---+\s*$)/.test(lines[i]) &&
      !isTableRow(lines[i])
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    html.push(`<p>${inline(para.join(" "))}</p>`);
  }

  closeList();
  return { html: html.join("\n"), headings };
}
