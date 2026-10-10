import type {
  StorageAdapter,
  StoragePointer,
} from "./storageAdapter";

import {
  assertStoragePointer,
} from "./storageAdapter";

import type {
  ManifestV1
} from "@/types/manifest";
import { MANIFEST_VERSION } from "@/types/manifest";

import {
  CAPSULE_ID_REGEX,
  SALT_BASE_REGEX,
  SHA256_REGEX,
} from "@/lib/crypto/validators";

import { MAX_ENCRYPTED_VAULT_SIZE } from "@/lib/crypto/constants";
import type { ChunkPointerReadout } from "./storageAdapter";
import {
  assertContainerPublicationRecord,
  type ContainerPublicationRecord,
} from "@/lib/storage/container/containerPublication";

/**
 * AETERNA — Storage read transport (read-only)
 *
 * Read path of the former Executor Hot storage transport: gateway
 * downloads, manifest reads, and Chunk Pointer Registry lookups.
 * Publication (upload/uploadChunk) has moved to the Creator-paid
 * path: the creator wallet uploads directly to Irys and the
 * publication authority is established server-side via
 * /api/publication/claim (see creatorIrysStorage.ts).
 */

const MAX_DOWNLOAD_SIZE = 256 * 1024 * 1024;

/**
 * Operation-level deadline for ONE whole-object `download()`.
 *
 * Whole-object reads are the Vault and other small metadata objects,
 * so a single bounded request per gateway is sufficient here. This
 * constant deliberately does NOT govern range reads — see the range
 * deadline policy below.
 */
const GATEWAY_TIMEOUT = 8000;

/**
 * Range-read deadline policy.
 *
 * A range read is NOT a small request. The Container V1 layout puts a
 * full `MAX_CHUNK_SIZE` (10 MiB) chunk behind ONE `downloadRange`
 * call, and the Irys CDN serves such an object at roughly 0.7–1.5
 * MB/s. A fixed 8 s budget therefore aborts a HEALTHY 10 MiB read on
 * an ordinary connection — the confirmed Production defect (a
 * 10,485,788-byte chunk read measured 6.2–7.8 s from a clean client
 * and ~13.8 s on the affected slow link).
 *
 * The deadline is derived from the requested window at a floor
 * throughput and clamped:
 *
 *   • floor   — a small window still gets a usable budget;
 *   • ceiling — the whole operation (headers + redirects + body) can
 *     never exceed this, and it stays strictly below the caller's
 *     30 s media-read deadline, so the caller still has time to turn
 *     the failure into a terminal UI state.
 *
 * The value bounds ONE `downloadRange` call as a whole. It is NOT
 * reset per gateway attempt: a stalled endpoint consumes the shared
 * budget instead of granting every attempt a fresh one, so the total
 * work stays bounded no matter how many gateways are configured.
 *
 * ADDITIVITY INVARIANT (why the floor is small).
 *
 * A caller that reads a whole multi-chunk object issues ONE
 * `downloadRange` per chunk, SEQUENTIALLY (`ByteRuntime.getBytes`),
 * and bounds the whole read with a single 30 s deadline
 * (`MEDIA_READ_TIMEOUT_MS`). The per-call budgets therefore ADD UP,
 * so the floor must stay small enough that the sum over the real
 * plan still fits the caller's budget with room for redirects and
 * decryption:
 *
 *   chunk0 (10 MiB)     20_001 ms   ← its exact need at the floor
 *   chunk1 (2.98 MiB)    5_967 ms   ← its exact need, above the floor
 *   ─────────────────────────────
 *   sum                 25_968 ms   < 30_000 ms  ✓
 *
 * A 10 s floor would inflate chunk1 to 10_000 ms and push the sum to
 * 30_001 ms — i.e. ABOVE the caller's budget, leaving the caller's
 * timeout to pre-empt a read the inner policy considered viable. The
 * floor only ever applies to windows whose own need is smaller, so
 * lowering it cannot weaken the 0.5 MiB/s guarantee.
 */
const RANGE_DOWNLOAD_FLOOR_MS = 5_000;
const RANGE_DOWNLOAD_CEILING_MS = 24_000;

/**
 * Floor throughput a range read is allowed to assume, in bytes per
 * second. Measured Irys CDN throughput for the affected container was
 * ~0.76 MB/s, so 0.5 MiB/s is a deliberately conservative floor.
 */
const RANGE_DOWNLOAD_MIN_BYTES_PER_SEC = 512 * 1024;

/**
 * Canonical range-download deadline for a window of `length` bytes.
 *
 * Pure and deterministic: no ambient clock, no I/O. `length` is
 * already validated by `assertRangeWindow` before this is called.
 */
export function rangeDownloadDeadlineMs(length: number): number {
  const needed = Math.ceil(
    (length / RANGE_DOWNLOAD_MIN_BYTES_PER_SEC) * 1000
  );

  return Math.min(
    RANGE_DOWNLOAD_CEILING_MS,
    Math.max(RANGE_DOWNLOAD_FLOOR_MS, needed)
  );
}

/**
 * Read-only public gateways for Irys DataItems, in attempt order.
 *
 * Download uses immutable public storage gateways. The publication
 * transport is Executor Hot, while reads remain storage-provider
 * independent — the read path does not change based on who signed
 * the write.
 *
 * `gateway.irys.xyz` is the canonical Irys gateway and is the only
 * endpoint that serves these DataItems; it answers with a redirect to
 * Irys's own CDN, which the browser follows transparently.
 *
 * `arweave.net` is retained as a second public Arweave gateway. It is
 * a healthy endpoint that simply does not index Irys DataItems (it
 * answers 404 quickly), and it is the only candidate that could serve
 * an L1-format object — so it is NOT conclusively invalid and is not
 * removed.
 *
 * Removed after Production evidence (both are broken as HTTP
 * endpoints, not merely empty):
 *   • `permaweb.eu`  — TLS handshake failure (`handshake_failure`
 *     alert, no peer certificate presented), reproduced independently
 *     of any proxy. It can never serve bytes.
 *   • `arweave.live` — the domain has lapsed and now answers
 *     301 → `expireddomains.com`; the follow-up is cross-origin with
 *     no CORS headers, which surfaced as a misleading "CORS error" in
 *     Production while contributing no data.
 */
const GATEWAYS = [
  "https://gateway.irys.xyz/",
  "https://arweave.net/",
];

function failClosed(reason?: string): never {
  throw new Error(reason ?? "[AETERNA] Fail closed");
}

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Canonical bounded range window.
 *
 * A range read is a half-open request [offset, offset + length)
 * expressed on the wire as the inclusive HTTP Range
 * `bytes=<offset>-<offset + length - 1>`.
 */
export type RangeWindow = {
  readonly offset: number;
  readonly length: number;
  readonly end: number;
};

/**
 * Canonical range-window validator.
 *
 * Fail-closed boundary for every range read. Rejects:
 *
 * • non-numbers, non-integers, negatives
 * • zero or negative length
 * • unsafe integers and arithmetic overflow
 *   (offset + length - 1 must itself remain a safe integer)
 *
 * The returned `end` is the INCLUSIVE last byte offset, so callers
 * never re-derive it and can never disagree with the validator.
 */
export function assertRangeWindow(
  offset: unknown,
  length: unknown
): RangeWindow {
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    failClosed("[AETERNA] Invalid range offset");
  }

  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length <= 0
  ) {
    failClosed("[AETERNA] Invalid range length");
  }

  const end = offset + length - 1;

  /**
   * Overflow guard.
   *
   * A safe offset plus a safe length can still leave the
   * safe-integer domain. Worse, IEEE-754 rounding above 2^53 can
   * silently NARROW the window without ever leaving it — e.g.
   * offset = 2^53-1, length = 2 collapses to a 1-byte span.
   *
   * Either way the Range header would no longer describe the
   * requested window, so the round-trip is asserted explicitly
   * rather than assumed.
   */
  if (
    !Number.isSafeInteger(end) ||
    end < offset ||
    end - offset + 1 !== length
  ) {
    failClosed("[AETERNA] Range arithmetic overflow");
  }

  return { offset, length, end };
}

/**
 * Canonical `Content-Range` window matcher.
 *
 * POLICY (measured, not assumed)
 * ------------------------------
 * The Irys gateway answers a range read with `302 → Irys CDN`, and the
 * final `206` carries `Content-Range: bytes <start>-<end>/<total>` —
 * but that response does NOT list `content-range` in
 * `Access-Control-Expose-Headers`, and `Content-Range` is not a
 * CORS-safelisted response header. A cross-origin `fetch()` therefore
 * reads it as `null` in the browser. Verified against Production:
 *
 *   access-control-allow-origin: <origin>
 *   content-range: bytes 64-10485851/13613786      ← present on the wire
 *   access-control-expose-headers: (absent on the 206)
 *
 * `null` therefore means ONLY "the header is not available to this
 * caller" (CORS, or a genuinely absent header) and is NOT a gate —
 * gating on it would break every working read. HTTP 206 plus the
 * exact-length contract remain the binding checks.
 *
 * Any OTHER value means a Content-Range WAS readable, and a readable
 * header is authoritative: it must be well-formed and describe exactly
 * the requested window.
 *
 *   • `null`                     → not available → NOT a gate (true)
 *   • `""` / whitespace          → readable but empty → REJECTED
 *   • malformed                  → readable but unusable → REJECTED
 *   • `bytes <s>-<e>[/<n>|*]`    → accepted only if s/e match the
 *                                  requested window exactly
 *
 * The `/<total>` field may be a number or `*` and is never compared —
 * only the start/end of the returned window are authoritative.
 *
 * Rejection is not fatal on its own: the caller skips the gateway and
 * may still be served by the next one, all inside the single shared
 * range deadline.
 */
export function contentRangeMatches(
  headerValue: string | null,
  window: RangeWindow
): boolean {
  // `null` = the header is unavailable to this caller (e.g. a
  // cross-origin response that does not expose it through CORS).
  // This is the Production Irys path, so it must not be a gate.
  if (headerValue === null) {
    return true;
  }

  // A value WAS readable, so it is authoritative: it must be a
  // well-formed Content-Range for exactly the requested window.
  // Empty, malformed and mismatching values are all rejected.
  const match = /^bytes\s+(\d+)-(\d+)\s*(?:\/(?:\d+|\*))?$/i.exec(
    headerValue.trim()
  );

  if (!match) return false;

  return (
    Number(match[1]) === window.offset &&
    Number(match[2]) === window.end
  );
}

/**
 * Builds the canonical Irys/Arweave range-read URL.
 *
 * `https://<gateway>/tx/<txId>/data`
 */
function buildRangeUrl(gateway: string, txId: string): string {
  const base = gateway.endsWith("/") ? gateway : gateway + "/";
  return `${base}tx/${txId}/data`;
}

/**
 * Canonical Manifest validator.
 *
 * Validates the production ManifestV1 boundary before the manifest
 * enters the runtime. This is the single source of truth for
 * manifest-shape validation on the read path.
 */
function assertStrictManifestShape(
  manifest: unknown,
  capsuleId: string
): asserts manifest is ManifestV1 {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !isPlainObject(manifest)
  ) {
    failClosed("[AETERNA] Invalid manifest shape");
  }

  const obj = manifest as Record<string, unknown>;

  if (
    obj["version"] !== MANIFEST_VERSION ||
    obj["capsuleId"] !== capsuleId ||

    typeof obj["openAt"] !== "number" ||
    !Number.isSafeInteger(obj["openAt"] as number) ||

    typeof obj["sealedAt"] !== "number" ||
    !Number.isSafeInteger(obj["sealedAt"] as number) ||

    (obj["openAt"] as number) <= (obj["sealedAt"] as number) ||

    typeof obj["saltBase"] !== "string" ||
    !SALT_BASE_REGEX.test(obj["saltBase"] as string) ||

    typeof obj["encryptedSizeBytes"] !== "number" ||
    !Number.isSafeInteger(obj["encryptedSizeBytes"] as number) ||
    !Number.isInteger(obj["encryptedSizeBytes"] as number) ||
    (obj["encryptedSizeBytes"] as number) <= 0 ||
    (obj["encryptedSizeBytes"] as number) > MAX_ENCRYPTED_VAULT_SIZE ||

    typeof obj["vaultTxId"] !== "string" ||

    !isPlainObject(obj["ext"]) ||
    typeof (obj["ext"] as Record<string, unknown>)["vaultSha256"] !==
      "string" ||
    !SHA256_REGEX.test(
      (obj["ext"] as Record<string, unknown>)["vaultSha256"] as string
    )
  ) {
    failClosed("[AETERNA] Invalid manifest fields");
  }
}

/**
 * Reads the container publication from the readout response. Absence (or an
 * explicit null) means the capsule is not published yet; a
 * present-but-malformed record fails closed.
 */
function readContainerPublication(
  value: unknown,
  capsuleId: string
): ContainerPublicationRecord | null {
  if (!isPlainObject(value)) {
    failClosed("[AETERNA] Invalid publication response");
  }

  if (value["capsuleId"] !== capsuleId) {
    failClosed("[AETERNA] Publication capsule mismatch");
  }

  if (!("container" in value)) return null;

  const raw = value["container"];
  if (raw === null || raw === undefined) return null;

  try {
    return assertContainerPublicationRecord(raw, capsuleId);
  } catch {
    failClosed("[AETERNA] Invalid container publication record");
  }
}

/**
 * The single fetch behind the canonical Container V1 publication readout.
 */
async function fetchChunkPointerReadout(
  capsuleId: string
): Promise<ChunkPointerReadout> {
  if (typeof capsuleId !== "string" || !CAPSULE_ID_REGEX.test(capsuleId)) {
    failClosed("[AETERNA] Invalid capsule ID");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT);

  try {
    const res = await fetch(
      `/api/capsule/${encodeURIComponent(capsuleId)}/chunk-pointers`,
      { cache: "no-store", signal: controller.signal }
    );

    if (!res.ok || res.status !== 200) {
      failClosed("[AETERNA] Chunk pointer fetch failed");
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      failClosed("[AETERNA] Invalid chunk pointer content type");
    }

    const payload: unknown = await res.json();

    const container = readContainerPublication(payload, capsuleId);

    return Object.freeze({ container });
  } catch (cause) {
    if (import.meta.env.DEV) {
      console.error("[executor-hot] container readout failed", cause);
    }
    failClosed(
      cause instanceof Error
        ? cause.message
        : "[AETERNA] Chunk pointer fetch failed"
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read-only storage contract: the subset of StorageAdapter that
 * remains after the Creator-paid upload path replaced Executor Hot.
 */
/**
 * Read-only storage contract: the subset of StorageAdapter that
 * remains after the Creator-paid upload path replaced Executor Hot.
 *
 * `downloadRange` is REQUIRED here even though it is optional on the
 * general StorageAdapter contract: this adapter does support bounded
 * range reads, and callers of the read transport must be able to rely
 * on that without an extra presence check.
 */
export type ExecutorReadStorageAdapter = Pick<
  StorageAdapter,
  "name" | "download" | "getManifest" | "getChunkPointerReadout"
> & {
  downloadRange(
    pointer: StoragePointer,
    offset: number,
    length: number
  ): Promise<Uint8Array<ArrayBuffer>>;
};

export const executorStorage: ExecutorReadStorageAdapter = {
  name: "executor-hot",


  async download(txId: StoragePointer): Promise<Uint8Array<ArrayBuffer>> {
    assertStoragePointer(txId);

    for (const gateway of GATEWAYS) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT);

      try {
        const url = gateway.endsWith("/") ? gateway + txId : gateway + "/" + txId;

        const res = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });

        if (!res.ok || res.status !== 200) continue;

        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("text/html")) continue;

        const buffer = await res.arrayBuffer();

        if (buffer.byteLength === 0 || buffer.byteLength > MAX_DOWNLOAD_SIZE) {
          continue;
        }

        clearTimeout(timeout);
        return new Uint8Array(buffer);
      } catch (cause) {
        if (import.meta.env.DEV) {
          console.warn(`[executor-hot] gateway failed: ${gateway}`, cause);
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    failClosed("[AETERNA] All gateways failed");
  },

  /**
   * Bounded range read.
   *
   * Reads exactly `length` bytes starting at `offset` of the object
   * identified by `txId`, using the proven Irys/Arweave range
   * endpoint:
   *
   *   GET https://<gateway>/tx/<txId>/data
   *   Range: bytes=<offset>-<offset + length - 1>
   *
   * Contract (all fail-closed):
   *
   * • pointer, offset and length are validated before any I/O
   * • a successful read MUST be HTTP 206 (Partial Content)
   * • the received body MUST be EXACTLY `length` bytes
   * • a 200 (full-object) response is NEVER accepted — the caller
   *   asked for a bounded window, and a gateway that ignores Range
   *   is not a valid range source
   * • 4xx/5xx, empty bodies, HTML error pages and short/long bodies
   *   are rejected
   * • no silent full-object fallback exists on any path
   *
   * `Content-Range` policy: `null` — the header is unavailable to the
   * browser, measured on the Production Irys path whose CDN 206 does
   * not expose it through CORS — is NOT a gate. Any OTHER readable
   * value IS authoritative: it must be well-formed and describe
   * exactly the requested window, otherwise the gateway is skipped.
   * See `contentRangeMatches` for the exact policy.
   *
   * Gateways are tried in the same order as `download()`: a gateway
   * that cannot serve a correct 206 window is skipped, and if none
   * can, the call fails closed. Skipping is NOT a fallback — a
   * full-object response is never used to satisfy a range read.
   *
   * DEADLINE — see `rangeDownloadDeadlineMs`. The whole call (headers,
   * redirects and body, across every gateway attempt) shares ONE
   * budget derived from the window size. It is deliberately NOT the
   * whole-object `GATEWAY_TIMEOUT`: a 10 MiB container chunk cannot
   * complete inside 8 s on a slow but healthy link, which is exactly
   * how a valid read was being aborted. A spent budget aborts the
   * in-flight request and yields a terminal, non-hanging error.
   */
  async downloadRange(
    txId: StoragePointer,
    offset: number,
    length: number
  ): Promise<Uint8Array<ArrayBuffer>> {
    assertStoragePointer(txId);

    const window = assertRangeWindow(offset, length);

    /**
     * ONE deadline for the WHOLE operation — request headers,
     * redirects and the full response body — shared by every gateway
     * attempt. `fetch()` follows redirects and `arrayBuffer()` streams
     * the body, so a single signal bounds both; the budget is never
     * reset per attempt.
     */
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(),
      rangeDownloadDeadlineMs(window.length)
    );

    try {
      for (const gateway of GATEWAYS) {
        // A spent budget must not start another attempt.
        if (controller.signal.aborted) break;

        try {
          const url = buildRangeUrl(gateway, txId);

          const res = await fetch(url, {
            cache: "no-store",
            signal: controller.signal,
            headers: {
              Range: `bytes=${window.offset}-${window.end}`,
            },
          });

          // A range read is only satisfied by Partial Content.
          if (res.status !== 206) continue;

          const contentType = res.headers.get("content-type") ?? "";
          if (contentType.includes("text/html")) continue;

          // A READABLE Content-Range is authoritative: it must be
          // well-formed and describe exactly the requested window.
          // `null` means the header is unavailable to the browser
          // (the Production Irys CDN does not expose it through CORS)
          // and is not a gate. A skipped gateway is retried within the
          // same shared deadline — see `contentRangeMatches`.
          if (
            !contentRangeMatches(
              res.headers.get("content-range"),
              window
            )
          ) {
            continue;
          }

          const buffer = await res.arrayBuffer();

          // Exact-length contract: a short or long body is a
          // gateway/protocol failure, never a partial success.
          if (buffer.byteLength !== window.length) continue;

          return new Uint8Array(buffer);
        } catch (cause) {
          if (import.meta.env.DEV) {
            console.warn(`[executor-hot] gateway range failed: ${gateway}`, cause);
          }

          // The shared deadline fired — no later attempt can succeed.
          if (controller.signal.aborted) break;
        }
      }
    } finally {
      clearTimeout(deadline);
    }

    // A deadline abort is a distinct, actionable terminal outcome; any
    // other exhaustion is the canonical range-read failure.
    if (controller.signal.aborted) {
      failClosed("[AETERNA] Range read timed out");
    }

    failClosed("[AETERNA] Range read failed");
  },

  async getManifest(capsuleId: string): Promise<ManifestV1> {
    if (typeof capsuleId !== "string" || !CAPSULE_ID_REGEX.test(capsuleId)) {
      failClosed("[AETERNA] Invalid capsule ID");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT);

    try {
      const res = await fetch(
        `/api/capsule/${encodeURIComponent(capsuleId)}`,
        { cache: "no-store", signal: controller.signal }
      );

      if (!res.ok || res.status !== 200) {
        failClosed("[AETERNA] Manifest fetch failed");
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        failClosed("[AETERNA] Invalid manifest content type");
      }

      const manifest: unknown = await res.json();

      assertStrictManifestShape(manifest, capsuleId);

      assertStoragePointer(manifest.vaultTxId);

      return manifest;
    } catch (cause) {
      if (import.meta.env.DEV) {
        console.error("[executor-hot] getManifest failed", cause);
      }
      failClosed(
        cause instanceof Error
          ? cause.message
          : "[AETERNA] Manifest fetch failed"
      );
    } finally {
      clearTimeout(timeout);
    }
  },

  /**
   * The canonical Container V1 publication readout. `container: null` means
   * the capsule has no container publication yet.
   */
  async getChunkPointerReadout(
    capsuleId: string
  ): Promise<ChunkPointerReadout> {
    return fetchChunkPointerReadout(capsuleId);
  },
};