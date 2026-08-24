import type {
  CapsuleItem,
  PreparedCapsule,
} from "@/types/capsule";

import type {
  RuntimeStorage,
} from "@/lib/runtime/runtimeStorage";

import {
  prepareMediaChunks,
} from "@/lib/capsule/prepareMediaChunks";

import {
  prepareEncryptedCapsule,
} from "@/lib/capsule/prepareEncryptedCapsule";

import {
  prepareVault,
} from "@/lib/capsule/prepareVault";

import {
  generateRecipientSecret,
} from "@/lib/capsule/generateRecipientSecret";

import {
  generateCreatorAuthority,
} from "@/lib/capsule/generateCreatorAuthority";

import {
  generateSaltBase,
} from "@/lib/crypto/generateSaltBase";

import {
  generateVaultKey,
} from "@/lib/crypto/generateVaultKey";

import {
  toVaultItems,
} from "@/lib/transform/toVaultItems";

import {
  createRuntime,
} from "@/lib/runtime/runtimeRegistry";

import {
  createLocalVaultPointer,
} from "@/lib/runtime/localVaultPointer";

const PREPARE_ERROR =
  new Error(
    "[AETERNA] Prepared capsule creation failed"
  );

/**
 * Single-shot PREPARED enforcement.
 *
 * A capsule identity may be cryptographically prepared exactly once per
 * page session. Any second preparation for the same capsuleId would
 * regenerate recipientSecret / creatorAuthority / saltBase and therefore
 * the vault key, ciphertext, chunk IDs and vaultSha256 — which the
 * canonical Ciphertext Authority Law forbids ("generated exactly once.
 * They cannot be regenerated without violating the Ciphertext Authority
 * Law"). The creator flow rotates capsuleId via resetCapsule() when a new
 * capsule is required, so a fresh capsule always carries a fresh id and is
 * not blocked by this set.
 */
const preparedIdentities =
  new Set<string>();

export async function preparePreparedCapsule(
  params: {

    capsuleId: string;

    items: CapsuleItem[];

    openAt: number;

    getMediaFile: (
      id: string
    ) => File | undefined;

  }
): Promise<PreparedCapsule> {

  try {

    const {
      capsuleId,
      items,
      openAt,
      getMediaFile,
    } = params;

    if (
      preparedIdentities.has(
        capsuleId
      )
    ) {

      // A PREPARED identity already exists for this capsuleId — fail
      // closed instead of silently replacing it.
      throw PREPARE_ERROR;

    }

    /*
     * Capability generation
     */

    const recipientSecret =
      generateRecipientSecret();

    const creatorAuthority =
      generateCreatorAuthority();

    const saltBase =
      generateSaltBase();

    /*
     * Shared vault key
     */

    const vaultKey =
      await generateVaultKey({

        capsuleId,

        secret:
          recipientSecret,

        saltBase,

        openAt,

      });

    /*
     * Runtime storage
     */

    const runtime: RuntimeStorage =
      await createRuntime(
        capsuleId
      );

    /*
     * Media preparation
     */

    const mediaResult =
      await prepareMediaChunks(

        capsuleId,

        items,

        getMediaFile,

        vaultKey,

        runtime

      );

     /*
      * Build canonical Vault items using the prepared
      * ChunkMetadata generated during Runtime preparation.
      */

    const vaultItems =
      await toVaultItems(

        items,

        getMediaFile,

        mediaResult.chunkMetadata,

      );

    /*
     * Serialize Vault V2
     */

    const vaultBytes =
      await prepareVault({

        capsuleId,

        createdAt:
          new Date().toISOString(),

        items:
          vaultItems,

      });

    /*
     * Encrypt Vault
     */

    const encrypted =
      await prepareEncryptedCapsule({

        capsuleId,

        vaultBytes,

        vaultKey,

      });

    /*
     * Persist temporary encrypted Vault inside the local Runtime.
     *
     * After this point, the canonical PREPARED state carries a
     * LocalVaultPointer, not a full encrypted payload.
     */

    const encryptedVaultPointer =
      createLocalVaultPointer(
        capsuleId
      );

    await runtime.storeVault(
      capsuleId,
      encrypted.encryptedPayload
    );

    encrypted.encryptedPayload.fill(0);

    /*
     * PREPARED boundary
     */

    preparedIdentities.add(
      capsuleId
    );

    return Object.freeze({

      chunkMetadata:
        mediaResult.chunkMetadata,

      encryptedVaultPointer,

      encryptedSizeBytes:
        encrypted.encryptedSizeBytes,

      vaultSha256:
        encrypted.vaultSha256,

      saltBase,

      capsuleId,

      recipientSecret,

      creatorAuthority,

    });

  }

  catch {

    throw PREPARE_ERROR;

  }

}
