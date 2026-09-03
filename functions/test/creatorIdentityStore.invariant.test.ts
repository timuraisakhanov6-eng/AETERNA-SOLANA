import { describe, expect, it } from "vitest";
import {
  createCreatorIdentity,
  getCreatorIdentity,
  getCreatorIdentityById,
  putCreatorIdentityIndex,
} from "../../src/lib/creator/creatorIdentityStore";
import { createFakeKV } from "./harness";

describe("creatorIdentityStore canonical normalization", () => {
  it("preserves Solana account case on create/read", async () => {
    const env = { CREATOR_IDENTITIES: createFakeKV() };
    const mixedBase58 = "123456789ABCDEFGHJKLMNP";

    await createCreatorIdentity(env, {
      id: "id-solana-1",
      network: "solana",
      account: mixedBase58,
      firstVerifiedAt: 1,
      lastVerifiedAt: 1,
    });

    const direct = await getCreatorIdentity(env, "solana", mixedBase58);
    expect(direct).toEqual({
      id: "id-solana-1",
      network: "solana",
      account: mixedBase58,
      firstVerifiedAt: 1,
      lastVerifiedAt: 1,
    });

    const stored = env.CREATOR_IDENTITIES.data.get(
      `creator:identity:solana:${mixedBase58}`
    );
    expect(stored).toBeDefined();
    expect(JSON.parse(stored as string).account).toBe(mixedBase58);
  });

  it("preserves lowercase behavior for EVM", async () => {
    const env = { CREATOR_IDENTITIES: createFakeKV() };
    const mixedEvm = "0xD5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f";
    const canonicalEvm = mixedEvm.toLowerCase();

    await createCreatorIdentity(env, {
      id: "id-evm-1",
      network: "eip155:8453",
      account: canonicalEvm,
      firstVerifiedAt: 1,
      lastVerifiedAt: 1,
    });

    const direct = await getCreatorIdentity(env, "eip155:8453", canonicalEvm);
    expect(direct).toEqual({
      id: "id-evm-1",
      network: "eip155:8453",
      account: canonicalEvm,
      firstVerifiedAt: 1,
      lastVerifiedAt: 1,
    });

    const stored = env.CREATOR_IDENTITIES.data.get(
      `creator:identity:eip155:8453:${canonicalEvm}`
    );
    expect(stored).toBeDefined();
  });

  it("resolves Solana identity by id with canonical account", async () => {
    const env = { CREATOR_IDENTITIES: createFakeKV() };
    const mixedBase58 = "123456789ABCDEFGHJKLMNP";

    await createCreatorIdentity(env, {
      id: "id-solana-2",
      network: "solana",
      account: mixedBase58,
      firstVerifiedAt: 1,
      lastVerifiedAt: 1,
    });
    await putCreatorIdentityIndex(env, {
      id: "id-solana-2",
      network: "solana",
      account: mixedBase58,
      firstVerifiedAt: 1,
      lastVerifiedAt: 1,
    });

    const byId = await getCreatorIdentityById(env, "id-solana-2");
    expect(byId).toEqual({
      id: "id-solana-2",
      network: "solana",
      account: mixedBase58,
      firstVerifiedAt: 1,
      lastVerifiedAt: 1,
    });
  });

  it("resolves EVM identity by id with lowercase account", async () => {
    const env = { CREATOR_IDENTITIES: createFakeKV() };
    const mixedEvm = "0xD5a9291fA9018b2168F9c5c785e4B7BbeCA51a7f";
    const canonicalEvm = mixedEvm.toLowerCase();

    await createCreatorIdentity(env, {
      id: "id-evm-2",
      network: "eip155:8453",
      account: canonicalEvm,
      firstVerifiedAt: 1,
      lastVerifiedAt: 1,
    });
    await putCreatorIdentityIndex(env, {
      id: "id-evm-2",
      network: "eip155:8453",
      account: canonicalEvm,
      firstVerifiedAt: 1,
      lastVerifiedAt: 1,
    });

    const byId = await getCreatorIdentityById(env, "id-evm-2");
    expect(byId).toEqual({
      id: "id-evm-2",
      network: "eip155:8453",
      account: canonicalEvm,
      firstVerifiedAt: 1,
      lastVerifiedAt: 1,
    });
  });
});
