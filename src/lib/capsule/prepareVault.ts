import type {
  CapsuleItemV2
} from "@/types/vault";

import {
  canonicalSerializeVaultV2
} from "@/lib/vault/canonicalSerializeVaultV2";

import {
  CAPSULE_ID_REGEX,
  ISO8601_REGEX
} from "@/lib/crypto/validators";


const PREPARE_ERROR =
  new Error("[AETERNA] Vault preparation failed");


const MAX_ITEMS =
  100;


const MAX_SERIALIZED_SIZE =
  10_000_000;


/**
 * Recursively freeze validated runtime payload
 *
 * Prevents post-validation mutation of nested
 * objects/arrays before canonical serialization.
 */

function deepFreezeValue(
  value: unknown
): void {

  if (
    !value ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return;
  }

  Object.freeze(value);

  for (const nested of Object.values(value)) {
    deepFreezeValue(nested);
  }

}


/**
 * Freeze vault items and all nested structures
 */

function deepFreezeItems(
  items: CapsuleItemV2[]
): void {

  for (const item of items) {
    deepFreezeValue(item);
  }

  Object.freeze(items);

}


export async function prepareVault(
  params: {

    capsuleId: string;

    createdAt: string;

    items: CapsuleItemV2[];

  }

): Promise<Uint8Array> {

  const {
    capsuleId,
    createdAt,
    items
  } = params;


  if (
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {

    throw PREPARE_ERROR;

  }


  if (

    typeof createdAt !== "string" ||

    !ISO8601_REGEX.test(
      createdAt
    )

  ) {

    throw PREPARE_ERROR;

  }


  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {

    throw PREPARE_ERROR;

  }


  if (items.length > MAX_ITEMS) {

    throw PREPARE_ERROR;

  }


  for (const item of items) {

    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {

      throw PREPARE_ERROR;

    }


    if (

      Object.getPrototypeOf(item)
      !== Object.prototype

    ) {

      throw PREPARE_ERROR;

    }

  }


  let safeItems:
    CapsuleItemV2[];


  try {

    safeItems =
      structuredClone(
        items
      );

  }

  catch {

    throw PREPARE_ERROR;

  }


  deepFreezeItems(
    safeItems
  );


  let plaintext:
    Uint8Array;


  try {

    plaintext =
      canonicalSerializeVaultV2({

        createdAt,

        capsuleId,

        items: safeItems,

      });

  }

  catch {

    throw PREPARE_ERROR;

  }


  if (

    !(plaintext instanceof Uint8Array) ||

    plaintext.byteLength === 0 ||

    plaintext.byteLength >
      MAX_SERIALIZED_SIZE

  ) {

    throw PREPARE_ERROR;

  }


  return plaintext;

}