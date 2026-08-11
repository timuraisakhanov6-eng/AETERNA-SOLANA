import type {
  RuntimeChunkRecord,
} from "./runtimeTypes";

export interface RuntimeStorage {

  /**
   * Opens Runtime storage for one capsule session.
   *
   * Runtime storage exists only while the capsule
   * is being prepared and sealed.
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
   *
   * MUST throw if the chunk does not exist.
   *
   * Runtime follows the Fail Closed principle.
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
   * Destroys the entire Runtime session.

     Removes every temporary Runtime record
     created during capsule preparation.
   *
   * Used when sealing completes or fails.
   */
  clear(): Promise<void>;

}