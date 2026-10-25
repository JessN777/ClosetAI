import type { CheckoutCart } from "@/lib/checkout-types";

export type VisaPaymentResult =
  | { status: "succeeded"; message: string; testPayment?: boolean }
  | { status: "failed"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "unknown"; message: string };
export type VisaPaymentMethod = { available: boolean; method: { brand: "Visa"; last4: string } | null };

function adapterUrl() {
  const raw = process.env.VISA_CHECKOUT_ADAPTER_URL;
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return "";
    return new URL("/v1/checkout/authorize", url).toString();
  } catch { return ""; }
}

/**
 * Fail closed unless a private server-side integration is configured. That
 * bridge must use the sponsor's Visa/acquirer integration and retailer order
 * APIs; this app sends only a profile ID to resolve the user's vault token.
 */
export function visaCheckoutReady() {
  return process.env.VISA_CHECKOUT_ENABLED === "1"
    && Boolean(adapterUrl())
    && Boolean(process.env.VISA_CHECKOUT_ADAPTER_SECRET);
}

export async function getVisaPaymentMethod(userId: string): Promise<VisaPaymentMethod> {
  if (!visaCheckoutReady()) return { available: false, method: null };
  try {
    const endpoint = new URL(`/v1/payment-methods/${encodeURIComponent(userId)}/default`, adapterUrl());
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${process.env.VISA_CHECKOUT_ADAPTER_SECRET}` }, signal: AbortSignal.timeout(5_000), cache: "no-store" });
    if (!response.ok) return { available: false, method: null };
    const payload = await response.json().catch(() => ({})) as { available?: unknown; brand?: unknown; last4?: unknown };
    if (payload.available !== true || payload.brand !== "Visa" || typeof payload.last4 !== "string" || !/^\d{4}$/.test(payload.last4)) return { available: false, method: null };
    return { available: true, method: { brand: "Visa", last4: payload.last4 } };
  } catch {
    console.error(JSON.stringify({ event: "visa_payment_method_unavailable" }));
    return { available: false, method: null };
  }
}

const safeReasons: Record<string, string> = {
  DECLINED: "The payment was declined. Your cart is still available in the wishlist.",
  INSUFFICIENT_FUNDS: "The payment method has insufficient funds. Your cart is still available in the wishlist.",
  EXPIRED_TOKEN: "The saved Visa payment method needs to be refreshed. Your cart is still available in the wishlist.",
  INVALID_PAYMENT_METHOD: "The saved Visa payment method could not be used. Your cart is still available in the wishlist.",
};

export async function authorizeVisaCart(cart: CheckoutCart): Promise<VisaPaymentResult> {
  if (process.env.DEMO_OFFLINE === "1") {
    return { status: "succeeded", message: "Test payment approved (offline mock).", testPayment: true };
  }
  const endpoint = adapterUrl();
  const secret = process.env.VISA_CHECKOUT_ADAPTER_SECRET;
  if (!visaCheckoutReady() || !endpoint || !secret) {
    return { status: "unavailable", message: "Visa checkout is unavailable. Save these items for later." };
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": cart.cartId,
      },
      body: JSON.stringify({
        cartId: cart.cartId,
        currency: cart.currency,
        amountCents: cart.totalCents,
        subtotalCents: cart.subtotalCents,
        taxEstimateCents: cart.taxCents,
        shippingEstimateCents: cart.shippingCents,
        userId: cart.userId,
        items: cart.lines.map(({ pieceName, product }) => ({
          pieceName,
          productName: product.name,
          retailer: product.retailer,
          priceCents: Math.round(product.numericPrice * 100),
          productUrl: product.href,
        })),
      }),
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({})) as { status?: unknown; reasonCode?: unknown };
    if (response.ok && payload.status === "succeeded") return { status: "succeeded", message: "Payment approved." };
    if (payload.status === "declined" || payload.status === "failed") {
      const reason = typeof payload.reasonCode === "string" ? safeReasons[payload.reasonCode] : undefined;
      return { status: "failed", message: reason ?? "The payment could not be completed. Your cart is still available in the wishlist." };
    }
    // An ambiguous provider response must never trigger a retry or a second charge.
    return { status: "unknown", message: "We could not confirm the payment status. We will not retry automatically. Check with your payment provider before trying again." };
  } catch {
    console.error(JSON.stringify({ event: "visa_checkout_provider_unreachable", cartId: cart.cartId }));
    return { status: "unknown", message: "We could not confirm the payment status. We will not retry automatically. Check with your payment provider before trying again." };
  }
}
