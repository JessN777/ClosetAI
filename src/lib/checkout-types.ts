import type { ShopProduct } from "@/lib/shop-types";

export type CheckoutSettings = {
  perPurchaseLimitCents: number;
  perDayLimitCents: number;
  version: number;
  updatedAt: number | null;
};

export type CheckoutLine = { pieceName: string; product: ShopProduct };
export type CheckoutCart = {
  cartId: string;
  confirmationToken: string;
  userId: string;
  lines: CheckoutLine[];
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  taxRate: number;
  shippingRetailerCount: number;
  shippingPerRetailerCents: number;
  currency: "USD";
  createdAt: number;
  expiresAt: number;
  status: "quoted" | "processing" | "succeeded" | "failed" | "unavailable" | "unknown";
};

export type PurchaseAttemptStatus = "processing" | "succeeded" | "failed" | "rejected" | "unavailable" | "unknown";
export type PurchaseAttempt = {
  id: string;
  cartId: string;
  amountCents: number;
  itemCount: number;
  status: PurchaseAttemptStatus;
  createdAt: number;
  updatedAt: number;
  message?: string;
  testPayment?: boolean;
};

export const DEFAULT_CHECKOUT_SETTINGS: CheckoutSettings = {
  perPurchaseLimitCents: 10_000,
  perDayLimitCents: 20_000,
  version: 0,
  updatedAt: null,
};

export function getSpentToday(attempts: PurchaseAttempt[], now = Date.now()) {
  const midnightUtc = Math.floor(now / 86_400_000) * 86_400_000;
  return attempts.reduce((total, attempt) => {
    if (attempt.createdAt >= midnightUtc && ["succeeded", "processing", "unknown"].includes(attempt.status)) return total + attempt.amountCents;
    return total;
  }, 0);
}

export function formatUsd(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
