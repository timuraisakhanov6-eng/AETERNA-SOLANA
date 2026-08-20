export interface FakeKV {
  data: Map<string, string>;
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
  delete(key: string): Promise<void>;
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
