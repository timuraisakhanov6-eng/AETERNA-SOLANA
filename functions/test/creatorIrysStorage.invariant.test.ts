/**
 * Phase D2a — Creator-paid Irys StorageAdapter contract tests.
 *
 * Proves:
 *   - adapter upload/uploadChunk delegate to upload-only creatorIrys;
 *   - fund is NEVER called (no fund path exists in the adapter);
 *   - every upload is followed by a publication claim (vault/chunk);
 *   - context identifiers propagate into the claim body;
 *   - uploadToken is accepted by the interface but sent nowhere;
 *   - dataTxId becomes the returned txId (evidence → authority via
 *     server-side claim);
 *   - claim failures throw (no silent success);
 *   - download reuses the existing read-only gateway path.
 *
 * @irys modules are not needed here: uploadCreatorData is mocked at
 * the creatorIrys boundary; executorStorage.download is spied.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const uploadCreatorDataMock = vi.fn();
const executorDownloadMock = vi.fn();

vi.mock("./../../src/lib/storage/creatorIrys", () => ({
  uploadCreatorData: (...args: unknown[]) => uploadCreatorDataMock(...(args as [])),
}));

vi.mock("./../../src/lib/storage/executorStorage", () => ({
  executorStorage: {
    download: (...args: unknown[]) => executorDownloadMock(...(args as [])),
  },
}));

import {
  createCreatorIrysStorage,
  type CreatorIrysStorageContext,
} from "./../../src/lib/storage/creatorIrysStorage";

const WALLET = { publicKey: "pk", signMessage: vi.fn() } as never;
const ctx: CreatorIrysStorageContext = {
  wallet: WALLET,
  creatorIdentityId: "identity-1",
  lifecycleId: "lifecycle-1",
  capsuleId: "a".repeat(64),
  storagePaymentId: "storage-pay-1",
};

const DATA = new Uint8Array([1, 2, 3, 4]);
const DATA_TX = "D".repeat(43);

function stubClaim(status = 200, body: Record<string, unknown> = { ok: true, claimed: true }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/publication/claim") {
      return new Response(JSON.stringify(body), { status });
    }
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastClaimBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown[];
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
}

describe("Phase D2a — creatorIrysStorage adapter", () => {
  beforeEach(() => {
    uploadCreatorDataMock.mockReset();
    executorDownloadMock.mockReset();
    uploadCreatorDataMock.mockResolvedValue({ dataTxId: DATA_TX });
  });

  it("A. vault upload: uploadCreatorData once, fund never, claim kind=vault", async () => {
    const fetchMock = stubClaim();
    const adapter = createCreatorIrysStorage(ctx);

    const result = await adapter.upload(DATA, "token" as never);

    expect(result.txId).toBe(DATA_TX);
    expect(uploadCreatorDataMock).toHaveBeenCalledTimes(1);
    expect(uploadCreatorDataMock).toHaveBeenCalledWith(DATA, WALLET, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = lastClaimBody(fetchMock);
    expect(body.kind).toBe("vault");
    expect(body.txId).toBe(DATA_TX);
  });

  it("B. chunk upload: uploadCreatorData once, claim kind=chunk with correct chunkId", async () => {
    const fetchMock = stubClaim();
    const adapter = createCreatorIrysStorage(ctx);

    const chunkId = "c".repeat(64);
    const result = await adapter.uploadChunk(DATA, chunkId as never, "token" as never);

    expect(result.txId).toBe(DATA_TX);
    expect(uploadCreatorDataMock).toHaveBeenCalledTimes(1);
    const body = lastClaimBody(fetchMock);
    expect(body.kind).toBe("chunk");
    expect(body.chunkId).toBe(chunkId);
    expect(body.txId).toBe(DATA_TX);
  });

  it("C. fund functions are never reachable from the adapter", async () => {
    const mod = await import("./../../src/lib/storage/creatorIrysStorage");
    const src = await vi.importActual<typeof import("node:fs")>("node:fs");
    const text = src.readFileSync("src/lib/storage/creatorIrysStorage.ts", "utf8");
    expect(text).not.toMatch(/uploadCreatorPaid|fundCreatorPaidStorage|uploader\.fund/);
    void mod;
  });

  it("D. exact context propagation into the claim body", async () => {
    const fetchMock = stubClaim();
    const adapter = createCreatorIrysStorage(ctx);
    await adapter.upload(DATA, "token" as never);

    const body = lastClaimBody(fetchMock);
    expect(body.creatorIdentityId).toBe("identity-1");
    expect(body.lifecycleId).toBe("lifecycle-1");
    expect(body.capsuleId).toBe("a".repeat(64));
    expect(body.storagePaymentId).toBe("storage-pay-1");
  });

  it("E. dataTxId becomes the returned txId (evidence → authority via claim)", async () => {
    stubClaim();
    const adapter = createCreatorIrysStorage(ctx);
    const result = await adapter.upload(DATA, "token" as never);
    expect(result.txId).toBe(DATA_TX);
  });

  it("F. claim failure → adapter throws (no silent success)", async () => {
    stubClaim(409, { ok: false, error: "PUBLICATION_ALREADY_BOUND" });
    const adapter = createCreatorIrysStorage(ctx);
    await expect(adapter.upload(DATA, "token" as never)).rejects.toThrow(
      /publication claim failed/
    );
  });

  it("G. claim 503 (Node unavailable) → adapter throws, retry-compatible", async () => {
    stubClaim(503, { ok: false, error: "PUBLICATION_NODE_UNAVAILABLE" });
    const adapter = createCreatorIrysStorage(ctx);
    await expect(adapter.uploadChunk(DATA, "c".repeat(64) as never, "token" as never)).rejects.toThrow(
      /publication claim failed/
    );
  });

  it("H. uploadToken is accepted by the interface but sent nowhere", async () => {
    const fetchMock = stubClaim();
    const adapter = createCreatorIrysStorage(ctx);
    await adapter.upload(DATA, "the-upload-token" as never);

    const body = lastClaimBody(fetchMock);
    expect(body.uploadToken).toBeUndefined();
    // creatorIrys upload helper receives only (data, wallet, rpcUrl):
    expect(uploadCreatorDataMock.mock.calls[0].length).toBe(3);
  });

  it("I. the bound wallet is passed to the creator upload helper", async () => {
    stubClaim();
    const adapter = createCreatorIrysStorage(ctx);
    await adapter.upload(DATA, "token" as never);
    expect(uploadCreatorDataMock.mock.calls[0][1]).toBe(WALLET);
  });

  it("J. no executor references in the adapter module", async () => {
    const src = await vi.importActual<typeof import("node:fs")>("node:fs");
    const text = src.readFileSync("src/lib/storage/creatorIrysStorage.ts", "utf8");
    expect(text).not.toMatch(/executorHot|EXECUTOR_PRIVATE_KEY|publishCiphertext/);
    expect(text).toMatch(/executorStorage\.download/); // read-only reuse only
  });

  it("K. input Uint8Array is passed by reference (no clone)", async () => {
    stubClaim();
    const adapter = createCreatorIrysStorage(ctx);
    await adapter.upload(DATA, "token" as never);
    expect(uploadCreatorDataMock.mock.calls[0][0]).toBe(DATA);
  });

  it("L. download delegates to the existing read-only gateway path", async () => {
    executorDownloadMock.mockResolvedValue(new Uint8Array([9]));
    const adapter = createCreatorIrysStorage(ctx);
    const pointer = "P".repeat(43) as never;
    const bytes = await adapter.download(pointer);
    expect(executorDownloadMock).toHaveBeenCalledWith(pointer);
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it("M. context validation fails closed", () => {
    expect(() =>
      createCreatorIrysStorage({ ...ctx, storagePaymentId: "" } as never)
    ).toThrow(/storagePaymentId is required/);
    expect(() => createCreatorIrysStorage(null as never)).toThrow(/context is required/);
  });
});
