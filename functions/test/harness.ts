export interface FakeKV {
  data: Map<string, string>;
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }>;
}

export function createFakeKV(): FakeKV {
  return {
    data: new Map(),
    async get(key) {
      return this.data.get(key) ?? null;
    },
    async put(key, value) {
      this.data.set(key, value);
    },
    async delete(key) {
      this.data.delete(key);
    },
    async list(options) {
      const prefix = options.prefix ?? "";
      return {
        keys: [...this.data.keys()]
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ name })),
      };
    },
  };
}

export interface FakeHeaders {
  store: Map<string, string>;
  get(name: string): string | undefined;
}

export function createFakeHeaders(
  init: Record<string, string> = {}
): FakeHeaders {
  return {
    store: new Map(Object.entries(init)),
    get(name) {
      return this.store.get(name);
    },
  };
}

export interface FakeRequest {
  headers: FakeHeaders;
  json(): Promise<unknown>;
}

export function createFakeRequest(init: {
  headers?: Record<string, string>;
  body?: unknown;
} = {}): FakeRequest {
  return {
    headers: createFakeHeaders(init.headers),
    async json() {
      return Promise.resolve(init.body ?? {});
    },
  };
}

export interface CreateQuoteEnv {
  BUSINESS_QUOTES: FakeKV;
}

export interface FakeEventContext {
  request: FakeRequest;
  env: CreateQuoteEnv;
}

export function makeEventContext(
  input: FakeEventContext
): Required<Pick<FakeEventContext, "request">> & FakeEventContext {
  return {
    request: input.request,
    env: input.env,
  };
}

/* ================= FAKE CREDIT OP COORDINATOR BINDING ================= */

import { CreditOperationCoordinator } from "./../do/creditOperationCoordinator";

export interface FakeDurableObjectTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface FakeDurableObjectStorage {
  data: Map<string, unknown>;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  transaction<T>(
    closure: (txn: FakeDurableObjectTransaction) => Promise<T>
  ): Promise<T>;
}

/**
 * In-memory Durable Object storage.
 *
 * `transaction()` emulates the real contract: writes are staged and
 * applied ATOMICALLY on success, and a throw rolls every staged write
 * back. Reads inside the closure observe staged writes, exactly like the
 * real DurableObjectTransaction. This is what lets the container
 * publication claim write its per-capsule claim and its per-tx binding
 * all-or-nothing.
 */
export function createFakeDurableObjectStorage(): FakeDurableObjectStorage {
  const data = new Map<string, unknown>();

  return {
    data,
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
    async transaction<T>(
      closure: (txn: FakeDurableObjectTransaction) => Promise<T>
    ): Promise<T> {
      const staged = new Map<string, unknown>();
      const deleted = new Set<string>();

      const txn: FakeDurableObjectTransaction = {
        async get<U>(key: string) {
          if (deleted.has(key)) return undefined;
          if (staged.has(key)) return staged.get(key) as U;
          return data.get(key) as U | undefined;
        },
        async put(key: string, value: unknown) {
          deleted.delete(key);
          staged.set(key, value);
        },
        async delete(key: string) {
          staged.delete(key);
          deleted.add(key);
        },
      };

      const result = await closure(txn);

      for (const key of deleted) data.delete(key);
      for (const [key, value] of staged) data.set(key, value);

      return result;
    },
  };
}

/**
 * Fake CREDIT_OP_COORDINATOR binding emulating the real Durable Object
 * runtime semantics needed by the payment-tx uniqueness tests:
 *
 * - one CreditOperationCoordinator instance per idFromName (per-key
 *   instances, exactly like the runtime);
 * - a per-instance fetch QUEUE emulating the DO input gate
 *   (single-threaded request processing): concurrent fetches on the
 *   same instance are serialized instead of interleaving at await
 *   points, which is what the runtime guarantees and what makes the
 *   claim's get -> decide -> put sequence atomic.
 */
export function createFakeCreditCoordinatorBinding() {
  const instances = new Map<string, CreditOperationCoordinator>();
  const storages = new Map<string, FakeDurableObjectStorage>();
  const queues = new Map<string, Promise<unknown>>();

  function instanceFor(id: string): CreditOperationCoordinator {
    let instance = instances.get(id);
    if (!instance) {
      const storage = createFakeDurableObjectStorage();
      storages.set(id, storage);
      instance = new CreditOperationCoordinator(
        { storage } as never,
        {
          CREATOR_CREDITS: {
            get: async () => null,
            put: async () => {},
            delete: async () => {},
          },
          PUBLICATION_VERIFICATIONS: { get: async () => null },
          SEAL_VERIFICATIONS: { get: async () => null },
        },
      );
      instances.set(id, instance);
    }
    return instance;
  }

  return {
    idFromName(name: string) {
      return { id: name };
    },
    get(binding: { id: string }) {
      const id = binding.id;
      instanceFor(id);
      return {
        async fetch(request: Request): Promise<Response> {
          const tail = queues.get(id) ?? Promise.resolve();
          const run = tail.then(() => instances.get(id)!.fetch(request));
          queues.set(
            id,
            run.then(
              () => undefined,
              () => undefined
            )
          );
          return run;
        },
      };
    },
    /** Direct access to per-instance DO storage for assertions. */
    storages,
  };
}
