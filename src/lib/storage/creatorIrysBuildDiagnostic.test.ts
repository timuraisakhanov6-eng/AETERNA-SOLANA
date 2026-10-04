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
import { ChunkingUploader, Irys, Uploader } from "@irys/upload-core";

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

/**
 * The streaming surface — lives on the SDK's `ChunkingUploader`, NOT on the
 * `Irys`/`BaseWebIrys` instance that `builder.build()` returns.
 */
function chunkingSurface() {
  return {
    setChunkSize() {
      return this;
    },
    setBatchSize() {
      return this;
    },
    uploadData: async () => ({ status: 200, data: { id: "tx" } }),
  };
}

/**
 * The shape `builder.build()` really returns: an Irys instance whose
 * `uploader.chunkedUploader` GETTER yields the streaming uploader.
 */
function irysWithChunking(surface: unknown = chunkingSurface()) {
  return { uploader: { chunkedUploader: surface } };
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

  it("A. an Irys instance with no chunking uploader → CONTAINER_UPLOADER_BUILD (BUILD_CONFIG)", async () => {
    hoisted.buildImpl.mockResolvedValue({ uploader: {} });

    const { code, error } = await buildStage();

    expect(code).toBe("CONTAINER_UPLOADER_BUILD");
    expect(
      (error as Record<string, unknown>)[BUILD_CATEGORY_PROPERTY]
    ).toBe("BUILD_CONFIG");
  });

  it("A. a chunking uploader without the streaming surface → BUILD_CONFIG", async () => {
    hoisted.buildImpl.mockResolvedValue(
      irysWithChunking({ setChunkSize() {} })
    );

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
    hoisted.buildImpl.mockResolvedValue(irysWithChunking());

    const { code } = await buildStage();

    expect(code).toBeNull();
  });

  it("B. the returned uploader exposes setChunkSize / setBatchSize / uploadData", async () => {
    hoisted.buildImpl.mockResolvedValue(irysWithChunking());

    const uploader = await buildCreatorChunkingUploader(WALLET as never, RPC_URL);

    expect(typeof uploader.setChunkSize).toBe("function");
    expect(typeof uploader.setBatchSize).toBe("function");
    expect(typeof uploader.uploadData).toBe("function");
  });

  it("B. the chunking uploader is read EXACTLY ONCE (getter constructs per access)", async () => {
    let reads = 0;
    const surface = chunkingSurface();

    hoisted.buildImpl.mockResolvedValue({
      uploader: {
        get chunkedUploader() {
          reads++;
          return surface;
        },
      },
    });

    const uploader = await buildCreatorChunkingUploader(WALLET as never, RPC_URL);

    expect(reads).toBe(1);
    expect(uploader).toBe(surface as never);
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

describe("REAL SDK contract — regression guard for the root cause", () => {
  it("the streaming surface is NOT on Irys / BaseWebIrys", () => {
    const proto = Irys.prototype as unknown as Record<string, unknown>;

    expect(typeof proto["setChunkSize"]).not.toBe("function");
    expect(typeof proto["setBatchSize"]).not.toBe("function");
    // The Irys instance only delegates `upload`, never `uploadData`.
    expect(typeof proto["uploadData"]).not.toBe("function");
  });

  it("`chunkedUploader` is a GETTER (no setter) on Uploader", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Uploader.prototype,
      "chunkedUploader"
    );

    expect(typeof descriptor?.get).toBe("function");
    expect(descriptor?.set).toBeUndefined();
  });

  it("`useChunking` is a SETTER on this version, NOT a method", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Uploader.prototype,
      "useChunking"
    );

    expect(typeof descriptor?.set).toBe("function");
    expect(descriptor?.get).toBeUndefined();
  });

  it("a real Uploader yields a ChunkingUploader carrying the streaming surface", () => {
    const tokenConfig = {
      name: "usdc-solana",
      irys: { bundles: {} },
      getSigner: () => ({}),
    };

    const uploader = new Uploader(
      {} as never,
      {} as never,
      "usdc-solana" as never,
      tokenConfig as never,
      undefined as never
    );

    const chunking = (uploader as unknown as { chunkedUploader: ChunkingUploader })
      .chunkedUploader;

    expect(chunking).toBeInstanceOf(ChunkingUploader);
    expect(typeof chunking.setChunkSize).toBe("function");
    expect(typeof chunking.setBatchSize).toBe("function");
    expect(typeof chunking.uploadData).toBe("function");
  });
});

describe("container path — one uploadData call, no extra signing", () => {
  beforeEach(() => {
    hoisted.buildImpl.mockReset();
  });

  it("F. the built uploader is driven with exactly ONE uploadData call", async () => {
    let uploadDataCalls = 0;
    const surface = {
      setChunkSize() {
        return this;
      },
      setBatchSize() {
        return this;
      },
      async uploadData() {
        uploadDataCalls++;
        return { status: 200, data: { id: "tx" } };
      },
    };

    hoisted.buildImpl.mockResolvedValue(irysWithChunking(surface));

    const uploader = await buildCreatorChunkingUploader(WALLET as never, RPC_URL);
    await uploader.uploadData({} as never);

    expect(uploadDataCalls).toBe(1);
  });

  it("G. building the chunking uploader never invokes the injected wallet", async () => {
    let signCalls = 0;
    let sendCalls = 0;

    const wallet = {
      publicKey: { toBuffer: () => new Uint8Array(32) },
      signMessage: async () => {
        signCalls++;
        return new Uint8Array(64);
      },
      sendTransaction: async () => {
        sendCalls++;
        return { signature: "sig" };
      },
    };

    hoisted.buildImpl.mockResolvedValue(irysWithChunking());

    await buildCreatorChunkingUploader(wallet as never, RPC_URL);

    expect(signCalls).toBe(0);
    expect(sendCalls).toBe(0);
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
