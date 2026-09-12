import { parse } from "parse5";

export const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value;
export function nodes(node, predicate) {
  return [
    ...(predicate(node) ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child) => nodes(child, predicate)),
  ];
}
export const document = (html) => parse(html);
export function text(node) {
  if (["script", "style", "sup"].includes(node.tagName)) return "";
  if (node.tagName === "br") return " ";
  if (node.nodeName === "#text") return node.value;
  return (node.childNodes ?? [])
    .map(text)
    .join(node.tagName === "br" ? " " : "")
    .replace(/\s+/g, " ")
    .trim();
}
// Browsers treat a span that is not a positive integer ("100%", "50%", "") as 1.
// Discover's pages carry percentage spans, so mirror the browser instead of refusing the page.
export function span(raw) {
  const n = Number(raw ?? 1);
  if (!Number.isInteger(n) || n < 1) return 1;
  if (n > 100) throw new Error("Invalid table span");
  return n;
}
export function tables(html) {
  return nodes(document(html), (n) => n.tagName === "table").map((table) => {
    const grid = [];
    const ownRows = nodes(table, (n) => n.tagName === "tr").filter((row) => {
      let parent = row.parentNode;
      while (parent && parent.tagName !== "table") parent = parent.parentNode;
      return parent === table;
    });
    for (const [y, row] of ownRows.entries()) {
      grid[y] ??= [];
      let x = 0;
      for (const cell of (row.childNodes ?? []).filter((n) => ["td", "th"].includes(n.tagName))) {
        while (grid[y][x] !== undefined) x++;
        const width = span(attr(cell, "colspan")),
          height = span(attr(cell, "rowspan"));
        for (let dy = 0; dy < height; dy++) {
          grid[y + dy] ??= [];
          for (let dx = 0; dx < width; dx++) {
            if (grid[y + dy][x + dx] !== undefined) throw new Error("Overlapping table cells");
            grid[y + dy][x + dx] = text(cell);
          }
        }
        x += width;
      }
    }
    return grid;
  });
}
