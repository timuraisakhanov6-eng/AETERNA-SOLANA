/**
 * AETERNA Runtime Layer
 *
 * Runtime objects are implementation-only.
 *
 * They are NEVER part of:
 *
 * - Ciphertext Authority
 * - Storage Authority
 * - Vault
 * - Manifest
 *
 * Runtime data is temporary and MUST NEVER
 * become part of the sealed protocol state.
 */

export interface RuntimeChunkRecord {

  /**
   * Canonical ciphertext identifier.
   */
  readonly chunkId: string;

  /**
   * Media item identifier.
   */
  readonly mediaId: string;

  /**
   * Chunk order inside the media item.
   */
  readonly chunkIndex: number;

  /**
   * Temporary encrypted chunk ciphertext.
   *
   * Exists only inside the Runtime Layer.
   *
   * MUST be removed immediately after
   * successful upload.
   */
  readonly ciphertext: Uint8Array;

}