/**
 * AETERNA — shared creator identity proof verification.
 *
 * Single implementation of the canonical challenge/signature flow used
 * by every creator-authenticated endpoint. The challenge record is
 * server-issued (issue-challenge), the signature is verified against
 * the claimed account, and the creator identity is resolved
 * SERVER-SIDE from (network, account) — a client-supplied
 * creatorIdentityId is never an input of this function and can never
 * influence its result.
 *
 * Error codes are the historical per-endpoint codes, so migrating an
 * endpoint onto this helper cannot change its observable contract.
 */

import { verifyMessage } from "ethers";
import { getCreatorIdentity } from "../../src/lib/creator/creatorIdentityStore";
import {
  base58Decode,
  buildSolanaMessage,
  verifySolanaSignature,
} from "./solanaIdentityProof";

export interface IdentityProofEnv {
  CREATOR_IDENTITIES: {
    get(key: string): Promise<string | null>;
  };
}

export interface IdentityProofInput {
  challengeId: string;
  network: string;
  account: string;
  signature: string;
}

export type IdentityProofResult =
  | { ok: true; creatorIdentityId: string; account: string; network: string }
  | { ok: false; status: number; error: string };

export async function verifyIdentityProof(
  env: IdentityProofEnv,
  input: IdentityProofInput,
  now: number
): Promise<IdentityProofResult> {
  const { challengeId, network, account, signature } = input;

  if (
    typeof challengeId !== "string" || !challengeId ||
    typeof network !== "string" || !network ||
    typeof account !== "string" || !account ||
    typeof signature !== "string" || !signature
  ) {
    return { ok: false, status: 400, error: "INVALID_FIELDS" };
  }

  const isSolanaRequest = network === "solana";
  if (isSolanaRequest) {
    let publicKeyBytes: Uint8Array;
    try {
      publicKeyBytes = base58Decode(account);
    } catch {
      return { ok: false, status: 400, error: "INVALID_ACCOUNT" };
    }
    if (publicKeyBytes.length !== 32) {
      return { ok: false, status: 400, error: "INVALID_ACCOUNT" };
    }
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(account)) {
    return { ok: false, status: 400, error: "INVALID_ACCOUNT" };
  }

  const challengeRaw = await env.CREATOR_IDENTITIES.get(`creator:challenge:${challengeId}`);
  if (!challengeRaw) {
    return { ok: false, status: 401, error: "CHALLENGE_NOT_FOUND" };
  }

  let challengeRecord: Record<string, unknown>;
  try {
    challengeRecord = JSON.parse(challengeRaw) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, error: "CHALLENGE_CORRUPT" };
  }

  if (challengeRecord.network !== network) {
    return { ok: false, status: 401, error: "NETWORK_MISMATCH" };
  }

  if (now > (challengeRecord.expiresAt as number)) {
    return { ok: false, status: 401, error: "CHALLENGE_EXPIRED" };
  }

  if (isSolanaRequest) {
    const message = buildSolanaMessage(
      challengeRecord as unknown as Parameters<typeof buildSolanaMessage>[0]
    );
    const valid = await verifySolanaSignature(account, signature, message);
    if (!valid) {
      return { ok: false, status: 401, error: "INVALID_SIGNATURE" };
    }
  } else {
    let recoveredAddress = "";
    try {
      const message = `AETERNA identity challenge:${challengeRecord.challenge}`;
      recoveredAddress = await verifyMessage(message, signature);
    } catch {
      return { ok: false, status: 401, error: "INVALID_SIGNATURE" };
    }
    if (recoveredAddress.toLowerCase() !== account.toLowerCase()) {
      return { ok: false, status: 401, error: "ACCOUNT_MISMATCH" };
    }
  }

  const identityRecord = await getCreatorIdentity(
    env as unknown as Parameters<typeof getCreatorIdentity>[0],
    network,
    account
  );
  if (!identityRecord) {
    return { ok: false, status: 403, error: "CREATOR_IDENTITY_NOT_FOUND" };
  }

  return {
    ok: true,
    creatorIdentityId: identityRecord.id,
    account,
    network,
  };
}
