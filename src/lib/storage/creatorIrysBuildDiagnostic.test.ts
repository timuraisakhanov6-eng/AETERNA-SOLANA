// @vitest-environment node

/**
 * AETERNA — Irys uploader BUILD boundary diagnostics.
 *
 * The production E2E classified the container failure as
 * `CONTAINER_UPLOAD_UNKNOWN` while the wallet had never been asked to
 * sign, which means the failure sat on the build boundary — the one place
 * the earlier patch left untagged.
 *
 * These tests pin the new classification, and pin that NOTHING from the
 * original failure travels with it.
 *
 * Node environment on purpose: it has no `location`, which is exactly the
 * condition under which the same-origin Solana RPC transport cannot be
 * derived and the boundary must classify it as BUILD_RPC_TRANSPORT.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  BUILD_CATEGORY_PROPERTY,
  jsonRpcErrorCode,
  readSealDiagnostic,
  RPC_CODE_PROPERTY,
  SEAL_FAILURE_MESSAGE,
  tagContainerBuildFailure,
} from "@/lib/capsule/sealDiagnostic";

/* ── The SDK builder chain is stubbed: no network, no keys ── */

const hoisted = vi.hoisted(() => ({ buildImpl: vi.fn() }));

vi.mock("@irys/web-upload", () => ({
  WebUploader: () => {
    const chain: Record<string, unknown> = {};
    for (const method of ["withProvider", "withRpc", "bundlerUrl", "timeout"]) {
      chain[method] = () => chain;
    }
    chain["build"] = () => hoisted.buildImpl();
    return chain;
  },
}));

vi.mock("@irys/web-upload-solana", () => ({
  WebUSDCSolana: class WebUSDCSolana {},
}));

import { buildCreatorChunkingUploader } from "@/lib/storage/creatorIrys";

const WALLET = {
  publicKey: { toBuffer: () => new Uint8Array(32) },
  signMessage: async () => new Uint8Array(64),
  sendTransaction: async () => ({ signature: "sig" }),
} as never;

const RPC_URL = "https://example.invalid/api/solana/rpc";

function workingUploader() {
  return {
    setChunkSize() {},
    setBatchSize() {},
    uploadData: async () => ({ status: 200, data: { id: "tx" } }),
  };
}

async function buildStage(
  wallet: unknown = WALLET,
  rpcUrl: string | undefined = RPC_URL
): Promise<{ code: string | null; error: unknown }> {
  try {
    await buildCreatorChunkingUploader(wallet as never, rpcUrl);
    return { code: null, error: null };
  } catch (error) {
    return { code: readSealDiagnostic(error), error };
  }
}

/**
 * Same, but with NO rpcUrl at all. A separate function because a default
 * parameter would swallow an explicit `undefined`.
 */
async function buildStageWithoutRpc(): Promise<{
  code: string | null;
  error: unknown;
}> {
  try {
    await buildCreatorChunkingUploader(WALLET as never, undefined);
    return { code: null, error: null };
  } catch (error) {
    return { code: readSealDiagnostic(error), error };
  }
}

describe("Irys uploader build boundary — stage classification", () => {
  beforeEach(() => {
    hoisted.buildImpl.mockReset();
  });

  it("A. a raw SDK failure → CONTAINER_UPLOADER_BUILD", async () => {
    hoisted.buildImpl.mockRejectedValue(new Error("builder exploded"));

    const { code, error } = await buildStage();

    expect(code).toBe("CONTAINER_UPLOADER_BUILD");
    expect((error as Error).message).toBe(
      `${SEAL_FAILURE_MESSAGE}: CONTAINER_UPLOADER_BUILD`
    );
  });

  it("A. an uploader without the streaming surface → CONTAINER_UPLOADER_BUILD (BUILD_CONFIG)", async () => {
    hoisted.buildImpl.mockResolvedValue({ setChunkSize() {} });

    const { code, error } = await buildStage();

    expect(code).toBe("CONTAINER_UPLOADER_BUILD");
    expect(
      (error as Record<string, unknown>)[BUILD_CATEGORY_PROPERTY]
    ).toBe("BUILD_CONFIG");
  });

  it("A. builder.build() returning nothing → CONTAINER_UPLOADER_BUILD (BUILD_SDK)", async () => {
    hoisted.buildImpl.mockResolvedValue(null);

    const { code, error } = await buildStage();

    expect(code).toBe("CONTAINER_UPLOADER_BUILD");
    expect(
      (error as Record<string, unknown>)[BUILD_CATEGORY_PROPERTY]
    ).toBe("BUILD_SDK");
  });

  it("A. a Solana JSON-RPC failure (-32601) → CONTAINER_UPLOADER_RPC + numeric code", async () => {
    hoisted.buildImpl.mockRejectedValue(
      Object.assign(new Error("METHOD_NOT_ALLOWED"), {
        name: "SolanaJSONRPCError",
        code: -32601,
      })
    );

    const { code, error } = await buildStage();

    expect(code).toBe("CONTAINER_UPLOADER_RPC");
    expect((error as Record<string, unknown>)[RPC_CODE_PROPERTY]).toBe(-32601);
    expect(
      (error as Record<string, unknown>)[BUILD_CATEGORY_PROPERTY]
    ).toBe("BUILD_RPC_ERROR");
    // The RPC text must not travel.
    expect((error as Error).message).not.toContain("METHOD_NOT_ALLOWED");
  });

  it("A. a Solana JSON-RPC failure (-32603) → CONTAINER_UPLOADER_RPC", async () => {
    hoisted.buildImpl.mockRejectedValue(
      Object.assign(new Error("upstream"), {
        name: "SolanaJSONRPCError",
        code: -32603,
      })
    );

    const { code, error } = await buildStage();

    expect(code).toBe("CONTAINER_UPLOADER_RPC");
    expect((error as Record<string, unknown>)[RPC_CODE_PROPERTY]).toBe(-32603);
  });

  it("A. a nested data.error.code is recognised", async () => {
    hoisted.buildImpl.mockRejectedValue(
      Object.assign(new Error("wrapped"), { data: { error: { code: -32000 } } })
    );

    const { code, error } = await buildStage();

    expect(code).toBe("CONTAINER_UPLOADER_RPC");
    expect((error as Record<string, unknown>)[RPC_CODE_PROPERTY]).toBe(-32000);
  });

  it("A. a missing same-origin RPC transport → BUILD_RPC_TRANSPORT", async () => {
    // No rpcUrl, and no browser origin (this file runs in the node
    // environment, so `location` is genuinely undefined).
    const { code, error } = await buildStageWithoutRpc();

    expect(code).toBe("CONTAINER_UPLOADER_BUILD");
    expect(
      (error as Record<string, unknown>)[BUILD_CATEGORY_PROPERTY]
    ).toBe("BUILD_RPC_TRANSPORT");
    // The reason keeps its meaning; only the fixed message + code surface.
    expect((error as Error).message).toBe(
      `${SEAL_FAILURE_MESSAGE}: CONTAINER_UPLOADER_BUILD`
    );
  });

  it("B. a successful build creates NO build failure", async () => {
    hoisted.buildImpl.mockResolvedValue(workingUploader());

    const { code } = await buildStage();

    expect(code).toBeNull();
  });
});

describe("Irys uploader build boundary — nothing sensitive travels", () => {
  beforeEach(() => {
    hoisted.buildImpl.mockReset();
  });

  it("drops the original message, token and payload", async () => {
    hoisted.buildImpl.mockRejectedValue(
      Object.assign(new Error("uploadToken=SUPER_SECRET_TOKEN_VALUE"), {
        name: "SolanaJSONRPCError",
        code: -32601,
        requestBody: { plaintext: "SUPER_SECRET_TOKEN_VALUE" },
      })
    );

    const { error } = await buildStage();

    const tagged = error as Error;
    expect(tagged.message).not.toContain("SUPER_SECRET_TOKEN_VALUE");
    expect(tagged.message).not.toContain("uploadToken");
    expect(tagged.message).not.toContain("plaintext");

    const serialized = JSON.stringify({ ...tagged });
    expect(serialized).not.toContain("SUPER_SECRET_TOKEN_VALUE");
    expect(serialized).not.toContain("plaintext");
    // Only the safe diagnostics survive.
    expect(serialized).toContain("CONTAINER_UPLOADER_RPC");
    expect(serialized).toContain("-32601");
  });

  it("never attaches `cause`", async () => {
    hoisted.buildImpl.mockRejectedValue(new Error("boom"));

    const { error } = await buildStage();

    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it("fail-closed is unchanged: the build failure still rejects", async () => {
    hoisted.buildImpl.mockRejectedValue(new Error("boom"));

    await expect(
      buildCreatorChunkingUploader(WALLET as never, RPC_URL)
    ).rejects.toThrow(`${SEAL_FAILURE_MESSAGE}: CONTAINER_UPLOADER_BUILD`);
  });
});

describe("jsonRpcErrorCode — shape only, no text", () => {
  it("reads a negative numeric code", () => {
    expect(jsonRpcErrorCode({ code: -32601 })).toBe(-32601);
  });

  it("reads SolanaJSONRPCError even with a non-negative code", () => {
    expect(jsonRpcErrorCode({ name: "SolanaJSONRPCError", code: 42 })).toBe(42);
  });

  it("ignores an unrelated POSITIVE numeric code", () => {
    expect(jsonRpcErrorCode({ code: 500 })).toBeNull();
    expect(jsonRpcErrorCode(Object.assign(new Error("x"), { code: 7 }))).toBeNull();
  });

  it("reads data.error.code", () => {
    expect(jsonRpcErrorCode({ data: { error: { code: -32000 } } })).toBe(-32000);
  });

  it("returns null for non-objects and non-numeric codes", () => {
    expect(jsonRpcErrorCode(null)).toBeNull();
    expect(jsonRpcErrorCode("boom")).toBeNull();
    expect(jsonRpcErrorCode(new Error("x"))).toBeNull();
    expect(jsonRpcErrorCode({ code: "ENOENT" })).toBeNull();
    expect(jsonRpcErrorCode({ code: 1.5 })).toBeNull();
  });
});

describe("tagContainerBuildFailure — tag preservation", () => {
  it("keeps a more precise inner tag", () => {
    const inner = tagContainerBuildFailure(new Error("rpc"), "BUILD_SDK");
    const outer = tagContainerBuildFailure(inner, "BUILD_UNKNOWN");
    expect(readSealDiagnostic(outer)).toBe("CONTAINER_UPLOADER_BUILD");
    expect(outer).toBe(inner);
  });
});
