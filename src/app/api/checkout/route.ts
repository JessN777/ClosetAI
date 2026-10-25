import { NextResponse } from "next/server";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import { getPersonalSession, personalProfileSecret, withPersonalCookie } from "@/lib/personal-session";
import { clearPurchaseHistory, getCheckoutSettings, getCurrentDaySpend, getPurchaseAttempts, saveCheckoutSettings } from "@/lib/checkout-storage";
import { DEFAULT_CHECKOUT_SETTINGS, type CheckoutSettings } from "@/lib/checkout-types";
import { getVisaPaymentMethod } from "@/lib/visa-payment";

export const runtime = "nodejs";

function jsonError(message: string, status: number) { return NextResponse.json({ error: message }, { status }); }

export async function GET(request: Request) {
  if (process.env.DEMO_OFFLINE === "1") {
    return NextResponse.json({
      settings: DEFAULT_CHECKOUT_SETTINGS,
      attempts: [],
      spentTodayCents: 0,
      paymentAvailable: true,
      paymentMode: "test",
      paymentMethod: { brand: "Visa", last4: "4242" },
      cached: true,
    });
  }
  const session = getPersonalSession(request);
  const redis = getTryOnRedis();
  if (!personalProfileSecret() || !redis) {
    return NextResponse.json({ settings: DEFAULT_CHECKOUT_SETTINGS, attempts: [], spentTodayCents: 0, paymentAvailable: false, paymentMode: "unavailable", paymentMethod: null, storageAvailable: false });
  }
  try {
    const [settings, attempts, spentTodayCents, visaMethod] = await Promise.all([getCheckoutSettings(redis, session.id), getPurchaseAttempts(redis, session.id), getCurrentDaySpend(redis, session.id), getVisaPaymentMethod(session.id)]);
    const response = NextResponse.json({
      settings, attempts, spentTodayCents,
      paymentAvailable: visaMethod.available, paymentMode: visaMethod.available ? "visa" : "unavailable",
      paymentMethod: visaMethod.method,
      storageAvailable: true,
    });
    return withPersonalCookie(response, session.id, request);
  } catch {
    console.error(JSON.stringify({ event: "checkout_data_read_failed" }));
    return withPersonalCookie(NextResponse.json({ settings: DEFAULT_CHECKOUT_SETTINGS, attempts: [], spentTodayCents: 0, paymentAvailable: false, paymentMode: "unavailable", paymentMethod: null, storageAvailable: false }), session.id, request);
  }
}

export async function PATCH(request: Request) {
  if (process.env.DEMO_OFFLINE === "1") return jsonError("Offline demo settings are stored in this browser.", 409);
  const redis = getTryOnRedis();
  if (!redis || !personalProfileSecret()) return jsonError("Spending settings are temporarily unavailable.", 503);
  const body = await request.json().catch(() => null) as { perPurchaseLimit?: unknown; perDayLimit?: unknown; ifVersion?: unknown } | null;
  if (!body || !Number.isInteger(body.perPurchaseLimit) || !Number.isInteger(body.perDayLimit)) return jsonError("Enter whole dollar amounts for both spending limits.", 400);
  const perPurchase = Number(body.perPurchaseLimit);
  const perDay = Number(body.perDayLimit);
  if (perPurchase < 1 || perPurchase > 100_000 || perDay < 1 || perDay > 100_000) return jsonError("Each limit must be between $1 and $100,000.", 400);
  if (perDay < perPurchase) return jsonError("The per-day limit must be at least the per-purchase limit.", 400);
  const session = getPersonalSession(request);
  try {
    const current = await getCheckoutSettings(redis, session.id);
    const ifVersion = Number.isInteger(body.ifVersion) ? Number(body.ifVersion) : current.version;
    if (ifVersion !== current.version) return withPersonalCookie(NextResponse.json({ error: "Spending settings changed in another tab. Refresh and try again.", settings: current }, { status: 409 }), session.id, request);
    const next: CheckoutSettings = { perPurchaseLimitCents: perPurchase * 100, perDayLimitCents: perDay * 100, version: current.version + 1, updatedAt: Date.now() };
    if (!await saveCheckoutSettings(redis, session.id, next, ifVersion)) {
      return withPersonalCookie(NextResponse.json({ error: "Spending settings changed in another tab. Refresh and try again.", settings: await getCheckoutSettings(redis, session.id) }, { status: 409 }), session.id, request);
    }
    return withPersonalCookie(NextResponse.json({ settings: next }), session.id, request);
  } catch {
    console.error(JSON.stringify({ event: "checkout_settings_save_failed" }));
    return withPersonalCookie(jsonError("Could not save spending limits right now.", 503), session.id, request);
  }
}

export async function DELETE(request: Request) {
  if (process.env.DEMO_OFFLINE === "1") return NextResponse.json({ deleted: true, cached: true });
  const redis = getTryOnRedis();
  if (!redis || !personalProfileSecret()) return jsonError("Purchase history is temporarily unavailable.", 503);
  const session = getPersonalSession(request);
  try {
    await clearPurchaseHistory(redis, session.id);
    return withPersonalCookie(NextResponse.json({ deleted: true, attempts: [] }), session.id, request);
  } catch {
    console.error(JSON.stringify({ event: "purchase_history_clear_failed" }));
    return withPersonalCookie(jsonError("Could not clear purchase history right now.", 503), session.id, request);
  }
}
