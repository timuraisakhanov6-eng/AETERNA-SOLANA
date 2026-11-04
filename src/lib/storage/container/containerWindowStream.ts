/**
 * R9-A87.5 — BOUNDED WINDOWED CONTAINER READING.
 *
 * A gateway that IGNORES `Range` answers a range request with `200` and the
 * WHOLE container. The previous recovery path buffered that object (capped at
 * 20 MiB, ~2x transient), so a capsule larger than the cap could not be read
 * at all — every media item in it failed closed.
 *
 * This module replaces "buffer the object, then slice" with "stream the
 * object, discard the prefix, keep only the window":
 *
 *   - memory is bounded by the REQUESTED WINDOW, never by the container;
 *   - one forward stream per container is reused across ascending windows,
 *     so a sequential read transfers ~1.0x the container instead of the
 *     ~6.2x that one GET per window would cost;
 *   - a window BEHIND the stream cursor is served by a single bounded
 *     restart, never by returning stale bytes;
 *   - the container header is validated from the first 64 streamed bytes
 *     before any window is released;
 *   - cancellation, idle timeout and disposal release the reader and the
 *     connection.
 *
 * It deliberately does NOT:
 *   - accept a 200 as a valid RANGE response (the strict 206 path is
 *     untouched; this module is reached only after every gateway rejected
 *     the window with `status-not-206`);
 *   - buffer `arrayBuffer()` of the object, build a whole-container Blob, or
 *     concatenate parts;
 *   - raise `CONTAINER_FULL_FALLBACK_MAX_BYTES`;
 *   - decrypt anything. Every returned byte is still authenticated by
 *     AES-GCM in `chunkLoader`, which zeroises the buffer it receives, so
 *     this module hands out OWNED buffers and never reuses them.
 */

import {
  HEADER_SIZE,
  parseContainerHeader,
} from "@/lib/storage/container/containerLayout";

/** Minimum throughput the deadline assumes (mirrors the range path). */
const MIN_BYTES_PER_SEC = 512 * 1024;

/** No bytes for this long means the stream is dead: abort, fail closed. */
export const WINDOW_STREAM_IDLE_MS = 10_000;

/** FINITE overall ceiling for one streamed window. */
export const WINDOW_STREAM_CEILING_MS = 120_000;

/** An unused session is closed after this long. */
export const WINDOW_STREAM_IDLE_SESSION_MS = 30_000;

/** Fixed allowance for HTTP setup, redirects and the first byte. */
const WINDOW_STREAM_SETUP_MS = 1_500;

/**
 * Progress-aware deadline for a streamed window.
 *
 * Unlike the old whole-object budget, the bytes that must actually traverse
 * the wire are `offset + length` (the prefix is streamed and discarded), so a
 * high-offset window legitimately needs more time than a low-offset one. The
 * result is clamped to a finite ceiling; it never becomes unbounded.
 */
export function windowStreamDeadlineMs(
  offset: number,
  length: number,
  containerSize: number,
): number {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    !Number.isSafeInteger(containerSize) ||
    offset < 0 ||
    length <= 0 ||
    containerSize <= 0
  ) {
    return WINDOW_STREAM_CEILING_MS;
  }

  const bytesNeeded = Math.min(offset + length, containerSize);
  const transferMs = Math.ceil((bytesNeeded / MIN_BYTES_PER_SEC) * 1000);

  return Math.min(
    WINDOW_STREAM_CEILING_MS,
    Math.max(
      WINDOW_STREAM_SETUP_MS * 2,
      transferMs + WINDOW_STREAM_SETUP_MS,
    ),
  );
}

export interface ContainerStreamHint {
  readonly size: number;
  readonly chunkCount: number;
}

export interface ContainerWindowRequest {
  /** Already-built object URL (`<gateway>/tx/<txId>/data`). */
  readonly url: string;
  /** Container identity; streams are keyed by it. */
  readonly txId: string;
  readonly offset: number;
  readonly length: number;
  readonly hint: ContainerStreamHint;
  readonly signal: AbortSignal;
  /** Test seam. */
  readonly fetchImpl?: typeof fetch;
  /** Test seam. */
  readonly now?: () => number;
}

interface StreamSession {
  readonly key: string;
  readonly url: string;
  readonly hint: ContainerStreamHint;
  readonly controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  /** Bytes already fetched but not yet consumed (a view, never a copy). */
  pending: Uint8Array | null;
  /** Logical position: bytes consumed from the object. */
  cursor: number;
  /** Header accumulator, filled as bytes 0..63 are consumed. */
  header: Uint8Array;
  headerFilled: number;
  headerValidated: boolean;
  closed: boolean;
  /**
   * R9-A87.7 (F2) - windows currently being filled from this stream.
   *
   * The idle timer may only close a stream that is NOT being read. A slow but
   * healthy high-offset window legitimately needs up to the 120 s ceiling, so
   * closing it after 30 s of "idle" would abort live work.
   */
  busy: number;
  lastUsed: number;
  /** Per-session idle close timer (armed on create and on every use). */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Removes the caller-signal listener. */
  detach: () => void;
}

const sessions = new Map<string, StreamSession>();
/** Per-key serialisation: one forward cursor, one reader, one writer. */
const chains = new Map<string, Promise<unknown>>();

function sessionKey(
  txId: string,
  hint: ContainerStreamHint,
): string {
  return `${txId}:${hint.size}:${hint.chunkCount}`;
}

function closeSession(session: StreamSession): void {
  if (session.closed) return;
  session.closed = true;
  session.pending = null;

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  const reader = session.reader;
  session.reader = null;

  if (reader) {
    // Safari can reject a cancel on an already-errored stream; the abort
    // below is the hard teardown either way.
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      /* best-effort */
    }
    try {
      reader.releaseLock();
    } catch {
      /* best-effort */
    }
  }

  try {
    session.controller.abort();
  } catch {
    /* best-effort */
  }

  session.detach();

  /**
   * Only remove the entry if it still IS this session: a restarted stream
   * reuses the same key, and a stale close must never evict its successor.
   */
  if (sessions.get(session.key) === session) {
    sessions.delete(session.key);
  }
}

/**
 * Records use and (re)arms the session's idle close timer.
 *
 * R9-A87.7 (F2) — cleanup used to be OPPORTUNISTIC: `sweepIdle` only ran when
 * another window read happened, so a closed capsule could retain its reader,
 * controller and HTTP response indefinitely. The timer makes the documented
 * 30 s bound real, independently of later traffic.
 */
function armIdle(session: StreamSession): void {
  if (session.closed) return;

  /**
   * A stream with work in flight is not idle, however long that work takes.
   * Closing it here would abort a legitimate high-offset window that the
   * reader's own 120 s ceiling still allows.
   */
  if (session.busy > 0) return;

  if (session.idleTimer) clearTimeout(session.idleTimer);

  const timer = setTimeout(() => {
    closeSession(session);
  }, WINDOW_STREAM_IDLE_SESSION_MS);

  // Never hold a Node/vitest event loop open because of a media stream.
  const maybeUnref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof maybeUnref === "function") maybeUnref.call(timer);

  session.idleTimer = timer;
}

function touch(session: StreamSession, now: number): void {
  session.lastUsed = now;
  armIdle(session);
}

/** Marks a window as in flight: the idle timer must not fire meanwhile. */
function beginUse(session: StreamSession): void {
  session.busy += 1;

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

/** Releases one in-flight window and re-arms the idle timer if none remain. */
function endUse(session: StreamSession): void {
  session.busy = Math.max(0, session.busy - 1);
  armIdle(session);
}

/**
 * Closes every stream belonging to ONE container (R9-A87.7 F2).
 *
 * Capsule-scoped teardown: the caller passes the container txId it already
 * knows, so a different capsule's live stream can never be collateral damage.
 */
export function disposeContainerWindowStreamsFor(txId: string): void {
  if (typeof txId !== "string" || txId.length === 0) return;

  const prefix = `${txId}:`;

  for (const session of [...sessions.values()]) {
    if (session.key.startsWith(prefix)) closeSession(session);
  }
}

/**
 * R9-A87.7 (F2) - CAPSULE-SCOPED OWNERSHIP COUNTER.
 *
 * A container stream is owned by the CAPSULE that opened it, never by an
 * individual media reader: the same container legitimately serves a video, an
 * audio track and a download, so disposing one of them must not tear the shared
 * forward stream out from under another.
 *
 * The returned release function is idempotent, and only the LAST owner closes
 * the stream. The close is deferred by one tick so a remount in the same tick
 * (route transition, React StrictMode) re-retains the container before its
 * stream is destroyed.
 */
const owners = new Map<string, number>();

export function retainContainerWindowStream(txId: string): () => void {
  if (typeof txId !== "string" || txId.length === 0) return () => undefined;

  owners.set(txId, (owners.get(txId) ?? 0) + 1);

  let released = false;

  return () => {
    if (released) return;
    released = true;

    const remaining = (owners.get(txId) ?? 0) - 1;

    if (remaining > 0) {
      owners.set(txId, remaining);
      return;
    }

    owners.delete(txId);

    const timer = setTimeout(() => {
      // Re-retained in the same tick: the capsule never actually went away.
      if ((owners.get(txId) ?? 0) > 0) return;
      disposeContainerWindowStreamsFor(txId);
    }, 0);

    const maybeUnref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof maybeUnref === "function") maybeUnref.call(timer);
  };
}

function sweepIdle(now: number): void {
  for (const session of [...sessions.values()]) {

    /**
     * R9-A87.9 (R1) - A SESSION WITH A WINDOW IN FLIGHT IS NOT IDLE.
     *
     * `lastUsed` is refreshed only when a read starts and when it completes,
     * never while bytes are moving, so a legitimate 30-120 s window looks
     * "old" to a sweep triggered by any other request. This sweep runs BEFORE
     * the per-key queue is consulted, so even a request that merely QUEUES for
     * the same container reaches this point while the first read is still
     * running. Closing here aborted live work (R9-A87.8 finding R1) and
     * mis-classified it as a gateway rejection.
     *
     * The rule is now identical to `armIdle`: busy sessions are never swept.
     */
    if (session.busy > 0) continue;

    if (now - session.lastUsed > WINDOW_STREAM_IDLE_SESSION_MS) {
      closeSession(session);
    }
  }
}

/**
 * Closes every stream. Used by tests and by capsule teardown.
 *
 * R9-A87.9 (R2B) - the per-key chains are deliberately NOT cleared.
 *
 * Clearing them dropped the serialisation this module guarantees (one forward
 * cursor per container): a request arriving after the disposal would no longer
 * queue behind an operation that was still unwinding, so two operations could
 * open two sessions for the same key and advance independent cursors. Chains
 * are per-key promises, not resources; they are now removed one by one, by
 * identity, when their own work has settled (see `readContainerWindow`).
 */
export function disposeContainerWindowStreams(): void {
  for (const session of [...sessions.values()]) {
    closeSession(session);
  }
}
function readWithIdle(
  session: StreamSession,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const reader = session.reader;
  if (!reader) {
    return Promise.reject(new Error("[AETERNA] Container stream is closed"));
  }

  return new Promise<ReadableStreamReadResult<Uint8Array>>(
    (resolve, reject) => {

      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Kill the connection: a pending read must never outlive the window.
        try {
          session.controller.abort();
        } catch {
          /* best-effort */
        }
        reject(new Error("[AETERNA] Container stream idle timeout"));
      }, WINDOW_STREAM_IDLE_MS);

      reader.read().then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (cause: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(cause);
        },
      );
    },
  );
}

/** Next non-empty chunk, or null at end of object. */
async function nextChunk(
  session: StreamSession,
): Promise<Uint8Array | null> {

  for (;;) {

    if (session.pending) {
      const pending = session.pending;
      session.pending = null;
      if (pending.byteLength > 0) return pending;
    }

    const step = await readWithIdle(session);
    if (step.done) return null;

    const value = step.value;
    if (!value || value.byteLength === 0) continue;

    return value;
  }
}

/** Copies bytes 0..63 into the header accumulator as they stream past. */
function captureHeader(
  session: StreamSession,
  chunk: Uint8Array,
): void {
  if (session.headerValidated || session.cursor >= HEADER_SIZE) return;

  const take = Math.min(
    HEADER_SIZE - session.cursor,
    chunk.byteLength,
  );

  session.header.set(chunk.subarray(0, take), session.cursor);
  session.headerFilled = Math.max(
    session.headerFilled,
    session.cursor + take,
  );
}

/**
 * Decides the container-header gate once bytes 0..63 have been consumed.
 * Returns false on any disagreement — the caller must fail closed.
 */
function maybeValidateHeader(session: StreamSession): boolean {
  if (session.headerValidated) return true;
  if (session.cursor < HEADER_SIZE) return true; // not decidable yet
  if (session.headerFilled < HEADER_SIZE) return false;

  try {
    const parsed = parseContainerHeader(session.header);
    if (parsed.chunkCount !== session.hint.chunkCount) return false;
    session.headerValidated = true;
    return true;
  } catch {
    return false;
  }
}

/** Consumes `count` bytes and discards them. */
async function discard(
  session: StreamSession,
  count: number,
): Promise<boolean> {

  let need = count;

  while (need > 0) {

    const chunk = await nextChunk(session);

    if (!chunk) return false;

    captureHeader(session, chunk);

    const take = Math.min(need, chunk.byteLength);
    session.cursor += take;
    need -= take;

    if (take < chunk.byteLength) {
      session.pending = chunk.subarray(take);
    }

    if (!maybeValidateHeader(session)) return false;
  }

  return maybeValidateHeader(session);
}

/** Consumes `count` bytes into `out`, starting at `start`. One copy. */
async function readInto(
  session: StreamSession,
  out: Uint8Array,
  start: number,
  count: number,
): Promise<boolean> {

  let need = count;
  let position = start;

  while (need > 0) {

    const chunk = await nextChunk(session);

    if (!chunk) return false;

    captureHeader(session, chunk);

    const take = Math.min(need, chunk.byteLength);
    out.set(chunk.subarray(0, take), position);

    position += take;
    need -= take;
    session.cursor += take;

    if (take < chunk.byteLength) {
      session.pending = chunk.subarray(take);
    }

    if (!maybeValidateHeader(session)) return false;
  }

  return maybeValidateHeader(session);
}

/**
 * Opens one ordinary GET — NO `Range` header — and validates the envelope.
 * Returns null (fail closed) for anything that is not a plain, non-HTML,
 * correctly-sized object.
 */
async function openSession(
  request: ContainerWindowRequest,
  key: string,
  now: number,
): Promise<StreamSession | null> {

  const fetchImpl = request.fetchImpl ?? fetch;

  if (request.signal.aborted) return null;

  const controller = new AbortController();

  const onAbort = (): void => {
    try {
      controller.abort();
    } catch {
      /* best-effort */
    }
  };

  request.signal.addEventListener("abort", onAbort, { once: true });

  const abortAndDetach = (): null => {
    request.signal.removeEventListener("abort", onAbort);
    try {
      controller.abort();
    } catch {
      /* best-effort */
    }
    return null;
  };

  let res: Response;
  try {
    res = await fetchImpl(request.url, {
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    return abortAndDetach();
  }

  // 200 is the ONLY acceptable answer here: this path exists precisely because
  // `Range` was ignored. A 206 without a Range header is not a shape this code
  // asked for, and is rejected rather than guessed at.
  if (res.status !== 200) return abortAndDetach();

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) return abortAndDetach();

  // `Content-Length` is authoritative when present: the object MUST be the
  // container the digest-verified layout describes.
  const declared = res.headers.get("content-length");
  if (declared !== null && declared !== undefined) {
    const n = Number(declared);
    if (!Number.isSafeInteger(n) || n !== request.hint.size) {
      return abortAndDetach();
    }
  }

  const body = res.body;
  if (!body || typeof body.getReader !== "function") return abortAndDetach();

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    return abortAndDetach();
  }

  return {
    key,
    url: request.url,
    hint: request.hint,
    controller,
    reader,
    pending: null,
    cursor: 0,
    header: new Uint8Array(HEADER_SIZE),
    headerFilled: 0,
    headerValidated: false,
    closed: false,
    busy: 0,
    lastUsed: now,
    idleTimer: null,
    detach: () => request.signal.removeEventListener("abort", onAbort),
  };
}

/**
 * Serves `[offset, offset + length)` from a session positioned at or before
 * `offset`. Every failure path zeroises the partial buffer.
 */
async function serveWindow(
  session: StreamSession,
  offset: number,
  length: number,
): Promise<Uint8Array<ArrayBuffer> | null> {

  if (offset < session.cursor) return null;

  beginUse(session);

  let out: Uint8Array<ArrayBuffer> | null = null;

  try {

    const gap = offset - session.cursor;
    if (gap > 0 && !(await discard(session, gap))) return null;

    out = new Uint8Array(length);

    const ok = await readInto(session, out, 0, length);

    /**
     * A window that never reaches byte 64 cannot have its container header
     * validated, so it is refused rather than served unvalidated. Real media
     * windows always start at the header offset (64) or later.
     *
     * R9-A87.7 (F2) - a session disposed WHILE this window was being filled
     * must never hand its bytes to a consumer that no longer owns them.
     */
    if (!ok || !session.headerValidated || session.closed) {
      out.fill(0);
      return null;
    }

    return out;

  } catch (cause) {

    // No partial window may survive an unexpected reader failure.
    if (out) out.fill(0);
    throw cause;

  } finally {

    endUse(session);

  }
}

/** Number of live streams. Test seam. */
export function activeContainerStreams(): number {
  return sessions.size;
}

/**
 * Number of live per-container request chains. Test seam (R9-A87.9 R3).
 * A settled chain is removed by its own cleanup, so this returns to 0 once
 * every request has completed, failed or been cancelled.
 */
export function activeContainerChains(): number {
  return chains.size;
}
/**
 * Reads `[offset, offset + length)` from the container by streaming it.
 *
 * Returns null — never partial, never stale, never unvalidated — when the
 * request cannot be served safely. The caller converts that into its existing
 * typed failure, so fail-closed semantics are unchanged.
 *
 * Concurrency: requests for the same container are serialised through one
 * promise chain, so the forward cursor is never advanced by two readers at
 * once. Distinct containers get distinct chains and distinct streams.
 */
export async function readContainerWindow(
  request: ContainerWindowRequest,
): Promise<Uint8Array<ArrayBuffer> | null> {

  if (
    !Number.isSafeInteger(request.offset) ||
    !Number.isSafeInteger(request.length) ||
    request.offset < 0 ||
    request.length <= 0 ||
    request.offset + request.length > request.hint.size
  ) {
    return null;
  }

  if (request.signal.aborted) return null;

  const now = request.now ?? Date.now;
  sweepIdle(now());

  const key = sessionKey(request.txId, request.hint);

  /**
   * R9-A87.7 (F3) - REQUEST-SCOPED ABORT LINK.
   *
   * The caller's signal must interrupt the read that is in flight, but it must
   * NOT stay wired to a REUSED session: the session outlives the request, so a
   * late abort from a consumer that has already been served would otherwise
   * tear down a stream another consumer is still using. The link exists for
   * exactly one request and is removed in `run`'s `finally`.
   */
  let linkedSession: StreamSession | null = null;
  let linkedDetach: (() => void) | null = null;

  const linkRequestAbort = (session: StreamSession): void => {

    if (linkedSession === session) return;

    if (linkedDetach) linkedDetach();

    const onAbort = (): void => {
      /**
       * R9-A87.7 (F1/F3) - an aborted request kills the transport AND the
       * session. Leaving the entry behind with an errored reader is exactly
       * the poison the review found: the next read would reuse it and fail
       * once more before restarting. Closing here makes the next read open a
       * fresh, working stream.
       */
      closeSession(session);
    };

    request.signal.addEventListener("abort", onAbort, { once: true });

    linkedSession = session;
    linkedDetach = () =>
      request.signal.removeEventListener("abort", onAbort);
  };

  const unlinkRequestAbort = (): void => {
    if (linkedDetach) linkedDetach();
    linkedDetach = null;
    linkedSession = null;
  };

  /**
   * R9-A87.9 (R2A) - THE EXACT SESSION THIS OPERATION HOLDS.
   *
   * `run`'s failure path used to close whatever `sessions.get(key)` returned.
   * That is only equivalent while the key cannot be re-registered underneath
   * an in-flight operation; once it can (a disposal racing a new request), the
   * failing operation would close a healthy REPLACEMENT it never held. The
   * held reference makes the identity explicit and is also what `finally`
   * detaches.
   */
  let heldSession: StreamSession | null = null;

  const runInner = async (): Promise<Uint8Array<ArrayBuffer> | null> => {

    if (request.signal.aborted) return null;

    const ensure = async (): Promise<StreamSession | null> => {

      const existing = sessions.get(key);

      if (
        existing &&
        !existing.closed &&
        existing.url === request.url
      ) {
        return existing;
      }

      if (existing) closeSession(existing);

      const opened = await openSession(request, key, now());
      if (!opened) return null;

      sessions.set(key, opened);
      touch(opened, now());
      return opened;
    };

    let session = await ensure();
    if (!session) return null;

    heldSession = session;

    touch(session, now());
    linkRequestAbort(session);

    if (request.offset >= session.cursor) {
      const bytes = await serveWindow(
        session,
        request.offset,
        request.length,
      );
      if (bytes) {
        /**
         * R9-A87.7 - a window that finished AFTER its consumer cancelled is
         * never returned: the bytes are data the caller has already rejected,
         * and the transport that produced them is dead.
         */
        if (request.signal.aborted || session.closed) {
          bytes.fill(0);
          closeSession(session);
          return null;
        }
        touch(session, now());
        return bytes;
      }
      closeSession(session);
      return null;
    }

    /**
     * BACKWARD request (behind the cursor). A forward stream cannot rewind,
     * and replaying a retained buffer would risk handing out memory the
     * consumer has already zeroised. The only correct bounded answer is ONE
     * restart — never stale bytes.
     */
    closeSession(session);

    session = await ensure();
    if (!session) return null;

    heldSession = session;

    linkRequestAbort(session);

    const bytes = await serveWindow(
      session,
      request.offset,
      request.length,
    );

    if (bytes) {
      if (request.signal.aborted || session.closed) {
        bytes.fill(0);
        closeSession(session);
        return null;
      }
      touch(session, now());
      return bytes;
    }

    closeSession(session);
    return null;
  };

  /**
   * R9-A87.7 (F1) — ERROR BOUNDARY.
   *
   * `readWithIdle` rejects on idle timeout, abort and any `reader.read()`
   * error. Leaving that rejection unhandled had two consequences: it escaped
   * `readContainerWindow` (losing the typed storage diagnostic, because
   * `executorStorage` would then fall through to a generic sealed error) and
   * it left a POISONED session in the registry that every later read would
   * reuse and fail on.
   *
   * The boundary closes the affected session (cancel reader, release lock,
   * abort controller, delete the registry entry) and returns the module's
   * normal `null` failure, which the caller already maps to
   * `StorageRangeError`.
   */
  const run = async (): Promise<Uint8Array<ArrayBuffer> | null> => {
    try {
      return await runInner();
    } catch {
      /**
       * R9-A87.9 (R2A) - close the session THIS operation held, never whatever
       * happens to be registered under the key. `closeSession` is idempotent
       * and removes the registry entry only if it still refers to that exact
       * object, so a healthy replacement is untouchable from here.
       */
      if (heldSession) closeSession(heldSession);
      return null;
    } finally {
      /**
       * The request is over: neither its signal nor the listener installed by
       * `openSession` may keep authority over a session that later requests
       * will reuse.
       */
      unlinkRequestAbort();
      if (heldSession) heldSession.detach();
      heldSession = null;
    }
  };

  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);

  /**
   * R9-A87.9 (R3) - KEYED, IDENTITY-SAFE CHAIN CLEANUP.
   *
   * `run` never rejects (it converts every failure to `null`), so `settled` is
   * the last thing outstanding for this request. A newer request for the same
   * key replaces the entry before its own work starts; this cleanup therefore
   * deletes ONLY if the entry is still this very promise, so an older chain can
   * never remove its successor and ordering is preserved.
   */
  const settled = next.then(
    () => undefined,
    () => undefined,
  );

  chains.set(key, settled);

  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });

  return next;
}