/**
 * AETERNA — Storage Payment Store (Business Authority)
 */

import type { StoragePayment } from "../../../src/types/storagePayment";

const PREFIX = "storage-payment:";

export function paymentKey(storagePaymentId: string): string {
  return `${PREFIX}${storagePaymentId}`;
}

export async function getStoragePayment(
  env: { STORAGE_PAYMENTS: { get(key: string): Promise<string | null> } },
  storagePaymentId: string
): Promise<StoragePayment | null> {
  const raw = await env.STORAGE_PAYMENTS.get(paymentKey(storagePaymentId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoragePayment;
  } catch {
    return null;
  }
}

export async function putStoragePayment(
  env: { STORAGE_PAYMENTS: { put(key: string, value: string): Promise<void> } },
  payment: StoragePayment
): Promise<void> {
  await env.STORAGE_PAYMENTS.put(paymentKey(payment.storagePaymentId), JSON.stringify(payment));
}
