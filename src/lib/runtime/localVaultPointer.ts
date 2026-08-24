/**
 * AETERNA — Local Vault Pointer capability
 *
 * This is a temporary runtime reference to an encrypted Vault
 * stored inside the local persistent Runtime Layer.
 *
 * It is NOT:
 * - an Irys/Arweave StoragePointer;
 * - a manifest identity;
 * - an authorization;
 * - payment evidence.
 */

export type LocalVaultPointer =
  string & { readonly __localVaultBrand: "aeterna/local-vault-pointer" };

const LOCAL_VAULT_PREFIX =
  "aeterna-local-vault:";

export function createLocalVaultPointer(
  capsuleId: string,
): LocalVaultPointer {

  if (
    typeof capsuleId !== "string" ||
    !/^[a-z0-9-]+$/.test(capsuleId)
  ) {
    throw new Error(
      "[AETERNA] Invalid capsuleId for LocalVaultPointer."
    );
  }

  return `${LOCAL_VAULT_PREFIX}${capsuleId}` as LocalVaultPointer;
}

export function assertLocalVaultPointer(
  value: unknown,
): LocalVaultPointer {

  if (
    typeof value !== "string" ||
    !value.startsWith(LOCAL_VAULT_PREFIX) ||
    value.length <= LOCAL_VAULT_PREFIX.length
  ) {
    throw new Error(
      "[AETERNA] Invalid LocalVaultPointer."
    );
  }

  return value as LocalVaultPointer;
}

export function localVaultPointerCapsuleId(
  pointer: LocalVaultPointer
): string {

  const capsuleId =
    pointer.slice(
      LOCAL_VAULT_PREFIX.length
    );

  if (!capsuleId) {
    throw new Error(
      "[AETERNA] LocalVaultPointer missing capsuleId."
    );
  }

  return capsuleId;
}
