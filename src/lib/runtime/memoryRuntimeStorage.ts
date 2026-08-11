import type {
  RuntimeStorage,
} from "./runtimeStorage";

import type {
  RuntimeChunkRecord,
} from "./runtimeTypes";

/**
 * In-memory Runtime implementation.
 *
 * Exists only during capsule preparation.
 *
 * This implementation is intended for development
 * and as the reference Runtime implementation.
 */
export class MemoryRuntimeStorage
  implements RuntimeStorage {

  /**
   * Temporary encrypted chunk ciphertexts.
   *
   * Key:
   *   chunkId
   */
  private readonly chunks =
    new Map<
      string,
      RuntimeChunkRecord
    >();

  async open(
    _capsuleId: string,
  ): Promise<void> {

    // Intentionally no-op.
    //
    // RuntimeStorage.open() must never clear Runtime state.
    // Cleanup is performed only via clear() or destroyRuntime().

  }

  async store(
    record: RuntimeChunkRecord,
  ): Promise<void> {

    this.chunks.set(
      record.chunkId,
      Object.freeze({

        ...record,

        ciphertext:
          record.ciphertext.slice(),

      }),
    );

  }

  async read(
    chunkId: string,
  ): Promise<RuntimeChunkRecord> {

    const record =
      this.chunks.get(
        chunkId,
      );

    if (!record) {
      throw new Error(
        "[AETERNA] Runtime chunk not found."
      );
    }

    return Object.freeze({

      ...record,

      ciphertext:
        record.ciphertext.slice(),

    });

  }

  async remove(
    chunkId: string,
  ): Promise<void> {

    const record =
      this.chunks.get(
        chunkId,
      );

    if (!record) {
      throw new Error(
        "[AETERNA] Runtime chunk not found."
      );
    }

    // Securely erase ciphertext before removal.
    record.ciphertext.fill(0);

    this.chunks.delete(
      chunkId,
    );

  }

  async clear(): Promise<void> {

    for (const record of this.chunks.values()) {

      record.ciphertext.fill(0);

    }

    this.chunks.clear();

  }

}