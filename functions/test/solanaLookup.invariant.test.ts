/**
 * AETERNA — Solana transaction lookup invariants (payment reliability).
 *
 * Verification runs immediately after the wallet returns a signature, but a
 * freshly landed transaction is only observable at `confirmed` — it is not
 * `finalized` for a further ~6-15s. A `finalized`-only lookup therefore
 * reported legitimate, landed payments as missing (TX_NOT_FOUND).
 *
 * Proves:
 *   - the lookup asks for `confirmed` (so a landed tx verifies without waiting
 *     for finalization);
 *   - a not-yet-observable transaction is retried within a bounded window and
 *     then reported as missing (never as a payment);
 *   - an RPC error propagates and is NEVER converted into success;
 *   - signature parsing is preserved (jsonParsed, maxSupportedTransactionVersion 0).
 *
 * Global fetch is stubbed at the RPC boundary only; the real helper runs.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { getSolanaTransaction } from "./../lib/solana/rpc";

const RPC_URL = "https://rpc.example.invalid";
const SIGNATURE = "5".repeat(88);

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

function txParams(call: RecordedCall): Record<string, unknown> {
  return call.params[1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("getSolanaTransaction — commitment and bounded lookup", () => {
  it("1. a confirmed transaction is returned without waiting for finalization", async () => {
    const { calls } = stubRpc(() => ({
      jsonrpc: "2.0",
      id: 1,
      result: { slot: 449484527, meta: { err: null } },
    }));

    const pending = getSolanaTransaction(RPC_URL, SIGNATURE);
    await vi.advanceTimersByTimeAsync(0);
    const tx = await pending;

    expect(tx).toEqual({ slot: 449484527, meta: { err: null } });

    // Exactly one lookup, at `confirmed` — no finalization wait.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("getTransaction");
    expect(txParams(calls[0]!)).toMatchObject({
      commitment: "confirmed",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
    });
    expect(txParams(calls[0]!).commitment).not.toBe("finalized");
  });

  it("2. a not-yet-observable transaction is retried, then reported missing", async () => {
    const { fetchMock, calls } = stubRpc(() => ({
      jsonrpc: "2.0",
      id: 1,
      result: null,
    }));

    const pending = getSolanaTransaction(RPC_URL, SIGNATURE);
    await vi.advanceTimersByTimeAsync(60_000);
    const tx = await pending;

    // Never fabricated into a payment.
    expect(tx).toBeNull();
    // Retried more than once (the old 4-attempt/3s budget was the defect).
    expect(calls.length).toBeGreaterThan(1);
    // Bounded: it does not poll forever.
    expect(fetchMock.mock.calls.length).toBeLessThan(60);
  });

  it("3. a late-landing transaction is still found within the window", async () => {
    let attempt = 0;
    const { calls } = stubRpc(() => {
      attempt += 1;
      return {
        jsonrpc: "2.0",
        id: 1,
        // Missing for the first few polls, then observable at confirmed.
        result: attempt < 4 ? null : { slot: 449484600, meta: { err: null } },
      };
    });

    const pending = getSolanaTransaction(RPC_URL, SIGNATURE);
    await vi.advanceTimersByTimeAsync(60_000);
    const tx = await pending;

    expect(tx).toEqual({ slot: 449484600, meta: { err: null } });
    expect(calls).toHaveLength(4);
  });

  it("4. an RPC error propagates — never converted into success", async () => {
    stubRpc(() => ({
      jsonrpc: "2.0",
      id: 1,
      error: { message: "RPC_DOWN" },
    }));

    const pending = getSolanaTransaction(RPC_URL, SIGNATURE);
    // Attach the rejection handler before advancing so it is not unhandled.
    const settled = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await settled;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("RPC_DOWN");
  });
});
