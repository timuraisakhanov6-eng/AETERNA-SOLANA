/**
 * AETERNA — Storage Quote Store (Business Authority)
 *
 * Persistent immutable storage quote records.
 *
 * Quote key:
 *   STORAGE_QUOTE:{creatorIdentityId}:{lifecycleId}:{capsuleId}
 *
 * Payment->quote index:
 *   STORAGE_PAYMENT_QUOTE:{storagePaymentId} -> quote JSON
 */

import type { StorageQuote } from "../../../src/types/storageQuote";

const QUOTE_PREFIX = "storage-quote:";
const PAYMENT_INDEX_PREFIX = "storage-payment-quote:";

export function quoteKey(
  creatorIdentityId: string,
  lifecycleId: string,
  capsuleId: string
): string {
  return `${QUOTE_PREFIX}${creatorIdentityId}:${lifecycleId}:${capsuleId}`;
}

export function paymentIndexKey(storagePaymentId: string): string {
  return `${PAYMENT_INDEX_PREFIX}${storagePaymentId}`;
}

export async function getStorageQuote(
  env: {
    STORAGE_QUOTES: {
      get(key: string): Promise<string | null>;
    };
  },
  creatorIdentityId: string,
  lifecycleId: string,
  capsuleId: string
): Promise<StorageQuote | null> {
  const raw = await env.STORAGE_QUOTES.get(quoteKey(creatorIdentityId, lifecycleId, capsuleId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StorageQuote;
  } catch {
    return null;
  }
}

export async function getStorageQuoteByPaymentId(
  env: {
    STORAGE_QUOTES: {
      get(key: string): Promise<string | null>;
    };
  },
  storagePaymentId: string
): Promise<StorageQuote | null> {
  const raw = await env.STORAGE_QUOTES.get(paymentIndexKey(storagePaymentId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StorageQuote;
  } catch {
    return null;
  }
}

export async function putStorageQuote(
  env: {
    STORAGE_QUOTES: {
      put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    };
  },
  quote: StorageQuote
): Promise<void> {
  const mainKey = quoteKey(quote.creatorIdentityId, quote.lifecycleId, quote.capsuleId);
  const indexKey = paymentIndexKey(quote.storagePaymentId);
  const value = JSON.stringify(quote);
  await env.STORAGE_QUOTES.put(mainKey, value);
  await env.STORAGE_QUOTES.put(indexKey, value);
}
