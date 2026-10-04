/**
 * =========================================================
 * AETERNA — Container uploader tests (Stage 3)
 * =========================================================
 *
 * Uses the REAL `ChunkingUploader` from the installed
 * `@irys/upload-core`, with the real `@irys/bundles/web` signer, and a
 * STUBBED HTTP transport. No network, no funds, no private keys.
 *
 * Proves Phase 6: one DataItem, one signature, `/chunks` paths only,
 * zero `/tx` POSTs, and a streamed byte count equal to the canonical
 * `containerSize`.
 */
import { describe, it, expect } from "vitest";
import { Readable } from "stream";

import { ChunkingUploader } from "@irys/upload-core";
import * as bundles from "@irys/bundles/web";

import type { ChunkMetadata } from "@/types/vault";
import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";

import { buildContainerLayout } from "./containerLayout";
import { createContainerWriter } from "./containerWriter";
import {
  uploadContainer,
  assertContainerChunkSize,
  assertContainerBatchSize,
  PROVISIONAL_CONTAINER_CHUNK_SIZE,
  PROVISIONAL_CONTAINER_BATCH_SIZE,
  CONTAINER_CHUNK_SIZE_MIN,
  CONTAINER_CHUNK_SIZE_MAX,
} from "./containerUploader";

/* ------------------------------------------------------------------ *
 * Harness — real uploader, stubbed transport
 * ------------------------------------------------------------------ */

interface StubTransport {
  readonly api: unknown;
  readonly getCalls: string[];
  readonly postCalls: { path: string; len: number }[];
  readonly signCalls: () => number;
  readonly uploadedBytes: () => number;
}

function makeStubTransport(): StubTransport {
  const getCalls: string[] = [];
  const postCalls: { path: string; len: number }[] = [];

  const api = {
    config: { timeout: 40_000 },
    async get(path: string) {
      getCalls.push(path);
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        // Mirrors the real /chunks/<token>/-1/-1 response shape.
        data: {
          id: "stub-upload-id",
          max: CONTAINER_CHUNK_SIZE_MAX,
          min: CONTAINER_CHUNK_SIZE_MIN,
          chunks: [],
        },
      };
    },
    async post(path: string, body: unknown) {
      const len =
        body && typeof (body as { length?: unknown }).length === "number"
          ? (body as { length: number }).length
          : 0;
      postCalls.push({ path: String(path), len });

      if (String(path).endsWith("/-1")) {
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          data: { id: "stub-container-txid" },
        };
      }
      return { status: 200, statusText: "OK", headers: {}, data: {} };
    },
  };

  return {
    api,
    getCalls,
    postCalls,
    signCalls: () => signState.calls,
    uploadedBytes: () => postCalls.reduce((a, c) => a + c.len, 0),
  };
}

/**
 * The signer's `signMessage` is exactly the call the wallet prompt would
 * make, so its count IS the number of creator signatures.
 */
const signState = { calls: 0 };

function makeUploader(transport: StubTransport): ChunkingUploader {
  const publicKey = { toBuffer: () => new Uint8Array(32).fill(9) };
  const signature = new Uint8Array(64).fill(7);

  const signer = new (bundles as unknown as {
    HexInjectedSolanaSigner: new (p: unknown) => unknown;
  }).HexInjectedSolanaSigner({
    publicKey,
    signMessage: async () => {
      signState.calls += 1;
      return signature;
    },
  });

  const tokenConfig = {
    name: "solana",
    irys: { bundles },
    getSigner: () => signer,
  };

  return new ChunkingUploader(tokenConfig as never, transport.api as never);
}

/* ------------------------------------------------------------------ *
 * Synthetic Runtime — one chunk materialised at a time
 * ------------------------------------------------------------------ */

function syntheticRuntime(
  chunkCount: number,
  chunkSize: number
): { runtime: RuntimeStorage; chunkIds: string[] } {
  const chunkIds = Array.from({ length: chunkCount }, (_, i) => `m0:${i}`);
  const runtime = {
    async read(chunkId: string) {
      const buf = new Uint8Array(chunkSize);
      buf.fill(chunkId.length & 0xff);
      return { chunkId, mediaId: "m0", chunkIndex: 0, ciphertext: buf };
    },
  } as unknown as RuntimeStorage;
  return { runtime, chunkIds };
}

function metadataFor(chunkCount: number, chunkSize: number): ChunkMetadata[] {
  return Array.from({ length: chunkCount }, (_, i) => ({
    chunkId: `m0:${i}`,
    mediaId: "m0",
    index: i,
    size: chunkSize,
  }));
}

const MiB = 1024 * 1024;
const CONTAINER_CHUNK = 10 * MiB;

async function runContainerUpload(totalBytes: number) {
  const chunkCount = Math.ceil(totalBytes / CONTAINER_CHUNK);
  const metadata = metadataFor(chunkCount, CONTAINER_CHUNK);
  const layout = buildContainerLayout([metadata]);

  const { runtime } = syntheticRuntime(chunkCount, CONTAINER_CHUNK);
  const writer = createContainerWriter(layout, runtime);

  const transport = makeStubTransport();
  const uploader = makeUploader(transport);

  signState.calls = 0;

  const result = await uploadContainer(uploader, writer.readable, {
    chunkSize: PROVISIONAL_CONTAINER_CHUNK_SIZE,
    batchSize: PROVISIONAL_CONTAINER_BATCH_SIZE,
  });

  return { layout, writer, transport, result, chunkCount };
}

/* ------------------------------------------------------------------ *
 * Phase 6 — one DataItem, one signature
 * ------------------------------------------------------------------ */

describe("container uploader — one DataItem / one signature", () => {
  for (const totalBytes of [60 * MiB, 100 * MiB, 500 * MiB]) {
    const label = `${totalBytes / MiB} MiB`;

    it(`${label}: sign() === 1, /tx POSTs === 0, /chunks used`, async () => {
      const { layout, writer, transport, result, chunkCount } =
        await runContainerUpload(totalBytes);

      // --- exactly ONE creator signature -------------------------
      expect(transport.signCalls()).toBe(1);

      // --- ONE DataItem: one upload session, one finalise --------
      const starts = transport.getCalls.filter((p) =>
        p.startsWith("/chunks/solana/-1/-1")
      );
      expect(starts.length).toBe(1);

      const finalises = transport.postCalls.filter((c) =>
        c.path.endsWith("/-1")
      );
      expect(finalises.length).toBe(1);

      // --- /chunks path used, /tx never --------------------------
      expect(transport.postCalls.length).toBeGreaterThan(0);
      for (const call of transport.postCalls) {
        expect(call.path.startsWith("/chunks/solana/")).toBe(true);
        expect(call.path.includes("/tx")).toBe(false);
      }
      for (const call of transport.getCalls) {
        expect(call.startsWith("/chunks/solana/")).toBe(true);
      }

      // --- the txId comes from the single finalise receipt -------
      expect(result.txId).toBe("stub-container-txid");

      // --- streamed byte count === canonical containerSize -------
      expect(writer.stats().emittedBytes).toBe(layout.containerSize);
      expect(layout.containerSize).toBe(64 + chunkCount * CONTAINER_CHUNK);
      expect(writer.stats().completed).toBe(true);
    }, 240_000);
  }

  it("adds only the constant DataItem header on top of the container", async () => {
    const small = await runContainerUpload(4 * CONTAINER_CHUNK);
    const large = await runContainerUpload(8 * CONTAINER_CHUNK);

    const smallOverhead =
      small.transport.uploadedBytes() - small.layout.containerSize;
    const largeOverhead =
      large.transport.uploadedBytes() - large.layout.containerSize;

    // The ONLY bytes beyond the container are the SDK's DataItem header.
    expect(smallOverhead).toBeGreaterThan(0);
    expect(smallOverhead).toBeLessThan(4096);
    // Same constant for a different container size => one-time header.
    expect(largeOverhead).toBe(smallOverhead);
  }, 240_000);

  it("streams the payload instead of sending one giant body", async () => {
    const { transport, layout } = await runContainerUpload(4 * CONTAINER_CHUNK);

    const chunkPosts = transport.postCalls.filter(
      (c) => !c.path.endsWith("/-1")
    );

    // More than one HTTP body => the SDK streamed it, no single huge POST.
    expect(chunkPosts.length).toBeGreaterThan(1);
    for (const call of chunkPosts) {
      expect(call.len).toBeLessThanOrEqual(PROVISIONAL_CONTAINER_CHUNK_SIZE);
    }
    // No single POST carries the whole container.
    for (const call of transport.postCalls) {
      expect(call.len).toBeLessThan(layout.containerSize);
    }
  }, 240_000);

  it("holds at most one Runtime chunk buffer during a real upload", async () => {
    const { writer } = await runContainerUpload(4 * CONTAINER_CHUNK);

    expect(writer.stats().peakLiveChunkBuffers).toBe(1);
    expect(writer.stats().peakLiveChunkBytes).toBe(CONTAINER_CHUNK);
  }, 240_000);
});

/* ------------------------------------------------------------------ *
 * Fail-closed
 * ------------------------------------------------------------------ */

describe("container uploader — fails closed", () => {
  it("rejects a missing uploader", async () => {
    await expect(
      uploadContainer(null as never, Readable.from([Buffer.from([1])]))
    ).rejects.toThrow("CONTAINER_UPLOAD_CONSTRUCT");
  });

  it("rejects a non-Readable input", async () => {
    const transport = makeStubTransport();
    await expect(
      uploadContainer(makeUploader(transport), { pipe: undefined } as never)
    ).rejects.toThrow("CONTAINER_UPLOAD_CONSTRUCT");
  });

  it("rejects an out-of-range chunk size", async () => {
    for (const bad of [
      CONTAINER_CHUNK_SIZE_MIN - 1,
      CONTAINER_CHUNK_SIZE_MAX + 1,
      0,
      -1,
      1.5,
      NaN,
    ]) {
      expect(() => assertContainerChunkSize(bad)).toThrow(
        "[AETERNA] Container chunk size out of the SDK-supported range"
      );
    }
  });

  it("accepts the measured SDK bounds", () => {
    expect(assertContainerChunkSize(CONTAINER_CHUNK_SIZE_MIN)).toBe(
      CONTAINER_CHUNK_SIZE_MIN
    );
    expect(assertContainerChunkSize(CONTAINER_CHUNK_SIZE_MAX)).toBe(
      CONTAINER_CHUNK_SIZE_MAX
    );
  });

  it("rejects an invalid batch size", () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(() => assertContainerBatchSize(bad)).toThrow(
        "[AETERNA] Invalid container batch size"
      );
    }
  });

  it("propagates a transport failure", async () => {
    const transport = makeStubTransport();
    (transport.api as { get: unknown }).get = async () => {
      throw new Error("transport down");
    };

    const metadata = metadataFor(1, CONTAINER_CHUNK);
    const layout = buildContainerLayout([metadata]);
    const { runtime } = syntheticRuntime(1, CONTAINER_CHUNK);

    await expect(
      uploadContainer(makeUploader(transport), createContainerWriter(layout, runtime).readable)
    ).rejects.toThrow("CONTAINER_UPLOAD_UNKNOWN");
  }, 120_000);

  it("fails closed when the receipt carries no id", async () => {
    const transport = makeStubTransport();
    (transport.api as { post: unknown }).post = async (
      path: string,
      body: unknown
    ) => {
      const len =
        body && typeof (body as { length?: unknown }).length === "number"
          ? (body as { length: number }).length
          : 0;
      transport.postCalls.push({ path: String(path), len });
      if (String(path).endsWith("/-1")) {
        return { status: 200, statusText: "OK", headers: {}, data: {} };
      }
      return { status: 200, statusText: "OK", headers: {}, data: {} };
    };

    const metadata = metadataFor(1, CONTAINER_CHUNK);
    const layout = buildContainerLayout([metadata]);
    const { runtime } = syntheticRuntime(1, CONTAINER_CHUNK);

    await expect(
      uploadContainer(makeUploader(transport), createContainerWriter(layout, runtime).readable)
    ).rejects.toThrow("CONTAINER_UPLOAD_RECEIPT");
  }, 120_000);

  it("fails closed on a non-200 upload response", async () => {
    const transport = makeStubTransport();
    (transport.api as { post: unknown }).post = async (
      path: string,
      body: unknown
    ) => {
      const len =
        body && typeof (body as { length?: unknown }).length === "number"
          ? (body as { length: number }).length
          : 0;
      transport.postCalls.push({ path: String(path), len });
      if (String(path).endsWith("/-1")) {
        return { status: 500, statusText: "ERR", headers: {}, data: { id: "x" } };
      }
      return { status: 200, statusText: "OK", headers: {}, data: {} };
    };

    const metadata = metadataFor(1, CONTAINER_CHUNK);
    const layout = buildContainerLayout([metadata]);
    const { runtime } = syntheticRuntime(1, CONTAINER_CHUNK);

    await expect(
      uploadContainer(makeUploader(transport), createContainerWriter(layout, runtime).readable)
    ).rejects.toThrow("CONTAINER_UPLOAD_HTTP");
  }, 120_000);
});
