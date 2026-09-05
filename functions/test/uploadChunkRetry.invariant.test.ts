/**
 * C3 — Chunk upload retry idempotency (upload.ts chunk path).
 *
 * Canonical basis: consumption spec §6 ("client retry → idempotent")
 * and recovery spec §15. A lost upload response must be recoverable:
 * a same-content re-submission (chunkId is the SHA-256 of the chunk
 * ciphertext) is served from the Chunk Pointer Registry WITHOUT a
 * second publication; a different content under an existing chunkId
 * fails closed.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeKV, createFakeRequest, makeEventContext } from "./harness";
import { sha256 } from "../lib/sha256";

const publishCalls: Array<{ byteLength: number }> = [];

vi.mock("./../lib/executorHot", () => {
  class ExecutorUnavailableError extends Error {}
  return {
    ExecutorUnavailableError,
    publishCiphertext: async (_env: unknown, bytes: Uint8Array) => {
      publishCalls.push({ byteLength: bytes.byteLength });
      return { storagePointer: `tx-published-${publishCalls.length}`.padEnd(43, "0") };
    },
  };
});

vi.mock("./../api/time", () => ({
  getTrustedTime: async () => ({ nowUtc: 1_800_000_000_000, now: 1_800_000_000_000 }),
}));

import { onRequestPost as uploadPost } from "./../api/upload";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";
const CAPSULE_ID = "a".repeat(64);
const NOW = 1_800_000_000_000;

function buildEnv() {
  return {
    UPLOAD_TOKENS: createFakeKV(),
    VERIFIED_PAYMENTS: createFakeKV(),
    PUBLICATION_VERIFICATIONS: createFakeKV(),
    CHUNK_POINTER_REGISTRY: createFakeKV(),
    CREDIT_OP_COORDINATOR: { idFromName: () => ({ id: "c1" }), get: () => ({ fetch: async () => new Response("{}", { status: 200 }) }) },
  };
}

function seedToken(env: ReturnType<typeof buildEnv>) {
  env.UPLOAD_TOKENS.put(
    "t".repeat(40),
    JSON.stringify({
      capsuleId: CAPSULE_ID,
      transactionId: "tx-1",
      issuedAt: NOW - 1000,
      expiresAt: NOW + 60_000,
      permissions: { uploadChunks: true, uploadVault: false },
    })
  );
  env.VERIFIED_PAYMENTS.put("tx-1", JSON.stringify({ ok: true }));
}

function seedRegistryEntry(env: ReturnType<typeof buildEnv>, chunkId: string, pointer: string) {
  env.CHUNK_POINTER_REGISTRY.put(
    `chunk-pointer-registry:${CAPSULE_ID}`,
    JSON.stringify({ [chunkId]: pointer })
  );
}

function buildContext(env: unknown, body: Record<string, unknown>) {
  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });
  return makeEventContext({ request, env });
}

function chunkBody(chunkId: string, ciphertextB64: string, size: number) {
  return {
    uploadToken: "t".repeat(40),
    kind: "chunk",
    capsuleId: CAPSULE_ID,
    chunkId,
    ciphertext: ciphertextB64,
    declaredSize: size,
  };
}

async function postUpload(env: unknown, body: Record<string, unknown>) {
  const res = await uploadPost(buildContext(env, body));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("Chunk upload retry idempotency", () => {
  beforeEach(() => {
    publishCalls.length = 0;
  });

  it("fresh chunk publishes once and writes the registry", async () => {
    const env = buildEnv();
    seedToken(env);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const chunkId = await sha256(bytes);

    const res = await postUpload(env, chunkBody(chunkId, Buffer.from(bytes).toString("base64"), bytes.byteLength));

    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(typeof res.json.storagePointer).toBe("string");
    expect(publishCalls).toHaveLength(1);
    const registry = JSON.parse((await env.CHUNK_POINTER_REGISTRY.get(`chunk-pointer-registry:${CAPSULE_ID}`)) as string);
    expect(registry[chunkId]).toBe(res.json.storagePointer);
  });

  it("duplicate same-content chunk returns the existing pointer without publishing", async () => {
    const env = buildEnv();
    seedToken(env);
    const bytes = new Uint8Array([9, 9, 9]);
    const chunkId = await sha256(bytes);
    const existingPointer = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    seedRegistryEntry(env, chunkId, existingPointer);

    const res = await postUpload(env, chunkBody(chunkId, Buffer.from(bytes).toString("base64"), bytes.byteLength));

    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.storagePointer).toBe(existingPointer);
    expect(publishCalls).toHaveLength(0);
    const registry = JSON.parse((await env.CHUNK_POINTER_REGISTRY.get(`chunk-pointer-registry:${CAPSULE_ID}`)) as string);
    expect(registry[chunkId]).toBe(existingPointer);
  });

  it("repeat duplicate returns the same pointer again", async () => {
    const env = buildEnv();
    seedToken(env);
    const bytes = new Uint8Array([7, 7, 7]);
    const chunkId = await sha256(bytes);
    const existingPointer = "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr";
    seedRegistryEntry(env, chunkId, existingPointer);

    const first = await postUpload(env, chunkBody(chunkId, Buffer.from(bytes).toString("base64"), bytes.byteLength));
    const second = await postUpload(env, chunkBody(chunkId, Buffer.from(bytes).toString("base64"), bytes.byteLength));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json.storagePointer).toBe(existingPointer);
    expect(publishCalls).toHaveLength(0);
  });

  it("duplicate chunkId with different content fails closed without publishing", async () => {
    const env = buildEnv();
    seedToken(env);
    const original = new Uint8Array([1, 1, 1]);
    const chunkId = await sha256(original);
    const existingPointer = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    seedRegistryEntry(env, chunkId, existingPointer);

    const substituted = new Uint8Array([2, 2, 2, 2]);
    const res = await postUpload(env, chunkBody(chunkId, Buffer.from(substituted).toString("base64"), substituted.byteLength));

    expect(res.status).toBe(409);
    expect(res.json.error).toBe("CHUNK_CONTENT_MISMATCH");
    expect(publishCalls).toHaveLength(0);
    const registry = JSON.parse((await env.CHUNK_POINTER_REGISTRY.get(`chunk-pointer-registry:${CAPSULE_ID}`)) as string);
    expect(registry[chunkId]).toBe(existingPointer);
  });

  it("duplicate path cannot bypass token capsule binding", async () => {
    const env = buildEnv();
    seedToken(env);
    const bytes = new Uint8Array([5, 5, 5]);
    const chunkId = await sha256(bytes);
    seedRegistryEntry(env, chunkId, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");

    const res = await postUpload(env, {
      ...chunkBody(chunkId, Buffer.from(bytes).toString("base64"), bytes.byteLength),
      capsuleId: "b".repeat(64),
    });

    expect(res.status).toBe(403);
    expect(res.json.error).toBe("UPLOAD_TOKEN_CAPSULE_MISMATCH");
    expect(publishCalls).toHaveLength(0);
  });

  it("malformed cached pointer value fails closed", async () => {
    const env = buildEnv();
    seedToken(env);
    const bytes = new Uint8Array([6, 6, 6]);
    const chunkId = await sha256(bytes);
    seedRegistryEntry(env, chunkId, "not-a-valid-pointer");

    await expect(
      postUpload(env, chunkBody(chunkId, Buffer.from(bytes).toString("base64"), bytes.byteLength))
    ).rejects.toThrow("Invalid storage pointer");

    expect(publishCalls).toHaveLength(0);
  });
});
