/**
 * AETERNA — Container V1 upload: diagnostic sub-stage classification.
 *
 * The 2026-10-04 production E2E died inside the container upload with the
 * original exception destroyed, so the failing sub-stage could not be
 * named. These tests pin the A–F classification that makes it nameable —
 * with NO behaviour change: fail-closed, ordering and the "no claim on a
 * failed upload" contract are untouched.
 */

import { describe, it, expect } from "vitest";
import { Readable } from "stream";
import type { ChunkingUploader } from "@irys/upload-core";

import { uploadContainer } from "./containerUploader";
import {
  markWalletSignCompleted,
  readSealDiagnostic,
  SEAL_FAILURE_MESSAGE,
  tagSealFailure,
  walletSignCompletedCount,
  WALLET_SIGN_FAILURE,
} from "@/lib/capsule/sealDiagnostic";
import { toCreatorIrysWallet } from "@/lib/storage/creatorIrys";

/** A valid 32-byte base58 Solana account (the E2E wallet). */
const WALLET_ACCOUNT = "V37Sg8C8M585WLZG1CCgc22PxRRdvy3vEbAKWKEu3KN";

function readable(): Readable {
  return Readable.from([Buffer.from([1, 2, 3])]);
}

function fakeUploader(
  uploadData: (input: Readable) => Promise<unknown>
): ChunkingUploader {
  return {
    setChunkSize() {},
    setBatchSize() {},
    uploadData,
  } as unknown as ChunkingUploader;
}

async function stageOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return readSealDiagnostic(error);
  }
}

describe("container upload — diagnostic sub-stages A–E", () => {
  it("A. before any wallet interaction → CONTAINER_UPLOAD_CONSTRUCT", async () => {
    expect(await stageOf(uploadContainer(null as never, readable()))).toBe(
      "CONTAINER_UPLOAD_CONSTRUCT"
    );

    expect(
      await stageOf(
        uploadContainer(
          fakeUploader(async () => ({ status: 200, data: { id: "x" } })),
          { pipe: undefined } as never
        )
      )
    ).toBe("CONTAINER_UPLOAD_CONSTRUCT");
  });

  it("B. a rejected wallet signature → CONTAINER_UPLOAD_SIGN", async () => {
    const uploader = fakeUploader(async () => {
      // Exactly what the wallet adapter attaches when the injected
      // provider rejects the signing request.
      throw tagSealFailure(
        new Error("Attempting to use a disconnected port object"),
        WALLET_SIGN_FAILURE
      );
    });

    const stage = await stageOf(uploadContainer(uploader, readable()));
    expect(stage).toBe("CONTAINER_UPLOAD_SIGN");
  });

  it("C. a signature was produced, then the SDK failed → CONTAINER_UPLOAD_SIGNED", async () => {
    const uploader = fakeUploader(async () => {
      // The wallet adapter advances the probe on a completed signature.
      markWalletSignCompleted();
      throw new Error("stream aborted after signing");
    });

    const stage = await stageOf(uploadContainer(uploader, readable()));
    expect(stage).toBe("CONTAINER_UPLOAD_SIGNED");
  });

  it("D. an SDK failure carrying an HTTP status → CONTAINER_UPLOAD_HTTP", async () => {
    const uploader = fakeUploader(async () => {
      throw Object.assign(new Error("upload rejected"), { status: 503 });
    });

    expect(await stageOf(uploadContainer(uploader, readable()))).toBe(
      "CONTAINER_UPLOAD_HTTP"
    );
  });

  it("D. a resolved non-200 receipt → CONTAINER_UPLOAD_HTTP", async () => {
    const uploader = fakeUploader(async () => ({ status: 500, data: {} }));

    expect(await stageOf(uploadContainer(uploader, readable()))).toBe(
      "CONTAINER_UPLOAD_HTTP"
    );
  });

  it("E. a receipt without a data item id → CONTAINER_UPLOAD_RECEIPT", async () => {
    for (const data of [{}, { id: "" }, { id: 42 }]) {
      const uploader = fakeUploader(async () => ({ status: 200, data }));
      expect(await stageOf(uploadContainer(uploader, readable()))).toBe(
        "CONTAINER_UPLOAD_RECEIPT"
      );
    }
  });

  it("no signature and no HTTP signal → CONTAINER_UPLOAD_UNKNOWN", async () => {
    const uploader = fakeUploader(async () => {
      throw new Error("unclassified failure");
    });

    expect(await stageOf(uploadContainer(uploader, readable()))).toBe(
      "CONTAINER_UPLOAD_UNKNOWN"
    );
  });

  it("a successful upload is unchanged: the txId is returned", async () => {
    const uploader = fakeUploader(async () => ({
      status: 200,
      data: { id: "container-tx-id" },
    }));

    const result = await uploadContainer(uploader, readable());
    expect(result.txId).toBe("container-tx-id");
  });

  it("never leaks the SDK's own message into the diagnostic", async () => {
    const uploader = fakeUploader(async () => {
      throw Object.assign(
        new Error("uploadToken=SUPER_SECRET_TOKEN_VALUE"),
        { status: 500 }
      );
    });

    let captured: unknown = null;
    try {
      await uploadContainer(uploader, readable());
    } catch (error) {
      captured = error;
    }

    const error = captured as Error;
    expect(error.message).toBe(
      `${SEAL_FAILURE_MESSAGE}: CONTAINER_UPLOAD_HTTP`
    );
    expect(error.message).not.toContain("SUPER_SECRET_TOKEN_VALUE");
  });
});

describe("container upload — wallet adapter tagging", () => {
  it("a rejected signature is tagged with the neutral, context-free code", async () => {
    const wallet = toCreatorIrysWallet({
      account: WALLET_ACCOUNT,
      signMessage: async () => {
        throw new Error("Attempting to use a disconnected port object");
      },
      signAndSendTransaction: async () => ({ signature: "sig" }),
    });

    let captured: unknown = null;
    try {
      await wallet.signMessage(new Uint8Array([1, 2, 3]));
    } catch (error) {
      captured = error;
    }

    expect(readSealDiagnostic(captured)).toBe(WALLET_SIGN_FAILURE);
    expect((captured as Error).message).not.toContain(
      "disconnected port object"
    );
  });

  it("a rejected funding transaction is tagged the same way", async () => {
    const wallet = toCreatorIrysWallet({
      account: WALLET_ACCOUNT,
      signMessage: async () => ({ signature: new Uint8Array(64) }),
      signAndSendTransaction: async () => {
        throw new Error("rejected by wallet");
      },
    });

    let captured: unknown = null;
    try {
      await wallet.sendTransaction!({} as never, undefined as never);
    } catch (error) {
      captured = error;
    }

    expect(readSealDiagnostic(captured)).toBe(WALLET_SIGN_FAILURE);
  });

  it("a completed signature advances the sign probe", async () => {
    const before = walletSignCompletedCount();

    const wallet = toCreatorIrysWallet({
      account: WALLET_ACCOUNT,
      signMessage: async () => ({ signature: new Uint8Array(64) }),
      signAndSendTransaction: async () => ({ signature: "sig" }),
    });

    const signature = await wallet.signMessage(new Uint8Array([1]));
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(walletSignCompletedCount()).toBe(before + 1);
  });

  it("keeps the fail-closed guard for an incomplete wallet", () => {
    expect(() =>
      toCreatorIrysWallet({
        account: null,
        signMessage: async () => ({ signature: new Uint8Array(64) }),
        signAndSendTransaction: async () => ({ signature: "sig" }),
      })
    ).toThrow("[AETERNA] creatorIrys: wallet account is required");
  });
});
