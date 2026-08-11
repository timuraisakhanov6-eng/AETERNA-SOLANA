import { useEffect, useRef, useState } from "react";
import type { ChunkId, ManifestV1 } from "@/types/manifest";
import type { Vault } from "@/types/vault";
import type { StoragePointer } from "@/lib/storage/storageAdapter";
import { storage } from "@/lib/storage/storage";
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
   * Canonical Chunk Pointer Registry map (chunkId → StoragePointer),
   * resolved exclusively through Storage Authority. null while the
   * registry read is in flight.
   */

  const [chunkPointers, setChunkPointers] =
    useState<
      Readonly<
        Record<ChunkId, StoragePointer>
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
   * Canonical Chunk Pointer Registry read.
   *
   * chunkId → StoragePointer is obtained exclusively through
   * storage.getChunkPointers() (Storage Authority).
   * manifest.ext.chunkPointers is never a source here.
   *
   * Fail-closed: if the Registry map cannot be obtained, the existing
   * error state is used — no fallback.
   */

  useEffect(() => {

    if (state.status !== "opened") {
      return;
    }

    let cancelled = false;

    storage
      .getChunkPointers(
        _capsuleId
      )
      .then((map) => {
        if (!cancelled) {
          setChunkPointers(map);
        }
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

        {chunkPointers === null ? (

          <p className="text-sm text-muted-foreground">
            Opening capsule…
          </p>

        ) : (

          <VaultRenderer
            vault={state.vault}
            cryptoKey={state.cryptoKey}
            chunkPointers={chunkPointers}
          />

        )}

      </div>

    </div>

  );

}