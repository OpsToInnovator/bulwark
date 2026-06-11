// ─── Stripe metered billing stub ──────────────────────────────────────────────
//
// Wires Stripe metered usage reporting per Bulwark API key.
// Full implementation requires:
//   1. A Stripe Price with billing_scheme=per_unit and aggregate_usage=sum
//   2. A Subscription Item per Bulwark customer linked to that Price
//   3. The customer's stripe_subscription_item_id stored in their key record
//
// This stub is called from usage.ts after each request and batches records
// to stay under Stripe's API rate limits. In production, use a Durable Object
// or a periodic Cron Trigger to flush accumulated usage to Stripe.
//
// ENV vars needed (add to wrangler.toml when ready):
//   STRIPE_API_KEY        = "sk_live_..."
//   STRIPE_WEBHOOK_SECRET = "whsec_..."

export interface StripeUsageReport {
  subscriptionItemId: string; // Stripe subscription_item id
  quantity: number;           // Units to report (e.g. API calls, or microdollars)
  timestamp: number;          // Unix epoch
  idempotencyKey: string;     // Prevents double-counting
}

export interface StripeReportResult {
  ok: true;
  usageRecordId: string;
}
export interface StripeReportError {
  ok: false;
  error: string;
}
export type StripeOutcome = StripeReportResult | StripeReportError;

/**
 * Report metered usage to Stripe for a single request.
 *
 * Quantity convention (choose one and document it):
 *   Option A: 1 unit per API request (simple, matches most plans)
 *   Option B: cost_microdollars = Math.ceil(costUsd * 1_000_000) (precise billing)
 *
 * Currently using Option A. Swap to Option B for usage-based pricing.
 *
 * NOTE: stub — returns immediately without calling Stripe until STRIPE_API_KEY is set.
 */
export async function reportUsageToStripe(
  subscriptionItemId: string,
  requestId: string,
  quantityUnits: number,
  _apiKey: string | undefined,
): Promise<StripeOutcome> {
  if (!_apiKey) {
    // Not yet configured — no-op
    return { ok: true, usageRecordId: "stub_not_configured" };
  }

  const idempotencyKey = `bulwark_${requestId}`;
  const timestamp = Math.floor(Date.now() / 1000);

  try {
    const response = await fetch(
      `https://api.stripe.com/v1/subscription_items/${subscriptionItemId}/usage_records`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${_apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": idempotencyKey,
        },
        body: new URLSearchParams({
          quantity: String(quantityUnits),
          timestamp: String(timestamp),
          action: "increment",
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      return { ok: false, error: `Stripe HTTP ${response.status}: ${body}` };
    }

    const json = await response.json() as { id: string };
    return { ok: true, usageRecordId: json.id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Validate a Stripe webhook signature.
 * Call this from a POST /v1/stripe/webhook endpoint (implement in Week 2).
 */
export async function validateStripeWebhook(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  // Stripe signs with HMAC-SHA256 of `${timestamp}.${payload}`
  const parts = signature.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Part = parts.find((p) => p.startsWith("v1="));
  if (!tPart || !v1Part) return false;

  const timestamp = tPart.slice(2);
  const expectedSig = v1Part.slice(3);
  const signedPayload = `${timestamp}.${payload}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signedPayload));
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return computed === expectedSig;
}
