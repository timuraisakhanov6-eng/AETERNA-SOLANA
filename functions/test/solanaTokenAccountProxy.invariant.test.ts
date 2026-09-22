/**
 * AETERNA — /api/solana/token-account proxy invariants.
 *
 * The endpoint exists so the browser can learn whether the settlement
 * wallet's USDC associated token account already exists, WITHOUT calling
 * Solana RPC directly (the browser must not open its own RPC connection —
 * same policy as /api/solana/blockhash).
 *
 * Proves:
 *   - the address is validated strictly (base58 shape) before any RPC work;
 *   - a missing SOLANA_MAINNET_RPC_URL binding fails closed with 502;
 *   - an RPC error fails closed with 502 and never reports existence;
 *   - `value: null` is reported as exists:false (NOT as an error);
 *   - an existing account is reported as exists:true with its owner;
 *   - every response is Cache-Control: no-store;
 *   - the proxy is READ-ONLY: exactly one getAccountInfo call, no write
 *     method, and the RPC URL is never echoed to the caller.
 *
 * Global fetch is stubbed at the RPC boundary only; the endpoint itself and
 * the shared solanaJsonRpc helper run for real.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { onRequestGet as tokenAccountGet } from "./../api/solana/token-account";

const RPC_URL = "https://rpc.example.invalid";

/** A real, well-formed base58 Solana public key shape. */
const VALID_ADDRESS = "76vsLfHBGR5pHAMFeT9KwuB1HB4gKmPYhC7fpvs3h58Y";
const TOKEN_PROGRAM_OWNER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

type RpcBody = Record<string, unknown>;

interface RecordedCall {
  url: string;
  method: string;
  params: unknown[];
}

/**
 * Stubs global fetch at the JSON-RPC boundary. Every call is recorded so the
 * read-only assertions can inspect the exact method/params used.
 */
function stubRpc(bodyFor: (method: string) => RpcBody) {
  const calls: RecordedCall[] = [];

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: unknown[];
      };
      const method = String(parsed.method ?? "");
      calls.push({ url: String(input), method, params: parsed.params ?? [] });
      return new Response(JSON.stringify(bodyFor(method)), { status: 200 });
    }
  );

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function contextFor(
  address: string,
  env: Record<string, unknown> = { SOLANA_MAINNET_RPC_URL: RPC_URL }
) {
  return {
    request: {
      url: `https://aeternacapsule.com/api/solana/token-account?address=${encodeURIComponent(
        address
      )}`,
    },
    env,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/api/solana/token-account invariants", () => {
  it("1. invalid address shape is rejected with 400 before any RPC work", async () => {
    const { fetchMock } = stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: null }));

    const invalid = [
      "",
      "not-base58",
      "0OIl", // base58 excludes 0, O, I and l
      "76vsLfHBGR5pHAMFeT9KwuB1HB4gKmP", // 31 chars — below the 32-char floor
      "76vsLfHBGR5pHAMFeT9KwuB1HB4gKmPYhC7fpvs3h58YEXTRA", // above the 44-char ceiling
    ];

    for (const address of invalid) {
      const response = await tokenAccountGet(contextFor(address));
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { ok: boolean };
      expect(payload.ok).toBe(false);
    }

    // Fail-closed: nothing was asked of the RPC.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("2. missing SOLANA_MAINNET_RPC_URL binding fails closed with 502", async () => {
    const { fetchMock } = stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: null }));

    const response = await tokenAccountGet(contextFor(VALID_ADDRESS, {}));

    expect(response.status).toBe(502);
    const payload = (await response.json()) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("RPC_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("3. an RPC error fails closed with 502 and never reports existence", async () => {
    stubRpc(() => ({
      jsonrpc: "2.0",
      id: 1,
      error: { message: "RPC_DOWN" },
    }));

    const response = await tokenAccountGet(contextFor(VALID_ADDRESS));

    expect(response.status).toBe(502);
    const payload = (await response.json()) as {
      ok: boolean;
      error: string;
      exists?: unknown;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("RPC_DOWN");
    // Fail-closed: no existence claim is made on an error path.
    expect(payload.exists).toBeUndefined();
  });

  it("4. value:null is reported as 200 {ok:true, exists:false}", async () => {
    stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: { value: null } }));

    const response = await tokenAccountGet(contextFor(VALID_ADDRESS));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      exists: boolean;
      owner: unknown;
    };
    expect(payload.ok).toBe(true);
    expect(payload.exists).toBe(false);
    expect(payload.owner).toBeNull();
  });

  it("5/6. an existing account is 200 {ok:true, exists:true} with its owner", async () => {
    stubRpc(() => ({
      jsonrpc: "2.0",
      id: 1,
      result: { value: { owner: TOKEN_PROGRAM_OWNER } },
    }));

    const response = await tokenAccountGet(contextFor(VALID_ADDRESS));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      exists: boolean;
      owner: string | null;
    };
    expect(payload.ok).toBe(true);
    expect(payload.exists).toBe(true);
    expect(payload.owner).toBe(TOKEN_PROGRAM_OWNER);
  });

  it("7. every response is Cache-Control: no-store", async () => {
    stubRpc(() => ({ jsonrpc: "2.0", id: 1, result: { value: null } }));

    const okResponse = await tokenAccountGet(contextFor(VALID_ADDRESS));
    expect(okResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(okResponse.headers.get("Content-Type")).toContain("application/json");

    const invalidResponse = await tokenAccountGet(contextFor("not-base58"));
    expect(invalidResponse.headers.get("Cache-Control")).toBe("no-store");

    const noRpcResponse = await tokenAccountGet(contextFor(VALID_ADDRESS, {}));
    expect(noRpcResponse.headers.get("Cache-Control")).toBe("no-store");
  });

  it("8. read-only: exactly one getAccountInfo call, no write method, no RPC URL echoed", async () => {
    const { fetchMock, calls } = stubRpc(() => ({
      jsonrpc: "2.0",
      id: 1,
      result: { value: { owner: TOKEN_PROGRAM_OWNER } },
    }));

    const response = await tokenAccountGet(contextFor(VALID_ADDRESS));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);

    const call = calls[0]!;
    expect(call.url).toBe(RPC_URL);
    expect(call.method).toBe("getAccountInfo");
    expect(call.params[0]).toBe(VALID_ADDRESS);
    expect(call.params[1]).toEqual({
      encoding: "base64",
      commitment: "confirmed",
    });

    // No state-changing method is ever reachable through this proxy.
    const writeMethods = [
      "sendTransaction",
      "sendRawTransaction",
      "requestAirdrop",
      "createAccount",
    ];
    expect(writeMethods).not.toContain(call.method);

    // The RPC endpoint itself is never leaked to the caller.
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(RPC_URL);
    expect(body).not.toContain("rpc.example");
  });
});
