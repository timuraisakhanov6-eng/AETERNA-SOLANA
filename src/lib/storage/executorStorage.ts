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
import {
  StorageRangeError,
  type StorageRangeRejectionReason,
} from "./storageRangeFailure";
import {
  HEADER_SIZE,
  parseContainerHeader,
} from "./container/containerLayout";

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
 * ABSOLUTE operation budget for a container read that may fall back to a
 * bounded FULL-CONTAINER GET (Phase F3.3.2).
 *
 * This is the canonical single lifetime of ONE `downloadRange` call that
 * carries a trusted container hint. It deliberately EXCEEDS the 24 s
 * range ceiling: a healthy Container V1 read of the real plan needs
 * ~25,966 ms of transfer at the 512 KiB/s floor, which the 24 s clamp
 * could not accommodate.
 *
 * WHY 30 s IS A HARD BOUND, NOT A TARGET
 * --------------------------------------
 * The caller (`emergencyMediaSource`) wraps each per-chunk read in
 * `withTimeout(..., MEDIA_READ_TIMEOUT_MS = 30_000)`. That wrapper is a
 * CALLER-SIDE bound only — `withTimeout` never cancels the underlying
 * promise, and `MediaSession.read()` carries no `AbortSignal`, so the
 * outer bound does NOT propagate to the network. The ONLY thing that
 * aborts the in-flight container GET is the timer armed here. The
 * allowance must therefore stay strictly BELOW the caller's 30 s so the
 * adapter reaches its own terminal state before the caller gives up.
 *
 * SINGLE LIFETIME, NOT RESET
 * --------------------------
 * The timer is armed ONCE at `downloadRange` entry and is NEVER reset
 * when the operation switches to the fallback. Elapsed Range-attempt
 * time is therefore SUBTRACTED automatically: the fallback only ever
 * gets what is LEFT of this one absolute budget, never a fresh window.
 */
const CONTAINER_OPERATION_BUDGET_MS = 30_000;

/**
 * Allowance for the Range-attempt phase that PRECEDES the fallback.
 *
 * The container path shares ONE absolute lifetime: the Range attempts,
 * the fallback GET and the final validation all live inside the single
 * timer armed at `downloadRange` entry. A fallback can only begin AFTER
 * at least one Range attempt has run, so the CONTAINER's transfer need
 * alone is not a sufficient allowance — the budget must also cover the
 * Range phase that is consumed first. This reserve is that allowance.
 *
 * It is deliberately modest (1 s): the status-gate rejection that
 * enables the fallback is fast (a 200/403 answer, not a body), and the
 * real cost is dwarfed by the container transfer itself.
 */
const CONTAINER_RANGE_PHASE_RESERVE_MS = 1_000;

/**
 * Allowance for HTTP setup, redirects and the adapter's FINAL validation
 * (exact length + `parseContainerHeader` + `chunkCount`) on the
 * full-container fallback.
 *
 * WHY IT IS REQUIRED (Phase F3.3.3)
 * ---------------------------------
 * The honest transfer time of the real container is
 * `ceil(13,613,786 / 512 KiB/s) = 25,967 ms`. Adding the 1,000 ms
 * Range-phase reserve gives a TRUE operation need of 26,967 ms against
 * an allowance of `min(29,000, 25,967 + 1,000) = 26,967 ms` — i.e.
 * EXACTLY equal, with ZERO headroom. An earlier test masked this by
 * modelling a body 500 ms faster than the real transfer. Real HTTP
 * setup, redirects and post-body validation need margin, so the
 * allowance must exceed transfer + range phase by this reserve.
 */
const CONTAINER_COMPLETION_RESERVE_MS = 1_000;

/**
 * Hard ceiling for the container path: the absolute budget minus a small
 * reserve, so the adapter still has time to run its own final
 * length/header/`chunkCount` validation and settle terminally inside the
 * caller's 30 s bound. Strictly greater than `RANGE_DOWNLOAD_CEILING_MS`
 * (this is the whole point of F3.3.2) and strictly less than
 * `CONTAINER_OPERATION_BUDGET_MS`.
 */
const CONTAINER_DOWNLOAD_CEILING_MS = CONTAINER_OPERATION_BUDGET_MS - 1_000;

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
 * Operation deadline for a range read that MAY fall back to a bounded
 * FULL-CONTAINER GET (Phases F3.3.1, F3.3.2).
 *
 * WHY THIS EXISTS
 * ---------------
 * `downloadRange` arms ONE deadline from the WINDOW it was asked for.
 * That is correct for the Range attempt, but the F3.3 fallback then
 * downloads the WHOLE container under that same budget — a budget sized
 * for a single chunk. Measured against the real plan the two disagree
 * badly (512 KiB/s floor):
 *
 *   d(chunk1 = 3,127,934 B) =  5,967 ms
 *   full container (13.6 MB) = 25,967 ms to transfer
 *
 * F3.3.1 fixed the SIZE mismatch (window → container). F3.3.2 fixes the
 * remaining CEILING mismatch: `rangeDownloadDeadlineMs` clamps at 24 s,
 * but the real container needs ~25,967 ms of transfer and the Range
 * attempts consume a little more on top, so an otherwise-healthy
 * fallback was still aborted ~2 s early.
 *
 * MODEL
 * -----
 * The allowance is the LARGER of:
 *   • the window's own need (`rangeDownloadDeadlineMs`, never shortened
 *     — the Range attempt is unchanged), and
 *   • the CONTAINER's total need at the same 512 KiB/s floor: its
 *     transfer time PLUS `CONTAINER_RANGE_PHASE_RESERVE_MS` (the Range
 *     attempts that precede the fallback) PLUS
 *     `CONTAINER_COMPLETION_RESERVE_MS` (HTTP setup and final
 *     validation), clamped to `CONTAINER_DOWNLOAD_CEILING_MS` (29 s).
 *
 * For the real plan this yields ~27,967 ms of TOTAL need against a
 * 29,000 ms allowance — a genuine ~1,000 ms of headroom, PAST the old
 * 24 s clamp and still strictly inside the caller's 30 s absolute bound.
 * Because the timer is armed once at operation entry and never reset,
 * elapsed Range time is subtracted automatically: this is the
 * fallback's SHARE of ONE absolute lifetime, not a fresh window.
 *
 * This is a pure size→budget mapping; it loosens no integrity, streaming,
 * memory or fail-closed guarantee.
 */
export function containerRangeDeadlineMs(
  windowLength: number,
  containerSize: number
): number {
  const transferNeed = Math.ceil(
    (containerSize / RANGE_DOWNLOAD_MIN_BYTES_PER_SEC) * 1000
  );

  const containerAllowance = Math.min(
    CONTAINER_DOWNLOAD_CEILING_MS,
    transferNeed +
      CONTAINER_RANGE_PHASE_RESERVE_MS +
      CONTAINER_COMPLETION_RESERVE_MS
  );

  return Math.max(
    rangeDownloadDeadlineMs(windowLength),
    containerAllowance
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
    length: number,
    containerHint?: ContainerReadHint
  ): Promise<Uint8Array<ArrayBuffer>>;
};

/* ==================================================================
 * Phase F3.3 — BOUNDED FULL-CONTAINER FALLBACK
 * ==================================================================
 *
 * WHY
 * ---
 * The Production Irys/Arweave delivery path for Container V1 answers a
 * `Range` request with HTTP 200 and the WHOLE object (no 206, no
 * `Content-Range`) — confirmed on a physical iPhone 13 / iOS 26.5, where
 * the reader reported `HTTP statuses: 200, 400` and failed closed.
 *
 * A `200` on a range request is still NOT accepted as a range response.
 * Instead, ONLY when every gateway was rejected by the STATUS gate
 * (exactly `status-not-206` — the same condition that produces the
 * `PREVIEW_RANGE_STATUS_REJECTED` diagnostic) and the container is known
 * to be small, the reader performs a SEPARATE ordinary GET (no `Range`
 * header) of the whole container and serves the requested window from it.
 *
 * GUARANTEES
 * ----------
 *  • Never triggers on a network failure, a timeout, an AES-GCM error, a
 *    metadata/auth failure, a corrupt or oversized container, or any
 *    exception that merely looks like a range rejection.
 *  • The expected size and chunk count come from the DIGEST-VERIFIED
 *    layout (`resolveContainerChunks`), never from the response.
 *  • Hard ceiling of 20 MiB (including the 64-byte header), checked
 *    BEFORE any network I/O; larger containers keep the pure fail-closed
 *    Range path.
 *  • The body is read as a STREAM with a running byte counter and is
 *    cancelled the moment the ceiling is exceeded — never
 *    `arrayBuffer()`-then-check.
 *  • Exact length equality, `parseContainerHeader()`, and the header's
 *    `chunkCount` are all validated before any byte is returned.
 *  • One container GET serves every chunk of that container (single
 *    flight + a single settled entry, strictly bounded).
 *  • It shares the CALLER's `AbortController`, so the operation's single
 *    deadline is never reset and no pending request outlives it.
 *  • The original typed failure is preserved: any fallback problem simply
 *    falls through to the unchanged `StorageRangeError`.
 */

/**
 * The trusted, digest-verified container totals supplied by the reader.
 * READ-TIME ONLY — never persisted (see `ChunkContainerPosition`).
 */
export interface ContainerReadHint {
  /** `layout.containerSize` — header + every chunk. */
  readonly size: number;
  /** `layout.chunkCount`. */
  readonly chunkCount: number;
}

/**
 * Hard ceiling for the bounded full-container fallback: 20 MiB,
 * INCLUDING the 64-byte header.
 */
export const CONTAINER_FULL_FALLBACK_MAX_BYTES = 20 * 1024 * 1024;

/** Structural validation only; the size CEILING is checked separately. */
function isContainerReadHint(value: unknown): value is ContainerReadHint {
  if (!value || typeof value !== "object") return false;
  const h = value as Record<string, unknown>;
  const size = h["size"];
  const chunkCount = h["chunkCount"];
  return (
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size >= HEADER_SIZE &&
    typeof chunkCount === "number" &&
    Number.isSafeInteger(chunkCount) &&
    chunkCount >= 1
  );
}

/**
 * Reads a response body as a STREAM with a hard byte ceiling.
 *
 * Returns `null` (fail closed) when the runtime cannot stream the body,
 * the stream errors, the signal aborts, or the running total exceeds
 * `limit` — in the last case the reader is cancelled immediately so no
 * further bytes are pulled. Never buffers more than `limit` + one chunk.
 */
async function readBodyBounded(
  res: Response,
  limit: number
): Promise<Uint8Array | null> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") return null;

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    return null;
  }

  const parts: Uint8Array[] = [];
  let total = 0;
  let ok = false;

  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;

      const value = step.value;
      if (!value || value.byteLength === 0) continue;

      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // best-effort — the ceiling decision already stands
        }
        return null;
      }
      parts.push(value);
    }

    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
      out.set(part, cursor);
      cursor += part.byteLength;
    }
    ok = true;
    return out;
  } catch {
    return null;
  } finally {
    if (!ok) {
      for (const part of parts) part.fill(0);
    }
    parts.length = 0;
    try {
      reader.releaseLock();
    } catch {
      // best-effort
    }
  }
}

/**
 * Validates a fetched container against the TRUSTED hint. Fail-closed:
 * exact length, then the canonical header, then `chunkCount`.
 */
function isTrustedContainer(
  bytes: Uint8Array,
  hint: ContainerReadHint
): boolean {
  if (bytes.byteLength !== hint.size) return false;

  let chunkCount: number;
  try {
    chunkCount = parseContainerHeader(bytes.subarray(0, HEADER_SIZE)).chunkCount;
  } catch {
    return false;
  }

  return chunkCount === hint.chunkCount;
}

/**
 * ONE ordinary GET (NO `Range` header) of the whole container from ONE
 * gateway. Same endpoint as the range attempt, minus the Range header.
 * `Content-Length` is used for EARLY rejection only — never as truth.
 */
async function fetchFullContainer(
  gateway: string,
  txId: StoragePointer,
  hint: ContainerReadHint,
  signal: AbortSignal
): Promise<Uint8Array | null> {
  let res: Response;
  try {
    res = await fetch(buildRangeUrl(gateway, txId), {
      cache: "no-store",
      signal,
    });
  } catch {
    return null;
  }

  if (res.status !== 200) return null;

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) return null;

  const declared = res.headers.get("content-length");
  if (declared !== null && declared !== undefined) {
    const n = Number(declared);
    if (Number.isSafeInteger(n) && n > CONTAINER_FULL_FALLBACK_MAX_BYTES) {
      return null;
    }
    if (Number.isSafeInteger(n) && n !== hint.size) return null;
  }

  const bytes = await readBodyBounded(res, CONTAINER_FULL_FALLBACK_MAX_BYTES);
  if (!bytes) return null;

  if (!isTrustedContainer(bytes, hint)) {
    bytes.fill(0);
    return null;
  }

  return bytes;
}

/** Tries every gateway in the SAME order, under the shared signal. */
async function fetchContainerAcrossGateways(
  txId: StoragePointer,
  hint: ContainerReadHint,
  signal: AbortSignal
): Promise<Uint8Array | null> {
  for (const gateway of GATEWAYS) {
    if (signal.aborted) return null;
    const bytes = await fetchFullContainer(gateway, txId, hint, signal);
    if (bytes) return bytes;
  }
  return null;
}

interface ContainerFetchEntry {
  readonly controller: AbortController;
  promise: Promise<Uint8Array | null>;
  consumers: number;
  settled: boolean;
}

/**
 * At most this many container GETs may be pending at once; at most ONE
 * settled container is retained. Together these strictly bound the
 * fallback's retained memory (<= 2 x 20 MiB in flight + 20 MiB settled).
 */
const MAX_IN_FLIGHT_CONTAINER_FETCHES = 2;

const inFlightContainerFetches = new Map<string, ContainerFetchEntry>();
let settledContainer: { key: string; bytes: Uint8Array } | null = null;

/**
 * Returns the validated whole container for `key`, joining an existing
 * fetch when one is in flight (single flight), else starting one.
 *
 * The returned buffer is OWNED by the cache and MUST NOT be mutated by
 * the caller — `sliceContainerWindow` copies out of it.
 */
async function getFullContainer(
  txId: StoragePointer,
  hint: ContainerReadHint,
  signal: AbortSignal
): Promise<Uint8Array | null> {
  const key = `${txId}:${hint.size}:${hint.chunkCount}`;

  if (settledContainer && settledContainer.key === key) {
    return settledContainer.bytes;
  }

  let entry = inFlightContainerFetches.get(key);
  if (!entry) {
    if (inFlightContainerFetches.size >= MAX_IN_FLIGHT_CONTAINER_FETCHES) {
      return null;
    }
    const controller = new AbortController();
    const created: ContainerFetchEntry = {
      controller,
      promise: Promise.resolve(null),
      consumers: 0,
      settled: false,
    };
    created.promise = fetchContainerAcrossGateways(
      txId,
      hint,
      controller.signal
    ).finally(() => {
      created.settled = true;
      inFlightContainerFetches.delete(key);
    });
    inFlightContainerFetches.set(key, created);
    entry = created;
  }

  const joined: ContainerFetchEntry = entry;
  let released = false;
  const release = (aborted: boolean): void => {
    if (released) return;
    released = true;
    joined.consumers -= 1;
    if (aborted && joined.consumers <= 0 && !joined.settled) {
      // No live consumer needs this fetch any more.
      joined.controller.abort();
    }
  };
  const onAbort = (): void => release(true);

  joined.consumers += 1;
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const bytes = await joined.promise;

    // A late response must never satisfy an aborted consumer.
    if (signal.aborted) return null;
    if (!bytes) return null;

    if (settledContainer && settledContainer.key !== key) {
      settledContainer.bytes.fill(0);
      settledContainer = null;
    }
    settledContainer = { key, bytes };
    return bytes;
  } finally {
    signal.removeEventListener("abort", onAbort);
    release(false);
  }
}

/**
 * Copies `length` bytes at `offset` OUT of the cached container.
 *
 * A COPY is mandatory: `chunkLoader` zeroizes the buffer it receives, so
 * handing out a view of the shared cache would corrupt it.
 */
function sliceContainerWindow(
  container: Uint8Array,
  offset: number,
  length: number
): Uint8Array<ArrayBuffer> | null {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length <= 0 ||
    offset + length > container.byteLength
  ) {
    return null;
  }
  return new Uint8Array(container.subarray(offset, offset + length));
}

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
    length: number,
    containerHint?: ContainerReadHint
  ): Promise<Uint8Array<ArrayBuffer>> {
    assertStoragePointer(txId);

    const window = assertRangeWindow(offset, length);

    /**
     * ONE deadline for the WHOLE operation — request headers,
     * redirects and the full response body — shared by every gateway
     * attempt AND by the optional full-container fallback below.
     * `fetch()` follows redirects and the body streams under the same
     * signal, so a single timer bounds the entire lifetime; the budget
     * is NEVER reset per attempt and is NEVER extended when the
     * operation switches to the fallback, so elapsed Range time is
     * subtracted automatically.
     *
     * The budget is WINDOW-derived for a plain range read — unchanged
     * (<= 24 s). When a trusted, in-ceiling container hint is present it
     * is CONTAINER-aware instead (`containerRangeDeadlineMs`, <= 29 s),
     * because the hint declares the totals of the container the fallback
     * would download. Both are strictly inside the caller's 30 s
     * absolute bound. A structurally invalid hint is ignored here exactly
     * as it is at the fallback gate, so the two can never disagree.
     */
    const controller = new AbortController();

    const deadlineMs =
      isContainerReadHint(containerHint) &&
      containerHint.size <= CONTAINER_FULL_FALLBACK_MAX_BYTES
        ? containerRangeDeadlineMs(window.length, containerHint.size)
        : rangeDownloadDeadlineMs(window.length);

    const deadline = setTimeout(
      () => controller.abort(),
      deadlineMs
    );

    /**
     * Tracks whether ANY gateway attempt failed at the transport layer
     * (a `fetch` rejection that is NOT the shared-deadline abort), so an
     * exhausted retry can distinguish "reachable but rejected the
     * window" from "the request could not complete". This is a
     * classification aid only — it never changes gateway order,
     * retries, or the deadline.
     */
    let sawNetworkFailure = false;

    /**
     * The set of rejection reasons observed across ALL gateway attempts
     * (each `continue` branch below records exactly one). Diagnostic
     * only: it never influences control flow, gateway order, retries or
     * the deadline. Preserved as a SET so a mixed-reason exhaustion
     * reports every reason actually seen, not just the last one. Never
     * carries a URL, pointer, byte or any other sensitive value.
     */
    const rejectionReasons =
      new Set<StorageRangeRejectionReason>();

    /**
     * The NUMERIC HTTP statuses of responses rejected by the status
     * gate, across ALL gateway attempts. Diagnostic only: it never
     * influences control flow, gateway order, retries or the deadline.
     * Preserved as a SET so a mixed exhaustion reports every distinct
     * status actually seen, not just the last one. Plain integers only
     * — never a URL, header, pointer, body or byte.
     */
    const rejectionStatuses =
      new Set<number>();

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
          if (res.status !== 206) {
            rejectionReasons.add("status-not-206");
            rejectionStatuses.add(res.status);
            continue;
          }

          const contentType = res.headers.get("content-type") ?? "";
          if (contentType.includes("text/html")) {
            rejectionReasons.add("html-response");
            continue;
          }

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
            rejectionReasons.add("content-range-mismatch");
            continue;
          }

          const buffer = await res.arrayBuffer();

          // Exact-length contract: a short or long body is a
          // gateway/protocol failure, never a partial success.
          if (buffer.byteLength !== window.length) {
            rejectionReasons.add(
              buffer.byteLength < window.length
                ? "body-short"
                : "body-long"
            );
            continue;
          }

          return new Uint8Array(buffer);
        } catch (cause) {
          if (import.meta.env.DEV) {
            console.warn(`[executor-hot] gateway range failed: ${gateway}`, cause);
          }

          // The shared deadline fired — no later attempt can succeed.
          if (controller.signal.aborted) break;

          // A transport-level rejection (network/TLS/CORS/parse).
          sawNetworkFailure = true;
        }
      }

      /**
       * BOUNDED FULL-CONTAINER FALLBACK (Phase F3.3) — see the block above
       * `executorStorage`. It runs INSIDE this `try`, so it shares the ONE
       * deadline/controller that already governs this operation: the timer
       * is never reset, and an abort during the fetch aborts it too.
       *
       * Eligibility is deliberately narrow: every gateway was rejected by
       * the STATUS gate (exactly `status-not-206` — the very condition that
       * produces `PREVIEW_RANGE_STATUS_REJECTED`), no transport failure was
       * observed, and the container is known (trusted hint) to be within
       * the 20 MiB ceiling. Anything else keeps the pure fail-closed path.
       */
      if (
        !controller.signal.aborted &&
        !sawNetworkFailure &&
        rejectionReasons.size === 1 &&
        rejectionReasons.has("status-not-206") &&
        isContainerReadHint(containerHint) &&
        containerHint.size <= CONTAINER_FULL_FALLBACK_MAX_BYTES
      ) {
        const full = await getFullContainer(
          txId,
          containerHint,
          controller.signal
        );

        if (full) {
          const windowBytes = sliceContainerWindow(
            full,
            window.offset,
            window.length
          );
          if (windowBytes) return windowBytes;
        }

        // Any fallback problem falls through to the ORIGINAL typed error
        // below — the primary failure cause is never masked.
      }
    } finally {
      clearTimeout(deadline);
    }

    // A deadline abort is a distinct, actionable terminal outcome; any
    // other exhaustion is the canonical range-read failure.
    if (controller.signal.aborted) {
      throw new StorageRangeError("range-timeout");
    }

    // No gateway delivered an acceptable window. If at least one
    // attempt failed at the transport layer AND no gateway produced a
    // usable 206, the request could not be completed — otherwise every
    // reachable gateway actively rejected the window.
    if (sawNetworkFailure) {
      throw new StorageRangeError("range-network");
    }

    // Every reachable gateway REJECTED the window. Report the full,
    // normalised, non-sensitive sets of reasons AND numeric HTTP
    // statuses that were observed.
    throw new StorageRangeError(
      "range-rejected",
      [...rejectionReasons],
      [...rejectionStatuses],
    );
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