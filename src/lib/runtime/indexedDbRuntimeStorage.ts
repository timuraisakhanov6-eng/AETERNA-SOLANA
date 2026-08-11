import type {
  RuntimeStorage,
} from "./runtimeStorage";

import type {
  RuntimeChunkRecord,
} from "./runtimeTypes";

const DB_NAME =
  "aeterna-runtime";

const DB_VERSION =
  1;

const STORE_NAME =
  "runtimeChunks";

interface RuntimeChunkDbRecord {

  key: string;

  capsuleId: string;

  chunkId: string;

  mediaId: string;

  chunkIndex: number;

  ciphertext: ArrayBuffer;

}

/**
 * Persistent Runtime implementation.
 *
 * Stores temporary encrypted chunk ciphertexts
 * inside IndexedDB until publication finishes.
 *
 * Runtime is NOT part of Protocol Layer.
 * Runtime is NOT Authority.
 */
export class IndexedDbRuntimeStorage
  implements RuntimeStorage {

  private db:
    IDBDatabase | null =
      null;

  private capsuleId:
    string | null =
      null;

  async open(
    capsuleId: string,
  ): Promise<void> {

    if (this.db) {

      /**
       * FIX — fail-closed capsule-identity enforcement.
       *
       * A Runtime instance is bound to exactly one capsule for its
       * entire lifecycle. Silently re-pointing `this.capsuleId` to a
       * second capsule while `this.db` stays open would let a later
       * open(B) call transparently take over a Runtime that still
       * holds — or could still receive — chunks belonging to capsule A.
       *
       * Canonical lifecycle: createRuntime() → open(capsuleId) → work →
       * clear() → destroyRuntime(). Re-opening under a different
       * capsuleId is not part of that lifecycle and must be rejected,
       * not silently accepted.
       */

      if (this.capsuleId !== capsuleId) {

        throw new Error(
          "[AETERNA] Runtime already opened for another capsule.",
        );

      }

      return;

    }

    this.db =
      await this.openDatabase();

    this.capsuleId =
      capsuleId;

  }

  private openDatabase():
    Promise<IDBDatabase> {

    return new Promise((
      resolve,
      reject,
    ) => {

      const request =
        indexedDB.open(
          DB_NAME,
          DB_VERSION,
        );

      request.onerror =
        () => {

          reject(
            request.error ??
            new Error(
              "[AETERNA] Failed to open Runtime database.",
            ),
          );

        };

      request.onblocked =
        () => {

          reject(
            new Error(
              "[AETERNA] Runtime database upgrade blocked by an open connection.",
            ),
          );

        };

      request.onupgradeneeded =
        () => {

          const db =
            request.result;

          if (
            !db.objectStoreNames.contains(
              STORE_NAME,
            )
          ) {

            db.createObjectStore(
              STORE_NAME,
              {
                keyPath:
                  "key",
              },
            );

          }

        };

      request.onsuccess =
        () => {

          const db =
            request.result;

          db.onversionchange =
            () => {

              db.close();

              this.db = null;

            };

          resolve(db);

        };

    });

  }

  private getDatabase():
    IDBDatabase {

    if (!this.db) {

      throw new Error(
        "[AETERNA] Runtime database is not open.",
      );

    }

    return this.db;

  }

  private getCapsuleId():
    string {

    if (!this.capsuleId) {

      throw new Error(
        "[AETERNA] Runtime capsule is not open.",
      );

    }

    return this.capsuleId;

  }

  private transaction(
    mode:
      IDBTransactionMode,
  ): IDBObjectStore {

    return this
      .getDatabase()
      .transaction(
        STORE_NAME,
        mode,
      )
      .objectStore(
        STORE_NAME,
      );

  }

  private buildKey(
    capsuleId: string,
    chunkId: string,
  ): string {

    return `${capsuleId}:${chunkId}`;

  }

  async store(
    record: RuntimeChunkRecord,
  ): Promise<void> {

    const capsuleId =
      this.getCapsuleId();

    const dbRecord:
      RuntimeChunkDbRecord = {

      key:
        this.buildKey(
          capsuleId,
          record.chunkId,
        ),

      capsuleId,

      chunkId:
        record.chunkId,

      mediaId:
        record.mediaId,

      chunkIndex:
        record.chunkIndex,

      ciphertext:
        Uint8Array
          .from(
            record.ciphertext,
          )
          .buffer,

    };

    await new Promise<void>((
      resolve,
      reject,
    ) => {

      const request =
        this
          .transaction(
            "readwrite",
          )
          .put(
            dbRecord,
          );

      request.onsuccess =
        () => resolve();

      request.onerror =
        () => reject(

          request.error ??

          new Error(
            "[AETERNA] Failed to store Runtime chunk.",
          ),

        );

    });

  }

  async read(
    chunkId: string,
  ): Promise<
    RuntimeChunkRecord
  > {

    const capsuleId =
      this.getCapsuleId();

    const record =
      await new Promise<
        RuntimeChunkDbRecord | undefined
      >((
        resolve,
        reject,
      ) => {

        const request =
          this
            .transaction(
              "readonly",
            )
            .get(

              this.buildKey(
                capsuleId,
                chunkId,
              ),

            );

        request.onsuccess =
          () => {

            resolve(
              request.result as
                RuntimeChunkDbRecord |
                undefined,
            );

          };

        request.onerror =
          () => reject(

            request.error ??

            new Error(
              "[AETERNA] Failed to read Runtime chunk.",
            ),

          );

      });

    if (!record) {

      throw new Error(
        "[AETERNA] Runtime chunk not found.",
      );

    }

    return Object.freeze({

      chunkId:
        record.chunkId,

      mediaId:
        record.mediaId,

      chunkIndex:
        record.chunkIndex,

      ciphertext:
        new Uint8Array(
          record.ciphertext.slice(
            0,
          ),
        ),

    });

  }

  async remove(
    chunkId: string,
  ): Promise<void> {

    const capsuleId =
      this.getCapsuleId();

    const key =
      this.buildKey(
        capsuleId,
        chunkId,
      );

    await new Promise<void>((
      resolve,
      reject,
    ) => {

      const store =
        this.transaction(
          "readwrite",
        );

      const getRequest =
        store.getKey(key);

      getRequest.onsuccess =
        () => {

          if (
            getRequest.result ===
            undefined
          ) {

            reject(
              new Error(
                "[AETERNA] Runtime chunk not found.",
              ),
            );

            return;

          }

          const delRequest =
            store.delete(key);

          delRequest.onsuccess =
            () => resolve();

          delRequest.onerror =
            () => reject(

              delRequest.error ??

              new Error(
                "[AETERNA] Failed to remove Runtime chunk.",
              ),

            );

        };

      getRequest.onerror =
        () => reject(

          getRequest.error ??

          new Error(
            "[AETERNA] Failed to remove Runtime chunk.",
          ),

        );

    });

  }

  async clear(): Promise<void> {

    const capsuleId =
      this.getCapsuleId();

    const prefix =
      `${capsuleId}:`;

    const range =
      IDBKeyRange.bound(
        prefix,
        `${prefix}\uffff`,
      );

    await new Promise<void>((
      resolve,
      reject,
    ) => {

      const store =
        this.transaction(
          "readwrite",
        );

      const request =
        store.openCursor(range);

      request.onsuccess =
        () => {

          const cursor =
            request.result;

          if (!cursor) {

            resolve();

            return;

          }

          const del =
            cursor.delete();

          del.onsuccess =
            () => {

              cursor.continue();

            };

          del.onerror =
            () => reject(

              del.error ??

              new Error(
                "[AETERNA] Failed to clear Runtime chunk.",
              ),

            );

        };

      request.onerror =
        () => reject(

          request.error ??

          new Error(
            "[AETERNA] Failed to open cursor for Runtime clear.",
          ),

        );

    });

  }

}