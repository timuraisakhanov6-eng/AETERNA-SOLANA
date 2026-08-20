/**
 * AETERNA — Creator Identity Store
 *
 * Server-side authority for Creator Identity.
 * Creator Identity is NOT a raw address.
 * It is a server-issued identity bound to a verified network/account.
 */

export interface CreatorIdentityRecord {
  id: string;
  network: string;
  account: string;
  firstVerifiedAt: number;
  lastVerifiedAt: number;
}

export interface CreatorIdentityKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

const IDENTITY_PREFIX = "creator:identity:";

function identityKey(network: string, account: string): string {
  return `${IDENTITY_PREFIX}${network}:${account.toLowerCase()}`;
}

export async function getCreatorIdentity(
  env: { CREATOR_IDENTITIES: CreatorIdentityKVNamespace },
  network: string,
  account: string
): Promise<CreatorIdentityRecord | null> {
  const raw = await env.CREATOR_IDENTITIES.get(identityKey(network, account));
  if (!raw) return null;
  return JSON.parse(raw) as CreatorIdentityRecord;
}

export async function createCreatorIdentity(
  env: { CREATOR_IDENTITIES: CreatorIdentityKVNamespace },
  record: CreatorIdentityRecord
): Promise<CreatorIdentityRecord> {
  await env.CREATOR_IDENTITIES.put(
    identityKey(record.network, record.account),
    JSON.stringify(record)
  );
  return record;
}

export async function getCreatorIdentityById(
  env: { CREATOR_IDENTITIES: CreatorIdentityKVNamespace },
  id: string
): Promise<CreatorIdentityRecord | null> {
  // idempotency lookup by id requires scanning or secondary index.
  // For minimal implementation, we store a secondary index:
  // idIndex:{id} -> network:account
  const indexKey = `creator:identity:id:${id}`;
  const raw = await env.CREATOR_IDENTITIES.get(indexKey);
  if (!raw) return null;
  const [network, account] = raw.split(":");
  return getCreatorIdentity(env, network, account);
}

export async function putCreatorIdentityIndex(
  env: { CREATOR_IDENTITIES: CreatorIdentityKVNamespace },
  record: CreatorIdentityRecord
): Promise<void> {
  await env.CREATOR_IDENTITIES.put(
    `creator:identity:id:${record.id}`,
    `${record.network}:${record.account}`
  );
}
