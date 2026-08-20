/**
 * AETERNA — Creator Credit Store
 *
 * Server-side authority for Creator Credit.
 *
 * Terminology:
 *   AVAILABLE
 *   CONSUMING
 *   CONSUMED
 */

export interface CreatorCreditRecord {
  id: string;
  creatorIdentityId: string;
  status: "AVAILABLE" | "CONSUMING" | "CONSUMED";
  quoteId: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreatorCreditKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

const CREDIT_PREFIX = "creator:credit:";

function creditKey(id: string): string {
  return `${CREDIT_PREFIX}${id}`;
}

function creditIndexKey(creatorIdentityId: string, quoteId: string): string {
  return `${CREDIT_PREFIX}index:${creatorIdentityId}:${quoteId}`;
}

function lifecycleIndexKey(creatorIdentityId: string, lifecycleId: string): string {
  return `${CREDIT_PREFIX}lifecycle:${creatorIdentityId}:${lifecycleId}`;
}

export async function getCreatorCredit(
  env: { CREATOR_CREDITS: CreatorCreditKVNamespace },
  id: string
): Promise<CreatorCreditRecord | null> {
  const raw = await env.CREATOR_CREDITS.get(creditKey(id));
  if (!raw) return null;
  return JSON.parse(raw) as CreatorCreditRecord;
}

export async function getCreatorCreditByIndex(
  env: { CREATOR_CREDITS: CreatorCreditKVNamespace },
  creatorIdentityId: string,
  quoteId: string
): Promise<CreatorCreditRecord | null> {
  const raw = await env.CREATOR_CREDITS.get(creditIndexKey(creatorIdentityId, quoteId));
  if (!raw) return null;
  const id = raw;
  return getCreatorCredit(env, id);
}

export async function createCreatorCredit(
  env: { CREATOR_CREDITS: CreatorCreditKVNamespace },
  record: CreatorCreditRecord
): Promise<CreatorCreditRecord> {
  await env.CREATOR_CREDITS.put(creditKey(record.id), JSON.stringify(record));
  await env.CREATOR_CREDITS.put(creditIndexKey(record.creatorIdentityId, record.quoteId), record.id);
  return record;
}

export async function updateCreatorCredit(
  env: { CREATOR_CREDITS: CreatorCreditKVNamespace },
  record: CreatorCreditRecord
): Promise<CreatorCreditRecord> {
  record.updatedAt = Date.now();
  await env.CREATOR_CREDITS.put(creditKey(record.id), JSON.stringify(record));
  return record;
}

export function generateCreditId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(v => v.toString(16).padStart(2, "0")).join("");
}

export async function findCreatorCreditByIdentity(
  env: { CREATOR_CREDITS: CreatorCreditKVNamespace },
  creatorIdentityId: string,
  lifecycleId: string
): Promise<CreatorCreditRecord | null> {
  const raw = await env.CREATOR_CREDITS.get(lifecycleIndexKey(creatorIdentityId, lifecycleId));
  if (!raw) return null;
  return getCreatorCredit(env, raw);
}

export async function updateCreatorCreditStatus(
  env: { CREATOR_CREDITS: CreatorCreditKVNamespace },
  creditId: string,
  record: CreatorCreditRecord
): Promise<CreatorCreditRecord> {
  await env.CREATOR_CREDITS.put(creditKey(creditId), JSON.stringify(record));
  if (record.lifecycleId) {
    await env.CREATOR_CREDITS.put(lifecycleIndexKey(record.creatorIdentityId, record.lifecycleId), creditId);
  }
  return record;
}
