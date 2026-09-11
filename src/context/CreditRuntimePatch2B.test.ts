/**
 * AETERNA — PATCH-2B regression test (node environment).
 *
 * Proves the context helper CreatorRuntimeContext.issueChallenge posts
 * { network, publicKey } to /api/creator/issue-challenge — and never
 * the legacy { network }-only body that triggered 400 INVALID_PUBLIC_KEY.
 *
 * Runs in the default node environment: the provider is mounted via
 * react-dom/server (no DOM needed) and the helper is invoked directly.
 * The CapsuleBuilder restore-flow integration lives in
 * CreditRuntimePatch2B.restore.test.tsx (jsdom, like the other PATCH-2
 * component tests).
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

const WALLET_ACCOUNT = "7XkWqBase58WalletAccountFor2BTest";

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

describe("PATCH-2B issue-challenge publicKey payload", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("context issueChallenge posts { network, publicKey } — never the legacy { network }-only body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        challengeId: "challenge-1",
        challenge: "abc",
        message: "AETERNA identity challenge",
      }),
    });

    const harness: { identity?: ReturnType<typeof useCreatorIdentity> } = {};
    renderIdentityProvider(harness);
    expect(harness.identity).toBeDefined();

    await harness.identity!.issueChallenge("solana", WALLET_ACCOUNT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/creator/issue-challenge");

    const body = JSON.parse(String(init.body));
    // Payload required by the production endpoint.
    expect(body).toEqual({ network: "solana", publicKey: WALLET_ACCOUNT });
    // Regression guard: the legacy body caused 400 INVALID_PUBLIC_KEY.
    expect(body).not.toEqual({ network: "solana" });
  });

  it("issueChallenge failure surfaces the server error reason", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ ok: false, error: "INVALID_PUBLIC_KEY" }),
    });

    const harness: { identity?: ReturnType<typeof useCreatorIdentity> } = {};
    renderIdentityProvider(harness);

    await expect(
      harness.identity!.issueChallenge("solana", WALLET_ACCOUNT)
    ).rejects.toThrow("INVALID_PUBLIC_KEY");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ network: "solana", publicKey: WALLET_ACCOUNT });
  });
});
