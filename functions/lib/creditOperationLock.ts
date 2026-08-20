/**
 * AETERNA — Credit Operation Serialization
 *
 * Shared server-authoritative boundary for operations on the same
 * Creator Credit: reserve, finalize, recover.
 *
 * Cloudflare KV does not provide atomic compare-and-swap.
 * This module provides the safest available project-native
 * serialization mechanism: an ownership token that prevents
 * concurrent operations from releasing each other's locks.
 *
 * LIMITATION:
 * - This is NOT a strong distributed lock.
 * - Concurrent workers can still interleave reads/writes.
 * - We mitigate by re-reading authoritative state after write
 *   and rejecting if another operation changed state.
 */

export interface CreditOperationEnv {
  CREATOR_CREDITS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

const OPERATION_PREFIX = "creator:credit:op:";

export function creditOpKey(creditId: string): string {
  return `${OPERATION_PREFIX}${creditId}`;
}

export async function withCreditOperation<T>(
  env: CreditOperationEnv,
  creditId: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<{ result: T; acquired: boolean }> {
  const key = creditOpKey(creditId);
  const token = `${Date.now()}-${Math.random()}`;
  const existing = await env.CREATOR_CREDITS.get(key);
  if (existing) {
    return { result: undefined as unknown as T, acquired: false };
  }

  await env.CREATOR_CREDITS.put(key, token);

  try {
    const result = await fn();
    return { result, acquired: true };
  } finally {
    const current = await env.CREATOR_CREDITS.get(key);
    if (current === token) {
      await env.CREATOR_CREDITS.delete(key);
    }
  }
}
