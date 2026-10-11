/**
 * =========================================================
 * Media failure diagnostics — Phase F1 typed-boundary classification
 * =========================================================
 *
 * Phase F found that `PREVIEW_READ_FAILED` is the CATCH-ALL for any
 * untagged error inside the bounded Blob fallback, so a per-range
 * storage timeout, a gateway/window rejection and a decrypt failure
 * were indistinguishable in a screenshot.
 *
 * Phase F1 introduced TYPED boundaries
 * (`StorageRangeError`, `ChunkLoadError`, `ByteRuntimeReconstructionError`)
 * and taught `classifyMediaFailure` to map each to its OWN stable code.
 * This suite asserts that mapping and that the pre-existing
 * catch-all/`STREAM_*` behaviour is unchanged off-fallback.
 *
 * NOTHING here is proven on a physical iPhone — these are synthetic
 * typed errors fed straight to the pure classifier.
 */
import { describe, it, expect } from "vitest";

import {
  classifyMediaFailure,
  MEDIA_DIAGNOSTIC_CODES,
  type MediaOpenDiagnosticContext,
} from "./mediaFailureDiagnostics";
import { StorageRangeError } from "@/lib/storage/storageRangeFailure";
import {
  ChunkLoadError,
  ByteRuntimeReconstructionError,
} from "@/lib/capsule/runtime/chunkLoadFailure";
import { BoundedAwaitTimeoutError } from "./boundedAwait";

const CAP: MediaOpenDiagnosticContext = {
  mediaType: "video",
  fallbackTrigger: "capability",
};
const MSE: MediaOpenDiagnosticContext = {
  mediaType: "video",
  fallbackTrigger: "mse-setup",
};

describe("Phase F1 — typed boundaries map to distinct preview codes", () => {
  it("inner per-range storage TIMEOUT → PREVIEW_RANGE_TIMEOUT (distinct from outer)", () => {
    const d = classifyMediaFailure(new StorageRangeError("range-timeout"), CAP);
    expect(d.code).toBe("PREVIEW_RANGE_TIMEOUT");
    expect(d.code).not.toBe("PREVIEW_READ_TIMEOUT");
    expect(d.fallbackTrigger).toBe("capability");
  });

  it("outer whole-file timeout still → PREVIEW_READ_TIMEOUT (unchanged)", () => {
    const d = classifyMediaFailure(
      new BoundedAwaitTimeoutError("media fallback read", 30_000),
      CAP,
    );
    expect(d.code).toBe("PREVIEW_READ_TIMEOUT");
    expect(d.code).not.toBe("PREVIEW_RANGE_TIMEOUT");
  });

  it("range gateway/status/window rejection → PREVIEW_RANGE_FAILED", () => {
    const d = classifyMediaFailure(new StorageRangeError("range-rejected"), CAP);
    expect(d.code).toBe("PREVIEW_RANGE_FAILED");
    expect(d.fallbackTrigger).toBe("capability");
  });

  it("range transport failure → PREVIEW_RANGE_NETWORK", () => {
    const d = classifyMediaFailure(new StorageRangeError("range-network"), CAP);
    expect(d.code).toBe("PREVIEW_RANGE_NETWORK");
    expect(d.fallbackTrigger).toBe("capability");
  });

  it("chunk ciphertext-length mismatch → PREVIEW_CHUNK_LENGTH_MISMATCH", () => {
    const d = classifyMediaFailure(
      new ChunkLoadError("chunk-length-mismatch"),
      CAP,
    );
    expect(d.code).toBe("PREVIEW_CHUNK_LENGTH_MISMATCH");
  });

  it("AES-GCM decryption rejection → PREVIEW_DECRYPT_FAILED", () => {
    const d = classifyMediaFailure(
      new ChunkLoadError("chunk-decrypt-failed"),
      CAP,
    );
    expect(d.code).toBe("PREVIEW_DECRYPT_FAILED");
  });

  it("ByteRuntime reconstruction/allocation failure → PREVIEW_RECONSTRUCTION_FAILED", () => {
    const d = classifyMediaFailure(new ByteRuntimeReconstructionError(), CAP);
    expect(d.code).toBe("PREVIEW_RECONSTRUCTION_FAILED");
  });

  it("an unclassifiable fallback error stays the generic catch-all", () => {
    const d = classifyMediaFailure(new Error("something unexpected"), CAP);
    expect(d.code).toBe("PREVIEW_READ_FAILED");
  });

  it("the mse-setup trigger is preserved on the new typed codes too", () => {
    const d = classifyMediaFailure(new StorageRangeError("range-timeout"), MSE);
    expect(d.code).toBe("PREVIEW_RANGE_TIMEOUT");
    expect(d.fallbackTrigger).toBe("mse-setup");
  });
});

describe("Phase F1 — typed errors OFF the fallback keep the pre-existing codes", () => {
  it("a typed range failure with NO trigger is STREAM_READ_FAILED, not a PREVIEW_* code", () => {
    const d = classifyMediaFailure(new StorageRangeError("range-timeout"), {
      mediaType: "video",
    });
    expect(d.code).toBe("STREAM_READ_FAILED");
    expect(d.fallbackTrigger).toBeUndefined();
  });

  it("a typed chunk failure with NO trigger is STREAM_READ_FAILED", () => {
    const d = classifyMediaFailure(
      new ChunkLoadError("chunk-decrypt-failed"),
      { mediaType: "video" },
    );
    expect(d.code).toBe("STREAM_READ_FAILED");
  });

  it("a typed reconstruction failure with NO trigger is STREAM_READ_FAILED", () => {
    const d = classifyMediaFailure(new ByteRuntimeReconstructionError(), {
      mediaType: "video",
    });
    expect(d.code).toBe("STREAM_READ_FAILED");
  });
});

describe("Phase F1 — safety: every new code is stable and its copy is fixed/safe", () => {
  const typedFailures: ReadonlyArray<[unknown, string]> = [
    [new StorageRangeError("range-timeout"), "PREVIEW_RANGE_TIMEOUT"],
    [new StorageRangeError("range-rejected"), "PREVIEW_RANGE_FAILED"],
    [new StorageRangeError("range-network"), "PREVIEW_RANGE_NETWORK"],
    [new ChunkLoadError("chunk-length-mismatch"), "PREVIEW_CHUNK_LENGTH_MISMATCH"],
    [new ChunkLoadError("chunk-decrypt-failed"), "PREVIEW_DECRYPT_FAILED"],
    [new ByteRuntimeReconstructionError(), "PREVIEW_RECONSTRUCTION_FAILED"],
  ];

  it.each(typedFailures)(
    "code is registered and its message carries no dynamic value (%#)",
    (err, expected) => {
      const d = classifyMediaFailure(err, CAP);
      expect(d.code).toBe(expected);
      expect(MEDIA_DIAGNOSTIC_CODES).toContain(d.code);
      // Fixed/safe copy: the human message contains only the stable code
      // in parentheses and NEVER the underlying error's own message text.
      expect(d.message).toContain(expected);
      expect(d.message).not.toContain("[AETERNA]");
      expect(d.message).not.toMatch(/https?:|blob:|[0-9a-f]{20,}/i);
    },
  );

  it("does not leak the typed error's own message into the rendered copy", () => {
    const secretish = new StorageRangeError("range-rejected");
    // The typed error's own message is a fixed safe string, but it must
    // still never be rendered verbatim — only the diagnostic copy is.
    const d = classifyMediaFailure(secretish, CAP);
    expect(d.message).not.toBe(secretish.message);
  });
});
