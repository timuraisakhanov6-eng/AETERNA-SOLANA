/**
 * =========================================================
 * AETERNA — Container writer (Stage 3)
 * =========================================================
 *
 * Turns the Stage 2 canonical layout into a Node-style `Readable`
 * whose bytes are exactly:
 *
 *   [ 64-byte HEADER ][ CHUNK 0 ][ CHUNK 1 ] ... [ CHUNK N-1 ]
 *
 * DATA SOURCE — the existing persisted Runtime chunks, read one at a
 * time through the canonical `RuntimeStorage.read(chunkId)` API. No
 * `PreparedCapsule`, no whole-payload object, and no whole-container
 * buffer is ever materialised.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 *  • does not decrypt
 *  • does not re-encrypt
 *  • does not compress
 *  • does not touch the Vault
 *  • does not perform any network / Irys call
 *  • does not emit an index
 *
 * BACKPRESSURE
 * ------------
 * Pull-based: the producer reads a Runtime chunk only when the stream
 * asks for more data. `push()` reporting backpressure stops the pump
 * until the next `_read()`, so at most ONE Runtime chunk buffer is live
 * in this module at any moment (plus whatever bounded buffering the
 * downstream consumer performs).
 *
 * FAIL-CLOSED
 * -----------
 * Missing chunk, wrong chunk length, malformed record, Runtime read
 * error, inconsistent layout, or a final byte count that does not equal
 * `layout.containerSize` all destroy the stream with an error. The
 * producer never falls back and never silently truncates.
 */

import { Readable } from "stream";

import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";

import type { ContainerLayout } from "./containerLayout";
import { HEADER_SIZE, serializeContainerHeader } from "./containerLayout";

function failClosed(reason: string): never {
  throw new Error(reason);
}

/**
 * Live instrumentation for the writer.
 *
 * These are measurements of THIS module only — never of the browser
 * process, and never presented as browser RSS.
 */
export interface ContainerWriterStats {
  /** Number of `RuntimeStorage.read()` calls issued. */
  readonly readChunkCalls: number;

  /** Bytes handed to the stream so far. */
  readonly emittedBytes: number;

  /** Highest number of Runtime chunk buffers held simultaneously. */
  readonly peakLiveChunkBuffers: number;

  /** Highest bytes held by this module in Runtime chunk buffers. */
  readonly peakLiveChunkBytes: number;

  /** True once the stream ended with an exact byte count. */
  readonly completed: boolean;
}

export interface ContainerWriter {
  /** Node-style Readable — the ChunkingUploader-compatible contract. */
  readonly readable: Readable;

  /** Snapshot of the writer's own counters. */
  stats(): ContainerWriterStats;

  /** Aborts the stream and releases the reader. */
  abort(reason?: string): void;
}

/**
 * Creates the container byte producer for `layout`.
 *
 * `layout` MUST come from `buildContainerLayout()` — the writer never
 * re-derives offsets or ordering.
 */
export function createContainerWriter(
  layout: ContainerLayout,
  runtime: RuntimeStorage
): ContainerWriter {
  if (!layout || typeof layout !== "object" || !Array.isArray(layout.entries)) {
    failClosed("[AETERNA] Invalid container layout");
  }
  if (!Number.isSafeInteger(layout.containerSize) || layout.containerSize < HEADER_SIZE) {
    failClosed("[AETERNA] Invalid container size");
  }
  if (layout.entries.length !== layout.chunkCount) {
    failClosed("[AETERNA] Container layout is inconsistent");
  }
  if (!runtime || typeof runtime.read !== "function") {
    failClosed("[AETERNA] Runtime storage is required");
  }

  const header = serializeContainerHeader(layout.chunkCount);

  let headerEmitted = false;
  let entryIndex = 0;
  let current: Uint8Array | null = null;
  let currentOffset = 0;
  let pumping = false;
  let finished = false;

  const counters = {
    readChunkCalls: 0,
    emittedBytes: 0,
    peakLiveChunkBuffers: 0,
    peakLiveChunkBytes: 0,
    completed: false,
  };

  const readable = new Readable({
    // Modest high-water mark: the writer is a pull producer, and the
    // downstream SDK does its own bounded buffering.
    highWaterMark: 64 * 1024,
    read(): void {
      void pump();
    },
  });

  function destroy(reason: string): void {
    if (finished) return;
    finished = true;
    readable.destroy(new Error(reason));
  }

  async function pump(): Promise<void> {
    if (pumping || finished) return;
    pumping = true;

    try {
      for (;;) {
        // ---- 1. canonical header, exactly once -------------------
        if (!headerEmitted) {
          headerEmitted = true;
          counters.emittedBytes += header.byteLength;
          if (!readable.push(header)) return;
          continue;
        }

        // ---- 2. finish emitting the current chunk ---------------
        if (current !== null && currentOffset < current.byteLength) {
          const remainder = current.subarray(currentOffset);
          currentOffset = current.byteLength;
          counters.emittedBytes += remainder.byteLength;
          if (!readable.push(remainder)) return;
          continue;
        }

        // Current chunk fully handed to the stream; release it.
        current = null;
        currentOffset = 0;

        // ---- 3. done? -------------------------------------------
        if (entryIndex >= layout.entries.length) {
          if (counters.emittedBytes !== layout.containerSize) {
            destroy("[AETERNA] Container stream byte count mismatch");
            return;
          }
          finished = true;
          counters.completed = true;
          readable.push(null);
          return;
        }

        // ---- 4. load the next Runtime chunk ---------------------
        const entry = layout.entries[entryIndex];
        if (!entry) {
          destroy("[AETERNA] Container layout is inconsistent");
          return;
        }

        counters.readChunkCalls += 1;

        let ciphertext: unknown;
        try {
          const record = await runtime.read(entry.chunkId);
          ciphertext = record ? record.ciphertext : undefined;
        } catch {
          destroy("[AETERNA] Container chunk read failed");
          return;
        }

        if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength === 0) {
          destroy("[AETERNA] Container chunk is missing");
          return;
        }

        if (ciphertext.byteLength !== entry.length) {
          destroy("[AETERNA] Container chunk length mismatch");
          return;
        }

        counters.peakLiveChunkBuffers = Math.max(
          counters.peakLiveChunkBuffers,
          1
        );
        counters.peakLiveChunkBytes = Math.max(
          counters.peakLiveChunkBytes,
          ciphertext.byteLength
        );

        current = ciphertext;
        currentOffset = 0;
        entryIndex += 1;
      }
    } catch {
      destroy("[AETERNA] Container writer failed");
    } finally {
      pumping = false;
    }
  }

  return Object.freeze({
    readable,
    stats(): ContainerWriterStats {
      return Object.freeze({
        readChunkCalls: counters.readChunkCalls,
        emittedBytes: counters.emittedBytes,
        peakLiveChunkBuffers: counters.peakLiveChunkBuffers,
        peakLiveChunkBytes: counters.peakLiveChunkBytes,
        completed: counters.completed,
      });
    },
    abort(reason?: string): void {
      destroy(reason ?? "[AETERNA] Container writer aborted");
    },
  });
}
