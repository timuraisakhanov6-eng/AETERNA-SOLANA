import { useEffect, useRef, useState } from "react";
import type { ManifestV1 } from "@/types/manifest";
import type { ChunkMetadata, PublishedChunkMetadata, Vault } from "@/types/vault";
import { storage } from "@/lib/storage/storage";
import { resolveContainerChunks } from "@/lib/capsule/open/resolveContainerChunks";
import VaultRenderer from "./VaultRenderer";

type Props = {
  manifest: ManifestV1;
  capsuleId: string;
  initialVault?: Vault;
  initialCryptoKey?: CryptoKey;
};

type OpenState =
  | { status: "opening" }
  | { status: "opened"; vault: Vault; cryptoKey: CryptoKey }
  | { status: "error" };

/**
 * Safe CryptoKey instanceof guard.
 *
 * Direct `instanceof CryptoKey` throws ReferenceError in SSR,
 * prerender, edge, and test runtimes where the global is absent.
 * This helper checks for global availability before the instanceof,
 * making the guard portable across all supported execution environments.
 */

const isCryptoKey = (
  value: unknown
): value is CryptoKey => {

  return (
    typeof CryptoKey !== "undefined" &&
    value instanceof CryptoKey
  );

};

export default function CapsuleOpened({
  manifest: _manifest,
  capsuleId: _capsuleId,
  initialVault,
  initialCryptoKey,
}: Props) {

  // Guard #1: capsuleId invariant — CapsuleOpened participates in
  // post-decrypt rendering boundary and must preserve capsule identity.
  if (!_capsuleId || typeof _capsuleId !== "string") {
    throw new Error("[AETERNA] Invalid capsuleId");
  }

  /**
   * CapsuleController уже выполняет decrypt lifecycle.
   * CapsuleOpened только отображает результат.
   */

  /**
   * CONTAINER V1 resolution, indexed by logical chunkId.
   *
   * null means "not yet resolved". A populated map means the logical chunk
   * carries its DERIVED container position, so the runtime reads a window of
   * the ONE container DataItem instead of a whole per-chunk object.
   *
   * Indexing by chunkId (rather than by media item) is deliberate:
   * `MediaItemV2` carries no item identifier, and the canonical identity of
   * a logical chunk IS its chunkId — so the mapping needs no extra field and
   * cannot drift from the Vault's own chunk list.
   */
  const [containerChunks, setContainerChunks] =
    useState<
      ReadonlyMap<
        string,
        PublishedChunkMetadata
      > | null
    >(null);

  const [state, setState] = useState<OpenState>(() => {

    // Guard #2: isCryptoKey — protects against runtime injection,
    // SSR mismatch, and test harness corruption edge-cases.
    // Safe across all execution environments (no bare instanceof).
    if (initialVault && isCryptoKey(initialCryptoKey)) {

      return {
        status: "opened",
        vault: initialVault,
        cryptoKey: initialCryptoKey,
      };

    }

    return {
      status: "error",
    };

  });

  /**
   * The opened Vault, captured OUTSIDE the pointer-read effect so that effect
   * can declare it as a dependency instead of reaching into the state union.
   * Stable for the lifetime of an opened capsule.
   */
  const openedVault =
    state.status === "opened" ? state.vault : null;

  /**
   * предотвращает duplicate execution
   */

  const startedRef = useRef(false);

  /**
   * CapsuleOpened больше НЕ выполняет openCapsule()
   * decrypt lifecycle строго внутри CapsuleController
   */

  useEffect(() => {

    // Guard #2 mirrored: isCryptoKey for consistency and SSR safety
    if (initialVault && isCryptoKey(initialCryptoKey)) {
      return;
    }

    if (startedRef.current) {
      return;
    }

    startedRef.current = true;

    /**
     * Secret lifecycle завершён ранее.
     * Повторный decrypt невозможен без fragment secret.
     */

    setState({
      status: "error",
    });

  }, [initialVault, initialCryptoKey]);

  /**
   * Canonical Container V1 publication read.
   *
   * The container publication record is obtained exclusively through
   * storage.getChunkPointerReadout() (Storage Authority).
   * manifest.ext.chunkPointers is never a source here.
   *
   * Fail-closed: if the publication cannot be obtained, the existing
   * error state is used — no fallback.
   */

  useEffect(() => {

    if (state.status !== "opened" || openedVault === null) {
      return;
    }

    let cancelled = false;

    storage
      .getChunkPointerReadout(
        _capsuleId
      )
      .then(async (readout) => {

        if (cancelled) return;

        /**
         * CONTAINER V1: the publication record is the media authority.
         *
         * Every logical chunk's position is DERIVED from the canonical Vault
         * chunk metadata through the canonical layout — offsets are never
         * read from storage. `resolveContainerChunks` fails closed on a chunk
         * count / identity / layoutDigest mismatch, so a record that does not
         * describe this Vault can never resolve.
         *
         * A missing publication fails closed: Container V1 is the ONLY media
         * model, so there is no legacy fallback.
         */
        if (readout.container === null) {
          throw new Error(
            "[AETERNA] Container publication is required"
          );
        }

        const items =
          (openedVault.capsule?.items ?? []).map(
            (item) =>
              ((item as { chunks?: readonly ChunkMetadata[] }).chunks ?? [])
          );

        const resolved =
          await resolveContainerChunks(
            items,
            readout.container
          );

        if (cancelled) return;

        const byChunkId =
          new Map<string, PublishedChunkMetadata>();

        for (const chunk of resolved) {
          byChunkId.set(chunk.chunkId, chunk);
        }

        setContainerChunks(byChunkId);

      })
      .catch(() => {
        if (!cancelled) {
          setState({
            status: "error",
          });
        }
      });

    return () => {
      cancelled = true;
    };

  }, [
    state.status,
    openedVault,
    _capsuleId,
  ]);

  /**
   * OPENING STATE
   */

  if (state.status === "opening") {

    return (

      <div className="min-h-screen flex items-center justify-center">

        <p className="text-sm text-muted-foreground">
          Opening capsule…
        </p>

      </div>

    );

  }

  /**
   * ERROR STATE
   */

  if (state.status === "error") {

    return (

      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">

        <p className="text-sm text-muted-foreground text-center">
          Capsule content unavailable. Reload the original capsule link.
        </p>

        <button
          onClick={() => window.location.reload()}
          className="text-xs underline underline-offset-4 text-muted-foreground hover:text-foreground transition-colors"
        >
          Reload capsule
        </button>

      </div>

    );

  }

  /**
   * OPENED STATE
   */

  return (

    <div className="min-h-screen bg-background px-6 py-12">

      <div className="mx-auto max-w-3xl space-y-6">

        <header className="space-y-2">

          <h1 className="text-2xl font-semibold">
            Capsule Opened
          </h1>

          <p className="text-sm text-muted-foreground">
            This content was decrypted locally in your browser.
          </p>

        </header>

        {containerChunks === null ? (

          <p className="text-sm text-muted-foreground">
            Opening capsule…
          </p>

        ) : (

          <VaultRenderer
            vault={state.vault}
            cryptoKey={state.cryptoKey}
            containerChunks={containerChunks}
          />

        )}

      </div>

    </div>

  );

}