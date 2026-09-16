/** Escape-first Markdown preview for Admin. Covers the toolbar subset
 *  (headings, emphasis, lists, links, fences, images, tables, quotes).
 *  Source HTML is escaped before any markup is applied, so this is safe
 *  to assign via `dangerouslySetInnerHTML`. */

const FENCE = "\u0000FENCE";
const CODE = "\u0000CODE";

export function renderMarkdownPreview(source: string): string {
  const fences: string[] = [];
  const inlines: string[] = [];
  let text = escapeHtml(source.replace(/\r\n/g, "\n"));
  text = text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, _lang: string, code: string) => {
    const index = fences.length;
    fences.push(`<pre><code>${code}</code></pre>`);
    return `${FENCE}${index}\u0000`;
  });
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = inlines.length;
    inlines.push(`<code>${code}</code>`);
    return `${CODE}${index}\u0000`;
  });
  const html = renderBlocks(text);
  return html
    .replace(new RegExp(`${FENCE}(\\d+)\u0000`, "g"), (_match, index: string) => fences[Number(index)] ?? "")
    .replace(new RegExp(`${CODE}(\\d+)\u0000`, "g"), (_match, index: string) => inlines[Number(index)] ?? "");
}

function renderBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (line.startsWith(FENCE)) {
      out.push(line);
      i += 1;
      continue;
    }
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^&gt; /.test(line) || line === "&gt;") {
      const quoted: string[] = [];
      while (i < lines.length && (/^&gt; /.test(lines[i] ?? "") || lines[i] === "&gt;")) {
        quoted.push((lines[i] ?? "").replace(/^&gt; ?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(quoted.join("\n"))}</blockquote>`);
      continue;
    }
    if (isTableRow(line) && isTableDivider(lines[i + 1] ?? "")) {
      const rows: string[] = [];
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        if (isTableDivider(lines[i] ?? "") && rows.length === 1) {
          i += 1;
          continue;
        }
        rows.push(lines[i] ?? "");
        i += 1;
      }
      out.push(renderTable(rows));
      continue;
    }
    if (isListLine(line)) {
      const items: Array<{ ordered: boolean; text: string }> = [];
      while (i < lines.length && isListLine(lines[i] ?? "")) {
        items.push(parseListLine(lines[i] ?? ""));
        i += 1;
      }
      const ordered = items[0]?.ordered === true;
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((item) => `<li>${renderInline(item.text)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      out.push("<hr>");
      i += 1;
      continue;
    }
    const paragraph: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (next.trim() === "" || next.startsWith(FENCE) || /^(#{1,6}) /.test(next) || isListLine(next) || isTableRow(next)) break;
      paragraph.push(next);
      i += 1;
    }
    out.push(`<p>${paragraph.map((item) => renderInline(item)).join("<br>")}</p>`);
  }
  return out.join("");
}

function renderInline(text: string): string {
  let out = text;
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, url: string) => {
    const src = safeUrl(url, "image");
    return src ? `<img src="${src}" alt="${alt}">` : alt;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    const href = safeUrl(url, "href");
    return href ? `<a href="${href}">${label}</a>` : label;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_/g, "$1<em>$2</em>");
  return out;
}

function isListLine(line: string): boolean {
  return /^(- |\* |\d+\. |- \[[ xX]\] )/.test(line);
}

function parseListLine(line: string): { ordered: boolean; text: string } {
  const task = /^- \[[ xX]\] (.*)$/.exec(line);
  if (task) return { ordered: false, text: task[1] ?? "" };
  const unordered = /^[-*] (.*)$/.exec(line);
  if (unordered) return { ordered: false, text: unordered[1] ?? "" };
  const ordered = /^\d+\. (.*)$/.exec(line);
  return { ordered: true, text: ordered?.[1] ?? line };
}

function isTableRow(line: string): boolean {
  return /^\|(.+)\|$/.test(line.trim());
}

function isTableDivider(line: string): boolean {
  return /^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(line.trim());
}

function renderTable(rows: string[]): string {
  if (rows.length === 0) return "";
  const header = splitRow(rows[0] ?? "");
  const body = rows.slice(1).map(splitRow);
  return `<table><thead><tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${
    body.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("")
  }</tbody></table>`;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeUrl(escaped: string, kind: "href" | "image"): string | null {
  const url = unescapeHtml(escaped).trim();
  if (kind === "href") {
    if (/^(https?:|mailto:|\/|#)/i.test(url) && !/[\s<>]/.test(url)) return escapeHtml(url);
    return null;
  }
  if (/^(https?:|\/)/i.test(url) && !/[\s<>]/.test(url)) return escapeHtml(url);
  return null;
}
