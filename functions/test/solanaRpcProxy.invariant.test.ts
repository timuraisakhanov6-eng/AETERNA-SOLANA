/**
 * AETERNA — /api/solana/rpc read-only JSON-RPC transport invariants.
 *
 * Irys's `@solana/web3.js` Connection reads the chain through JSON-RPC, but the
 * browser must not call a public Solana RPC (api.mainnet-beta.solana.com
 * answers browser-origin requests with HTTP 403). This endpoint supplies the
 * same transport server-side, READ-ONLY.
 *
 * Proves:
 *   - allow-listed read methods are forwarded with their params unchanged;
 *   - every write method is rejected BEFORE any upstream call;
 *   - malformed input, missing RPC config and upstream errors fail closed;
 *   - responses keep JSON-RPC structure (`{jsonrpc, id, result|error}`);
 *   - `Cache-Control: no-store`;
 *   - origin handling matches the established AETERNA server pattern;
 *   - the upstream RPC URL is never echoed.
 *
 * Global fetch is stubbed at the RPC boundary only; the real handler runs.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  onRequestPost,
  onRequestOptions,
} from "./../api/solana/rpc";

const RPC_URL = "https://rpc.internal.invalid";
const ALLOWED_ORIGIN = "https://aeterna-solana.pages.dev";

interface RecordedCall {
  method: string;
  params: unknown[];
}

function stubRpc(handler: (method: string) => unknown) {
  const calls: RecordedCall[] = [];

  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: unknown[];
      };
      const method = String(parsed.method ?? "");
      calls.push({ method, params: parsed.params ?? [] });
      return new Response(JSON.stringify(handler(method)), { status: 200 });
    }
  );

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function contextFor(options: {
  body?: unknown;
  origin?: string;
  rpcUrl?: string | null;
  jsonThrows?: boolean;
  clientIp?: string;
} = {}) {
  const origin = options.origin ?? ALLOWED_ORIGIN;

  const env =
    options.rpcUrl === null
      ? {}
      : { SOLANA_MAINNET_RPC_URL: options.rpcUrl ?? RPC_URL };

  return {
    request: {
      headers: {
        get: (name: string) => {
          const key = name.toLowerCase();
          if (key === "origin") return origin;
          if (key === "cf-connecting-ip") return options.clientIp ?? null;
          return null;
        },
      },
      json: async () => {
        if (options.jsonThrows) throw new SyntaxError("Unexpected token");
        return options.body ?? {};
      },
    },
    env,
  } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/api/solana/rpc — read-only JSON-RPC transport", () => {
  it("A. forwards an allow-listed getAccountInfo with params unchanged", async () => {
    const { calls } = stubRpc(() => ({
      jsonrpc: "2.0",
      id: 1,
      result: { context: { slot: 1 }, value: { owner: "Tokenkeg" } },
    }));

    const params = [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      { encoding: "jsonParsed", commitment: "finalized" },
    ];

    const response = await onRequestPost(
      contextFor({
        body: { jsonrpc: "2.0", id: "abc", method: "getAccountInfo", params },
      })
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("getAccountInfo");
    expect(calls[0]!.params).toEqual(params);
  });

  it("B. forwards an allow-listed getLatestBlockhash", async () => {
    const { calls } = stubRpc(() => ({
      jsonrpc: "2.0",
      id: 1,
      result: { value: { blockhash: "abc", lastValidBlockHeight: 5 } },
    }));

    const response = await onRequestPost(
      contextFor({
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "getLatestBlockhash",
          params: [{ commitment: "finalized" }],
        },
      })
    );

    expect(response.status).toBe(200);
    expect(calls[0]!.method).toBe("getLatestBlockhash");
  });

  it("C. rejects a malformed request body with PARSE_ERROR", async () => {
    const { fetchMock } = stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: 1 }));

    const response = await onRequestPost(contextFor({ jsonThrows: true }));

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toBe("PARSE_ERROR");
    // Fail closed: nothing reached the RPC.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("D. rejects an unsupported write method before any upstream call", async () => {
    const { fetchMock } = stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: 1 }));

    const response = await onRequestPost(
      contextFor({
        body: { jsonrpc: "2.0", id: 1, method: "sendRawTransaction", params: [] },
      })
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toBe("METHOD_NOT_ALLOWED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("E. rejects sendTransaction explicitly", async () => {
    const { fetchMock } = stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: 1 }));

    const response = await onRequestPost(
      contextFor({
        body: { jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [] },
      })
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects every other state-changing method", async () => {
    const { fetchMock } = stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: 1 }));

    const writeMethods = [
      "sendTransaction",
      "sendRawTransaction",
      "simulateTransaction",
      "requestAirdrop",
      "createAccount",
      "transfer",
      "closeAccount",
      "setAccountInfo",
    ];

    for (const method of writeMethods) {
      const response = await onRequestPost(
        contextFor({ body: { jsonrpc: "2.0", id: 1, method, params: [] } })
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
        "METHOD_NOT_ALLOWED"
      );
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("F. missing SOLANA_MAINNET_RPC_URL fails closed with 502", async () => {
    const { fetchMock } = stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: 1 }));

    const response = await onRequestPost(
      contextFor({
        rpcUrl: null,
        body: { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] },
      })
    );

    expect(response.status).toBe(502);
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toBe("RPC_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("G. an upstream RPC error fails closed and never leaks the RPC URL", async () => {
    stubRpc(() => ({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "UPSTREAM_DOWN" },
    }));

    const response = await onRequestPost(
      contextFor({
        body: { jsonrpc: "2.0", id: 7, method: "getSlot", params: [] },
      })
    );

    expect(response.status).toBe(502);
    const payload = (await response.json()) as {
      jsonrpc: string;
      id: unknown;
      error: { code: number; message: string };
    };
    expect(payload.error.message).toBe("UPSTREAM_DOWN");
    expect(JSON.stringify(payload)).not.toContain(RPC_URL);
    expect(JSON.stringify(payload)).not.toContain("rpc.internal.invalid");
  });

  it("H. preserves JSON-RPC structure and echoes the request id", async () => {
    stubRpc(() => ({
      jsonrpc: "2.0",
      id: 1,
      result: { absoluteSlot: 42 },
    }));

    const response = await onRequestPost(
      contextFor({
        body: { jsonrpc: "2.0", id: "req-9", method: "getSlot", params: [] },
      })
    );

    const payload = (await response.json()) as {
      jsonrpc: string;
      id: unknown;
      result: unknown;
    };

    expect(payload.jsonrpc).toBe("2.0");
    expect(payload.id).toBe("req-9");
    expect(payload.result).toEqual({ absoluteSlot: 42 });
  });

  it("I. every response is Cache-Control: no-store", async () => {
    stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: 1 }));

    const ok = await onRequestPost(
      contextFor({ body: { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] } })
    );
    expect(ok.headers.get("Cache-Control")).toBe("no-store");

    const bad = await onRequestPost(
      contextFor({ body: { jsonrpc: "2.0", id: 1, method: "sendTransaction" } })
    );
    expect(bad.headers.get("Cache-Control")).toBe("no-store");

    const noRpc = await onRequestPost(
      contextFor({ rpcUrl: null, body: { jsonrpc: "2.0", id: 1, method: "getSlot" } })
    );
    expect(noRpc.headers.get("Cache-Control")).toBe("no-store");
  });

  it("J. origin handling matches the established AETERNA server pattern", async () => {
    stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Allowed origin: echoed back in ACAO.
    const allowed = await onRequestPost(
      contextFor({
        origin: ALLOWED_ORIGIN,
        body: { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] },
      })
    );
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(allowed.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");

    // Disallowed origin: 403, and the untrusted origin is NOT echoed.
    const denied = await onRequestPost(
      contextFor({
        origin: "https://evil.example.com",
        body: { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] },
      })
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();

    // OPTIONS preflight: 204 for allowed, 403 for denied.
    const preflight = await onRequestOptions(contextFor({}));
    expect(preflight.status).toBe(204);
    const preflightDenied = await onRequestOptions(
      contextFor({ origin: "https://evil.example.com" })
    );
    expect(preflightDenied.status).toBe(403);
  });

  it("K. rejects a JSON-RPC batch — empty and mixed-with-a-write — with zero upstream calls", async () => {
    const { fetchMock } = stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Batch is NOT supported: an array carries no `method`, so the whole
    // request is rejected before any per-item processing. A write method can
    // therefore never be smuggled alongside an allowed read.
    const emptyBatch = await onRequestPost(contextFor({ body: [] }));
    expect(emptyBatch.status).toBe(400);
    expect(
      ((await emptyBatch.json()) as { error: { message: string } }).error.message
    ).toBe("INVALID_REQUEST");

    const mixedBatch = await onRequestPost(
      contextFor({
        body: [
          { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [] },
          { jsonrpc: "2.0", id: 2, method: "sendTransaction", params: [] },
        ],
      })
    );
    expect(mixedBatch.status).toBe(400);
    expect(
      ((await mixedBatch.json()) as { error: { message: string } }).error.message
    ).toBe("INVALID_REQUEST");

    // Nothing was forwarded — not even the allowed item.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("L. rejects allowlist bypass variants — casing, whitespace, prototype keys", async () => {
    const { fetchMock } = stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: 1 }));

    const variants = [
      "sendtransaction",
      "SendTransaction",
      "SENDTRANSACTION",
      " getAccountInfo",
      "getAccountInfo ",
      "getAccountInfo\t",
      // A Set (not an object map) is used, so prototype keys cannot resolve.
      "constructor",
      "__proto__",
      "toString",
      "valueOf",
    ];

    for (const method of variants) {
      const response = await onRequestPost(
        contextFor({ body: { jsonrpc: "2.0", id: 1, method, params: [] } })
      );

      expect(response.status).toBe(400);
      expect(
        ((await response.json()) as { error: { message: string } }).error.message
      ).toBe("METHOD_NOT_ALLOWED");
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("M. rate-limits the POST endpoint per client IP and never rate-limits OPTIONS", async () => {
    const { fetchMock } = stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: 1 }));

    const body = { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] };
    // A unique IP keeps this test independent of the shared isolate-local
    // limiter state (other tests send no CF-Connecting-IP and are fail-open).
    const clientIp = "203.0.113.77";

    // The established limiter allows 60 requests per 60s window.
    for (let i = 0; i < 60; i++) {
      const allowed = await onRequestPost(contextFor({ body, clientIp }));
      expect(allowed.status).toBe(200);
    }

    const callsBefore = fetchMock.mock.calls.length;

    const limited = await onRequestPost(contextFor({ body, clientIp }));
    expect(limited.status).toBe(429);
    expect(
      ((await limited.json()) as { error: { message: string } }).error.message
    ).toBe("TOO_MANY_REQUESTS");
    // A throttled caller never reaches the upstream RPC.
    expect(fetchMock.mock.calls.length).toBe(callsBefore);

    // OPTIONS is a preflight, not a request: it must not consume the quota.
    const preflight = await onRequestOptions(contextFor({ clientIp }));
    expect(preflight.status).toBe(204);
  });
});
