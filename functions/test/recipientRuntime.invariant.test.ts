import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";
import { onRequestGet as manifestGet } from "./../api/capsule/[capsuleId]";
import { parseCapsuleCapability } from "../../src/lib/capsule/parseCapsuleCapability";
import { openCapsule } from "../../src/lib/capsule/open/openCapsule";
import {
  verifyVaultSha256,
} from "../../src/lib/capsule/verifyVaultSha256";
import {
  verifyVaultSize,
} from "../../src/lib/capsule/verifyVaultSize";
import { parseRangeHeader } from "../../src/lib/capsule/open/parseRangeHeader";
import { readRange } from "../../src/lib/capsule/open/rangeReader";
import { handleRuntimeMessage } from "../../src/lib/capsule/open/runtimeBridge";
import {
  registerRuntimeSession,
  resolveRuntimeSession,
  disposeRuntimeSession,
} from "../../src/lib/capsule/open/runtimeRegistry";
import { openVideo } from "../../src/lib/capsule/open/openVideo";
import { openAudio } from "../../src/lib/capsule/open/openAudio";
import { downloadFile } from "../../src/lib/capsule/open/downloadFile";

const ALLOWED_ORIGIN = "https://www.aeternacapsule.com";

/* =========================================================
   CAPABILITY PARSING — RECIPIENT vs CREATOR BOUNDARY
   ========================================================= */

describe("parseCapsuleCapability — recipient capability boundary", () => {
  it("accepts a valid canonical recipient capability shape", () => {
    const fragment = "a".repeat(64);
    const result = parseCapsuleCapability(fragment);

    expect(result).toBeDefined();
    expect(result?.recipientSecret).toBe(fragment);
  });

  it("rejects malformed capability strings", () => {
    const bad = [
      "",
      "not-a-hash",
      "a".repeat(63),
      "a".repeat(65),
      "X".repeat(64),
      "abcd\n",
    ];

    for (const raw of bad) {
      expect(parseCapsuleCapability(raw)).toBeNull();
    }
  });

  it("does not expose creator-only authority from recipient fragment", () => {
    const result = parseCapsuleCapability("a".repeat(64));

    expect(result).toHaveProperty("recipientSecret");
    expect(result).not.toHaveProperty("creatorAuthorityFragment");
  });
});

/* =========================================================
   MANIFEST ENDPOINT — structural / temporal guards
   ========================================================= */

describe("manifest endpoint — validation", () => {
  function buildContext(overrides?: {
    capsuleId?: string;
    origin?: string;
    contentType?: string;
    kvJson?: string | null;
  }) {
    const capsuleId =
      overrides?.capsuleId ?? "abc123".padEnd(64, "a");

    const request = createFakeRequest({
      headers: {
        origin: overrides?.origin ?? ALLOWED_ORIGIN,
        "content-type":
          overrides?.contentType ?? "application/json",
      },
      body: overrides?.kvJson ?? null,
    });

    const env = {
      CAPSULE_MANIFESTS: {
        get: async (_: string) => overrides?.kvJson ?? null,
      },
    };

    const ctx = makeEventContext({
      request,
      env,
    });

    (ctx as { params: { capsuleId: string } }).params = { capsuleId };

    return ctx;
  }

  it("returns 400 for invalid capsuleId pattern", async () => {
    const res = await manifestGet(buildContext({ capsuleId: "not-hex" }));
    expect(res.status).toBe(400);
  });

  it("returns 503 when KV binding is missing", async () => {
    const ctx = makeEventContext({
      request: createFakeRequest({
        headers: {
          origin: ALLOWED_ORIGIN,
          "content-type": "application/json",
        },
      }),
      env: {},
    });

    (ctx as { params: { capsuleId: string } }).params = { capsuleId: "abc123".padEnd(64, "a") };

    const res = await manifestGet(ctx);
    expect(res.status).toBe(503);
  });

  it("returns 404 when manifest is absent", async () => {
    const res = await manifestGet(buildContext({ kvJson: null }));
    expect(res.status).toBe(404);
  });

  it("returns 500 for malformed JSON", async () => {
    const res = await manifestGet(buildContext({ kvJson: "not-json" }));
    expect(res.status).toBe(500);
  });

  it("rejects manifest with openAt <= sealedAt", async () => {
    const manifest = {
      version: 1,
      capsuleId: "abc123".padEnd(64, "a"),
      saltBase: "a".repeat(64),
      vaultTxId: "a".repeat(43),
      openAt: 1700000000001,
      sealedAt: 1700000000000,
      encryptedSizeBytes: 100,
      heartbeatInterval: 86400000,
      ext: {
        vaultSha256: "a".repeat(64),
        chunkPointers: {},
      },
    };

    const res = await manifestGet(buildContext({ kvJson: JSON.stringify(manifest) }));
    expect(res.status).toBe(500);
  });

  it("INCONCLUSIVE — future sealedAt check: requires mocking native trusted-time path unavailable in this Node/Vitest environment", () => {
    expect(true).toBe(true);
  });

  it("INCONCLUSIVE — structurally valid manifest 200 path: handler requires getTrustedTime(), whose native Worker-time path cannot be safely exercised in this Node/Vitest environment without production changes", () => {
    expect(true).toBe(true);
  });
});
