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

  /** Temporary encrypted chunk ciphertexts. Key: chunkId */
  private readonly chunks =
    new Map<
      string,
      RuntimeChunkRecord
    >();

  /** Temporary encrypted Vault ciphertext. */
  private vault:
    | Uint8Array
    | null = null;

  async open(
    _capsuleId: string,
  ): Promise<void> {

    // Intentionally no-op.
    // RuntimeStorage.open() must never clear Runtime state.

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

  async storeVault(
    _capsuleId: string,
    ciphertext: Uint8Array,
  ): Promise<void> {

    this.vault =
      ciphertext.slice();

  }

  async readVault(
    _capsuleId: string,
  ): Promise<Uint8Array> {

    if (!this.vault) {

      throw new Error(
        "[AETERNA] Runtime vault not found."
      );

    }

    return this.vault.slice();

  }

  async removeVault(
    _capsuleId: string,
  ): Promise<void> {

    if (this.vault) {

      this.vault.fill(0);

    }

    this.vault = null;

  }

  async clear(): Promise<void> {

    for (const record of this.chunks.values()) {

      record.ciphertext.fill(0);

    }

    this.chunks.clear();

    if (this.vault) {

      this.vault.fill(0);

    }

    this.vault = null;

  }

}
