import type {
  ChunkMetadata,
} from "@/types/vault";

import type {
  OpenAtUtc,
} from "@/types/manifest";

export type MediaType =
  | "image"
  | "video"
  | "audio"
  | "file";

export interface TextItem {
  readonly id: string;
  readonly type: "text";
  readonly text: string;
  readonly createdAt: string;
}

export interface MediaItem {
  readonly id: string;
  readonly type: "media";
  readonly mediaType: MediaType;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: string;
}

export type CapsuleItem =
  | TextItem
  | MediaItem;

export interface PreparedCapsule {

  readonly chunkMetadata:
    readonly ChunkMetadata[];

  readonly encryptedVaultPointer:
    string;

  readonly encryptedSizeBytes:
    number;

  readonly vaultSha256:
    string;

  readonly saltBase:
    string;

  readonly capsuleId:
    string;

  readonly recipientSecret:
    string;

  readonly creatorAuthority:
    string;

}

export interface CapsuleHoldState {

  readonly prepared:
    PreparedCapsule;

  readonly openAt:
    OpenAtUtc;

  readonly description?:
    string;

  readonly billableSizeBytes:
    number;

  readonly expectedAmount:
    number;

  readonly itemIds:
    readonly string[];

  readonly creatorAuthority:
    string;

}