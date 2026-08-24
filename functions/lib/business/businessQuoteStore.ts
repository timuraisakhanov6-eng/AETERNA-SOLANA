/**
 * AETERNA — Canonical Business Quote Store
 *
 * Business Quote is the only Business Authority.
 *
 * Responsibilities:
 *  - create immutable Business Quote
 *  - retrieve existing Business Quote
 *  - delete Business Quote after lifecycle completion
 *
 * This module never:
 *  - talks to Paddle
 *  - talks to Web3
 *  - performs payment verification
 *  - performs storage operations
 *  - performs upload authorization
 */

import type { BusinessQuote } from "../../../src/types/business";

/**
 * Minimal structural KV contract.
 *
 * Deliberately NOT the full `KVNamespace` type from
 * `@cloudflare/workers-types`. This project has two distinct
 * sources of that type in play (the global ambient declaration
 * used by verify.ts's env, and the explicit package import used
 * by webhook.ts's env) whose overload signatures are not
 * structurally assignable to one another.
 *
 * Since this store only ever calls get/put/delete, we depend on
 * exactly that surface — which both KVNamespace variants satisfy —
 * instead of the full type, so callers with either env shape can
 * pass their bindings in without a cast.
 */
export interface BusinessQuoteKVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface BusinessQuoteKV {
  BUSINESS_QUOTES: BusinessQuoteKVNamespace;
}

/**
 * Result of canonical Business Quote creation.
 *
 * Business Quote creation is idempotent.
 *
 * created === true
 *   → this request created the Quote.
 *
 * created === false
 *   → Quote already existed and was returned unchanged.
 */
export interface CreateBusinessQuoteResult {
  quote: BusinessQuote;
  created: boolean;
}

const QUOTE_PREFIX = "quote:";

/**
 * Canonical KV key.
 */
function quoteKey(
  paymentIntentId: string
): string {
  return `${QUOTE_PREFIX}${paymentIntentId}`;
}

/**
 * Load existing Business Quote.
 */
export async function getBusinessQuote(
  env: BusinessQuoteKV,
  paymentIntentId: string
): Promise<BusinessQuote | null> {

  const raw =
    await env.BUSINESS_QUOTES.get(
      quoteKey(paymentIntentId)
    );

  if (!raw) {
    return null;
  }

  return JSON.parse(raw) as BusinessQuote;

}

/**
 * Create immutable Business Quote.
 *
 * Idempotent:
 * if Quote already exists,
 * existing Quote is returned unchanged.
 */
export async function createBusinessQuote(
  env: BusinessQuoteKV,
  quote: BusinessQuote
): Promise<CreateBusinessQuoteResult> {

  const existing =
    await getBusinessQuote(
      env,
      quote.paymentIntentId
    );

  if (existing) {

    return {
      quote: existing,
      created: false,
    };

  }

  // Business Authority established.
  //
  // Once written, the commercial terms of this
  // payment intent become immutable.
  //
  // Subsequent requests must reuse the existing
  // Business Quote rather than overwrite it.
  await env.BUSINESS_QUOTES.put(
    quoteKey(quote.paymentIntentId),
    JSON.stringify(quote),
    {
      expirationTtl: Math.max(
        60,
        Math.ceil(
          (quote.expiresAt - quote.createdAt) /
          1000
        )
      ),
    }
  );

  return {
    quote,
    created: true,
  };

}

/**
 * Remove Business Quote.
 *
 * Business Quote lifecycle ends after
 * successful payment lifecycle completion.
 */
export async function deleteBusinessQuote(
  env: BusinessQuoteKV,
  paymentIntentId: string
): Promise<void> {

  await env.BUSINESS_QUOTES.delete(
    quoteKey(paymentIntentId)
  );

}
