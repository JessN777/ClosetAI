export type ProductListing = {
  name: string;
  retailer: string;
  price: string;
  numericPrice: number;
  imageUrl: string;
  href: string;
  listingProvider: "Google Shopping";
};

export type ProductSearchResult = { available: boolean; products: ProductListing[] };
type ShoppingResponse = { shopping_results?: unknown; error?: unknown; search_metadata?: { status?: unknown } };

function safeHttps(value: unknown, allowedHosts: string[]) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.toString() : "";
  } catch { return ""; }
}

/** Return normalized retailer listings. Thumbnails are taken only from shopping results, never from style-source pages. */
export async function searchShoppingProducts(query: string, limit = 8): Promise<ProductSearchResult> {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) return { available: false, products: [] };
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_shopping");
  url.searchParams.set("q", query.slice(0, 240));
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("gl", "us");
  url.searchParams.set("hl", "en");
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000), cache: "no-store" });
  if (!response.ok) throw new Error(`Product search provider returned ${response.status}.`);
  const payload = await response.json() as ShoppingResponse;
  if (!Array.isArray(payload.shopping_results)) return { available: true, products: [] };
  const products = payload.shopping_results.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const name = typeof row.title === "string" ? row.title.trim().slice(0, 180) : "";
    const retailer = typeof row.source === "string" ? row.source.trim().slice(0, 100) : "";
    const price = typeof row.price === "string" ? row.price.trim().slice(0, 40) : "";
    const numericPrice = typeof row.extracted_price === "number" ? row.extracted_price : Number(price.replace(/[^0-9.]/g, ""));
    const href = safeHttps(row.product_link, ["google.com"]);
    const imageUrl = safeHttps(row.thumbnail, ["serpapi.com", "gstatic.com", "googleusercontent.com"]);
    if (!name || !retailer || !price || !Number.isFinite(numericPrice) || numericPrice <= 0 || numericPrice > 100_000 || !href || !imageUrl) return [];
    return [{ name, retailer, price, numericPrice, imageUrl, href, listingProvider: "Google Shopping" as const }];
  });
  return { available: true, products: Array.from(new Map(products.map((item) => [item.href, item])).values()).slice(0, Math.max(1, Math.min(12, limit))) };
}
