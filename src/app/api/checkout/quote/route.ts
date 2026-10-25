import { randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import { getPersonalSession, personalProfileSecret, withPersonalCookie } from "@/lib/personal-session";
import { getCheckoutSettings, getCurrentDaySpend, saveCheckoutCart } from "@/lib/checkout-storage";
import { getShopLookHistory, getWishlist } from "@/lib/shop-storage";
import { getVisaPaymentMethod } from "@/lib/visa-payment";
import { getSpentToday, type CheckoutCart, type CheckoutLine } from "@/lib/checkout-types";
import type { ShopLookPlan, ShopProduct } from "@/lib/shop-types";

export const runtime = "nodejs";

function isShopProduct(value: unknown): value is ShopProduct {
  if (!value || typeof value !== "object") return false;
  const product = value as Partial<ShopProduct>;
  try {
    const href = new URL(product.href ?? "");
    return href.protocol === "https:" && (href.hostname === "google.com" || href.hostname.endsWith(".google.com"))
      && typeof product.name === "string" && typeof product.retailer === "string"
      && typeof product.price === "string" && typeof product.numericPrice === "number"
      && Number.isFinite(product.numericPrice) && product.numericPrice > 0
      && typeof product.imageUrl === "string" && product.listingProvider === "Google Shopping";
  } catch { return false; }
}

function cents(value: number) { return Math.round(value * 100); }

export async function POST(request: Request) {
  if (process.env.DEMO_OFFLINE === "1") return NextResponse.json({ error: "Offline demo checkout quotes are created in the browser cache." }, { status: 409 });
  if (!personalProfileSecret()) return NextResponse.json({ error: "Checkout storage is not configured." }, { status: 503 });
  const body = await request.json().catch(() => null) as { hrefs?: unknown } | null;
  if (!body || !Array.isArray(body.hrefs) || body.hrefs.length < 1 || body.hrefs.length > 30 || body.hrefs.some((href) => typeof href !== "string")) return NextResponse.json({ error: "Choose at least one retailer listing for checkout." }, { status: 400 });
  const hrefs = Array.from(new Set((body.hrefs as string[]).slice(0, 30)));
  const redis = getTryOnRedis();
  if (!redis) return NextResponse.json({ error: "Checkout storage is temporarily unavailable." }, { status: 503 });
  const session = getPersonalSession(request);
  try {
    const [plans, wishlist, settings, dailySpentCents, visaMethod] = await Promise.all([
      getShopLookHistory(redis, session.id), getWishlist(redis, session.id), getCheckoutSettings(redis, session.id), getCurrentDaySpend(redis, session.id), getVisaPaymentMethod(session.id),
    ]);
    const trusted = new Map<string, CheckoutLine>();
    for (const item of wishlist) if (isShopProduct(item.product)) trusted.set(item.product.href, { pieceName: item.pieceName, product: item.product });
    for (const plan of plans as ShopLookPlan[]) for (const piece of plan.pieces ?? []) {
      const products = [piece.exactProduct, ...(piece.alternatives ?? [])];
      for (const product of products) if (isShopProduct(product)) trusted.set(product.href, { pieceName: piece.name, product });
    }
    const lines = hrefs.map((href) => trusted.get(href)).filter((line): line is CheckoutLine => Boolean(line));
    if (lines.length !== hrefs.length) return NextResponse.json({ error: "One or more listings are no longer in your saved shop list. Refresh it and try again." }, { status: 400 });

    const subtotalCents = lines.reduce((sum, line) => sum + cents(line.product.numericPrice), 0);
    const taxRate = Number(process.env.CHECKOUT_TAX_RATE ?? "0.0825");
    const taxCents = Math.round(subtotalCents * (Number.isFinite(taxRate) && taxRate >= 0 && taxRate <= 0.2 ? taxRate : 0.0825));
    const shippingEach = Number(process.env.CHECKOUT_SHIPPING_PER_RETAILER_CENTS ?? "695");
    const retailerCount = new Set(lines.map((line) => line.product.retailer.toLowerCase())).size;
    const shippingCents = (Number.isInteger(shippingEach) && shippingEach >= 0 && shippingEach <= 100_000 ? shippingEach : 695) * retailerCount;
    const now = Date.now();
    const cartId = randomUUID();
    const paymentAvailable = visaMethod.available;
    const cart: CheckoutCart = {
      cartId, confirmationToken: randomBytes(24).toString("base64url"), userId: session.id, lines,
      subtotalCents, taxCents, shippingCents, totalCents: subtotalCents + taxCents + shippingCents,
      taxRate: Number.isFinite(taxRate) && taxRate >= 0 && taxRate <= 0.2 ? taxRate : 0.0825,
      shippingRetailerCount: retailerCount,
      shippingPerRetailerCents: Number.isInteger(shippingEach) && shippingEach >= 0 && shippingEach <= 100_000 ? shippingEach : 695,
      currency: "USD", createdAt: now, expiresAt: now + 15 * 60_000, status: "quoted",
    };
    await saveCheckoutCart(redis, cart);
    const perPurchaseExceeded = cart.totalCents > settings.perPurchaseLimitCents;
    const perDayExceeded = dailySpentCents + cart.totalCents > settings.perDayLimitCents;
    const result = {
      cart: { ...cart, userId: undefined },
      settings,
      dailySpentCents,
      paymentAvailable,
      paymentMode: paymentAvailable ? "visa" : "unavailable",
      paymentMethod: visaMethod.method,
      limitError: perPurchaseExceeded ? "This cart exceeds your per-purchase limit." : perDayExceeded ? "This cart exceeds your remaining daily spending limit." : null,
    };
    return withPersonalCookie(NextResponse.json(result), session.id, request);
  } catch {
    console.error(JSON.stringify({ event: "checkout_quote_create_failed" }));
    return withPersonalCookie(NextResponse.json({ error: "Could not prepare checkout right now." }, { status: 503 }), session.id, request);
  }
}
