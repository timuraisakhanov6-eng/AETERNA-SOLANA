import type {
  RuntimeChunkRecord,
} from "./runtimeTypes";

export interface RuntimeStorage {

  /**
   * Opens Runtime storage for one capsule session.
   */
  open(
    capsuleId: string,
  ): Promise<void>;

  /**
   * Stores one encrypted chunk ciphertext
   * inside the Runtime Layer.
   */
  store(
    record: RuntimeChunkRecord,
  ): Promise<void>;

  /**
   * Reads one encrypted chunk ciphertext.
   */
  read(
    chunkId: string,
  ): Promise<RuntimeChunkRecord>;

  /**
   * Removes one encrypted chunk ciphertext
   * after successful upload.
   */
  remove(
    chunkId: string,
  ): Promise<void>;

  /**
   * Stores a temporary encrypted Vault inside the Runtime Layer.
   */
  storeVault(
    capsuleId: string,
    ciphertext: Uint8Array,
  ): Promise<void>;

  /**
   * Reads a temporary encrypted Vault from the Runtime Layer.
   */
  readVault(
    capsuleId: string,
  ): Promise<Uint8Array>;

  /**
   * Removes a temporary encrypted Vault from the Runtime Layer.
   */
  removeVault(
    capsuleId: string,
  ): Promise<void>;

  /**
   * Destroys the entire Runtime session.
   */
  clear(): Promise<void>;

}
