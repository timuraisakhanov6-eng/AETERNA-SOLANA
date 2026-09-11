/**
 * AETERNA — PATCH-2C regression tests (node environment).
 *
 * Proves CreatorRuntimeContext.issueChallenge normalizes the
 * issue-challenge response id:
 *   A. production shape  { ok, id, challenge, message, ... }  → challengeId = id
 *   B. legacy shape      { ok, challengeId, challenge, message } → challengeId unchanged
 * and that the existing error handling is unchanged:
 *   - the server error reason still surfaces (e.g. INVALID_PUBLIC_KEY)
 *   - the CHALLENGE_ISSUANCE_FAILED guard still fires when
 *     challenge/message are missing.
 *
 * Runs in the default node environment via react-dom/server (no DOM
 * needed); the repository Vitest config does not collect .test.tsx.
 *
 * All network access is mocked. No production calls.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CreatorIdentityProvider,
  useCreatorIdentity,
} from "@/context/CreatorRuntimeContext";

const WALLET_ACCOUNT = "7XkWqBase58WalletAccountFor2CTest";

function IdentityProbe({
  harness,
}: {
  harness: { identity?: ReturnType<typeof useCreatorIdentity> };
}) {
  harness.identity = useCreatorIdentity();
  return null;
}

function renderIdentityProvider(harness: {
  identity?: ReturnType<typeof useCreatorIdentity>;
}) {
  renderToStaticMarkup(
    React.createElement(
      CreatorIdentityProvider,
      null,
      React.createElement(IdentityProbe, { harness })
    )
  );
}

describe("PATCH-2C issue-challenge response id compatibility", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("A: production shape { id } → returns challengeId from id", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        id: "challenge-1",
        challenge: "abc123",
        message: "AETERNA identity challenge",
        network: "solana",
        publicKey: WALLET_ACCOUNT,
        expiresAt: 1798761600000,
      }),
    });

    const harness: { identity?: ReturnType<typeof useCreatorIdentity> } = {};
    renderIdentityProvider(harness);

    const result = await harness.identity!.issueChallenge(
      "solana",
      WALLET_ACCOUNT
    );

    expect(result.challengeId).toBe("challenge-1");
    expect(result.challenge).toBe("abc123");
    expect(result.message).toBe("AETERNA identity challenge");
  });

  it("B: legacy shape { challengeId } → returns challengeId unchanged", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        challengeId: "challenge-2",
        challenge: "abc123",
        message: "AETERNA identity challenge",
      }),
    });

    const harness: { identity?: ReturnType<typeof useCreatorIdentity> } = {};
    renderIdentityProvider(harness);

    const result = await harness.identity!.issueChallenge(
      "solana",
      WALLET_ACCOUNT
    );

    expect(result.challengeId).toBe("challenge-2");
    expect(result.challenge).toBe("abc123");
    expect(result.message).toBe("AETERNA identity challenge");
  });

  it("server error reason still surfaces unchanged", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ ok: false, error: "INVALID_PUBLIC_KEY" }),
    });

    const harness: { identity?: ReturnType<typeof useCreatorIdentity> } = {};
    renderIdentityProvider(harness);

    await expect(
      harness.identity!.issueChallenge("solana", WALLET_ACCOUNT)
    ).rejects.toThrow("INVALID_PUBLIC_KEY");
  });

  it("guard still rejects with CHALLENGE_ISSUANCE_FAILED when challenge/message missing", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, id: "challenge-3" }),
    });

    const harness: { identity?: ReturnType<typeof useCreatorIdentity> } = {};
    renderIdentityProvider(harness);

    await expect(
      harness.identity!.issueChallenge("solana", WALLET_ACCOUNT)
    ).rejects.toThrow("CHALLENGE_ISSUANCE_FAILED");
  });
});
