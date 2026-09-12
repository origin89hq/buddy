// Rolls: the public catalogue page links every model with its chemistry.
import { attr, document, nodes } from "../catalogue-html.mjs";

export { rollsRecords as records } from "../manufacturer-adapters.mjs";

export async function discover(fetchHtml) {
  const html = await fetchHtml("https://rollsbattery.com/catalog/");
  const products = nodes(document(html), (n) => n.tagName === "a" && attr(n, "data-battery_name"))
    .map((n) => ({
      adapter: "rolls",
      model: attr(n, "data-battery_name"),
      url: attr(n, "href"),
      chemistry: attr(n, "data-battery_type"),
    }))
    .filter((p) => /^https:\/\/(?:www\.)?rollsbattery\.com\/battery\/[a-z0-9-]+\/$/.test(p.url));
  const unique = [...new Map(products.map((p) => [p.url, p])).values()];
  if (unique.length < 150 || unique.length > 500)
    throw new Error(`Unexpected Rolls catalogue size: ${unique.length}`);
  return unique;
}
