import { timingSafeEqual, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getTryOnRedis } from "@/lib/tryon-jobs";
import { getPersonalSession, personalProfileSecret, withPersonalCookie } from "@/lib/personal-session";
import { beginPurchase, finishPurchase, getCheckoutCart, getCheckoutSettings, getCurrentDaySpend, getPurchaseAttempts } from "@/lib/checkout-storage";
import { getSpentToday, type PurchaseAttempt } from "@/lib/checkout-types";
import { authorizeVisaCart } from "@/lib/visa-payment";

export const runtime = "nodejs";
export const maxDuration = 20;

function error(message: string, status: number) { return NextResponse.json({ error: message }, { status }); }

export async function POST(request: Request) {
  if (process.env.DEMO_OFFLINE === "1") return error("Offline demo payment is simulated in the browser.", 409);
  if (!personalProfileSecret()) return error("Checkout is not configured.", 503);
  const body = await request.json().catch(() => null) as { cartId?: unknown; confirmationToken?: unknown; confirm?: unknown } | null;
  if (!body || body.confirm !== true || typeof body.cartId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.cartId) || typeof body.confirmationToken !== "string") return error("Confirm this exact cart in the checkout screen.", 400);
  const redis = getTryOnRedis();
  if (!redis) return error("Checkout is temporarily unavailable. Save these items for later.", 503);
  const session = getPersonalSession(request);
  let submittedCart: Awaited<ReturnType<typeof getCheckoutCart>> = null;
  let submittedAttempt: PurchaseAttempt | null = null;
  let attemptStarted = false;
  try {
    const cart = await getCheckoutCart(redis, session.id, body.cartId);
    if (!cart || cart.expiresAt < Date.now()) return error("This checkout quote expired. Review your cart again.", 410);
    submittedCart = cart;
    const supplied = Buffer.from(body.confirmationToken);
    const expected = Buffer.from(cart.confirmationToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return error("This confirmation does not match the current cart.", 403);
    const settings = await getCheckoutSettings(redis, session.id);
    const attempt: PurchaseAttempt = {
      id: randomUUID(), cartId: cart.cartId, amountCents: cart.totalCents, itemCount: cart.lines.length,
      status: "processing", createdAt: Date.now(), updatedAt: Date.now(),
    };
    const midnightUtc = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const start = await beginPurchase(redis, cart, attempt, settings, midnightUtc);
    if (start === -1) return error("This cart is no longer available. Review your cart again.", 410);
    if (start === -2) {
      const attempts = await getPurchaseAttempts(redis, session.id);
      const previous = attempts.find((item) => item.cartId === cart.cartId);
      return withPersonalCookie(NextResponse.json({ attempt: previous, error: previous?.message ?? "This cart already has a payment attempt. It will not be charged again automatically." }, { status: 409 }), session.id, request);
    }
    if (start === -3 || start === -4) {
      const attempts = await getPurchaseAttempts(redis, session.id);
      const rejected = attempts.find((item) => item.cartId === cart.cartId);
      return withPersonalCookie(NextResponse.json({ attempt: rejected, error: rejected?.message ?? "The cart is over your spending limit." }, { status: 409 }), session.id, request);
    }

    submittedAttempt = attempt;
    attemptStarted = true;
    const result = await authorizeVisaCart(cart);
    const finalAttempt: PurchaseAttempt = { ...attempt, status: result.status, message: result.message, updatedAt: Date.now(), ...(result.status === "succeeded" && result.testPayment ? { testPayment: true } : {}) };
    await finishPurchase(redis, cart, finalAttempt);
    const [attempts, spentTodayCents] = await Promise.all([getPurchaseAttempts(redis, session.id), getCurrentDaySpend(redis, session.id)]);
    const response = NextResponse.json({ attempt: finalAttempt, attempts, spentTodayCents, paymentUnavailable: result.status === "unavailable", error: result.status === "succeeded" ? undefined : result.message }, { status: result.status === "succeeded" ? 200 : result.status === "unavailable" ? 503 : result.status === "failed" ? 402 : 502 });
    return withPersonalCookie(response, session.id, request);
  } catch {
    console.error(JSON.stringify({ event: "checkout_confirmation_failed", cartId: typeof body.cartId === "string" ? body.cartId : "unknown" }));
    if (attemptStarted && submittedCart && submittedAttempt) {
      const unknown: PurchaseAttempt = { ...submittedAttempt, status: "unknown", updatedAt: Date.now(), message: "We could not confirm the payment status. We will not retry automatically. Check with your payment provider before trying again." };
      await finishPurchase(redis, submittedCart, unknown).catch(() => undefined);
      return withPersonalCookie(NextResponse.json({ attempt: unknown, error: unknown.message }, { status: 502 }), session.id, request);
    }
    return withPersonalCookie(error("Checkout could not be completed. Your cart is still available to save for later.", 503), session.id, request);
  }
}
