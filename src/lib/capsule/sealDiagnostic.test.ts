/**
 * AETERNA — seal-failure diagnostic classification.
 *
 * Pins the two contracts that make a production sealing failure
 * observable WITHOUT leaking anything:
 *   1. the stage code is preserved (innermost boundary wins) and is
 *      surfaced in the fixed public message;
 *   2. NOTHING from the original exception — message, body, token, key,
 *      pointer or plaintext — can travel with it.
 */

import { describe, it, expect } from "vitest";

import {
  hasHttpStatusSignal,
  markWalletSignCompleted,
  readSealDiagnostic,
  resolveSealDiagnostic,
  SEAL_FAILURE_MESSAGE,
  tagSealFailure,
  walletSignCompletedCount,
  WALLET_SIGN_FAILURE,
} from "./sealDiagnostic";

describe("seal diagnostic — stage preservation", () => {
  it("tags an untagged failure with the calling boundary's code", () => {
    const tagged = tagSealFailure(new Error("inner"), "CONTAINER_UPLOAD_HTTP");

    expect(readSealDiagnostic(tagged)).toBe("CONTAINER_UPLOAD_HTTP");
    expect(tagged.message).toBe(
      `${SEAL_FAILURE_MESSAGE}: CONTAINER_UPLOAD_HTTP`
    );
  });

  it("NEVER overwrites a more precise tag (innermost boundary wins)", () => {
    const inner = tagSealFailure(null, "CONTAINER_UPLOAD_SIGN");
    const outer = tagSealFailure(inner, "CONTAINER_UPLOAD_UNKNOWN");

    expect(readSealDiagnostic(outer)).toBe("CONTAINER_UPLOAD_SIGN");
    expect(outer.message).toBe(
      `${SEAL_FAILURE_MESSAGE}: CONTAINER_UPLOAD_SIGN`
    );
  });

  it("replaces the neutral wallet tag with the owning stage code", () => {
    const wallet = tagSealFailure(new Error("rejected"), WALLET_SIGN_FAILURE);
    expect(readSealDiagnostic(wallet)).toBe(WALLET_SIGN_FAILURE);

    const container = tagSealFailure(wallet, "CONTAINER_UPLOAD_SIGN");
    expect(readSealDiagnostic(container)).toBe("CONTAINER_UPLOAD_SIGN");

    expect(resolveSealDiagnostic(wallet, "VAULT_UPLOAD")).toBe("VAULT_UPLOAD");
  });

  it("keeps the canonical message prefix for every code", () => {
    for (const code of [
      "CONTAINER_UPLOAD_CONSTRUCT",
      "CONTAINER_UPLOAD_SIGN",
      "CONTAINER_UPLOAD_SIGNED",
      "CONTAINER_UPLOAD_HTTP",
      "CONTAINER_UPLOAD_RECEIPT",
      "CONTAINER_UPLOAD_UNKNOWN",
      "CONTAINER_PUBLICATION",
      "CONTAINER_UPLOADER_BUILD",
      "CONTAINER_UPLOADER_RPC",
      "VAULT_UPLOAD",
      "PUBLICATION_VERIFY",
      "SEAL_API",
      "SEAL_VERIFY",
      "FINALIZE_CREDIT",
      "SEAL_UNKNOWN",
    ] as const) {
      const tagged = tagSealFailure(null, code);
      expect(tagged.message).toBe(`${SEAL_FAILURE_MESSAGE}: ${code}`);
    }
  });

  it("reads no code from non-objects and untagged errors", () => {
    expect(readSealDiagnostic(null)).toBeNull();
    expect(readSealDiagnostic(undefined)).toBeNull();
    expect(readSealDiagnostic("boom")).toBeNull();
    expect(readSealDiagnostic(42)).toBeNull();
    expect(readSealDiagnostic(new Error("plain"))).toBeNull();
  });
});

describe("seal diagnostic — no secret / token / plaintext can travel", () => {
  it("drops the original message entirely", () => {
    const tagged = tagSealFailure(
      new Error("uploadToken=SUPER_SECRET_TOKEN_VALUE"),
      "VAULT_UPLOAD"
    );

    expect(tagged.message).not.toContain("SUPER_SECRET_TOKEN_VALUE");
    expect(tagged.message).not.toContain("uploadToken");
  });

  it("carries only the fixed message + code, and no `cause`", () => {
    const tagged = tagSealFailure(new Error("private key 0xdeadbeef"), "SEAL_API");

    expect(tagged.message).toBe(`${SEAL_FAILURE_MESSAGE}: SEAL_API`);
    expect((tagged as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify({ ...tagged })).not.toContain("deadbeef");
  });

  it("does not copy enumerable payload fields from the original error", () => {
    const original = Object.assign(new Error("x"), {
      uploadToken: "SECRET",
      requestBody: { plaintext: "SECRET" },
    });

    const tagged = tagSealFailure(original, "SEAL_VERIFY");
    const serialized = JSON.stringify({ ...tagged });

    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("plaintext");
    expect(serialized).toContain("SEAL_VERIFY");
  });
});

describe("seal diagnostic — HTTP signal detection (shape only)", () => {
  it("detects status / statusCode / response.status", () => {
    expect(hasHttpStatusSignal({ status: 503 })).toBe(true);
    expect(hasHttpStatusSignal({ statusCode: 500 })).toBe(true);
    expect(hasHttpStatusSignal({ response: { status: 404 } })).toBe(true);
  });

  it("detects the SDK's message-only status form", () => {
    // The installed Irys SDK throws a bare Error carrying the status ONLY
    // in the message text (measured, not assumed).
    expect(
      hasHttpStatusSignal(new Error("HTTP Error: Finalising upload: 500 ERR"))
    ).toBe(true);
    expect(hasHttpStatusSignal(new Error("HTTP 404 not found"))).toBe(true);

    // The pattern is anchored: an arbitrary message containing digits is
    // NOT treated as an HTTP signal.
    expect(hasHttpStatusSignal(new Error("chunk 500 failed"))).toBe(false);
    expect(hasHttpStatusSignal(new Error("status 500"))).toBe(false);
  });

  it("ignores non-numeric and unrelated shapes", () => {
    expect(hasHttpStatusSignal(null)).toBe(false);
    expect(hasHttpStatusSignal("HTTP 500")).toBe(false);
    expect(hasHttpStatusSignal({ status: "500" })).toBe(false);
    expect(hasHttpStatusSignal(new Error("boom"))).toBe(false);
    expect(hasHttpStatusSignal({ response: { body: "x" } })).toBe(false);
  });
});

describe("seal diagnostic — wallet sign probe", () => {
  it("advances only when a signing call is reported complete", () => {
    const before = walletSignCompletedCount();
    markWalletSignCompleted();
    expect(walletSignCompletedCount()).toBe(before + 1);
  });
});
