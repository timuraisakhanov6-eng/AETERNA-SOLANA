// @vitest-environment jsdom
/**
 * AETERNA — stale pending-attempt reconciliation invariants.
 *
 * These tests pin the SAFE-RELEASE contract of
 * `reconcileStalePendingPaymentAttempt`:
 *
 *  - the record is released ONLY when the blockhash expiry AND the
 *    transaction absence are BOTH proven by direct read-only RPC
 *    facts (getBlockHeight > lastValidBlockHeight + margin AND both
 *    getSignatureStatuses(history) and getTransaction silent);
 *  - the record is KEPT (fail closed) on every uncertain outcome:
 *    transport errors, unreadable bodies, contradictory lookups,
 *    missing/expired margins, missing record fields;
 *  - a known signature status or a found transaction never releases
 *    the record;
 *  - release can never race: a record replaced between the on-chain
 *    reads and the release is left untouched;
 *  - records without a transactionId are never touched.
 *
 * Everything runs in the jsdom environment with a stubbed localStorage
 * and an injected RPC transport — no network, no real Solana RPC.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PENDING_ATTEMPT_RECONCILE_MARGIN_BLOCKS,
  reconcileStalePendingPaymentAttempt,
  type PendingAttemptRpcTransport,
} from "./pendingAttemptRecovery";
import {
  clearPendingPaymentAttempt,
  readPendingPaymentAttempt,
  writePendingPaymentAttempt,
} from "./pendingPaymentAttempt";

const INTENT = "intent-reconcile-1";
const EXPIRED_HEIGHT = 262236000;
/** Realistic Solana signature shape (base58, {64,88} chars). */
const TX =
  "5YvEKgAAexampleSignatureStringForHistorySearch115hZd5d5d5d5d5d5d5d5d5d5d5d";

function seedPendingRecord(overrides: {
  transactionId?: string | null;
  lastValidBlockHeight?: number | null;
  outcome?: "submitted" | "unknown";
} = {}): void {
  const hasSignature =
    overrides.transactionId === undefined ||
    overrides.transactionId !== null;
  const persisted = writePendingPaymentAttempt({
    version: 2,
    paymentIntentId: INTENT,
    creatorIdentityId: "identity-1",
    network: "solana",
    account: "SomeAccount11111111111111111111111111111111",
    transactionId:
      overrides.transactionId === undefined ? TX : overrides.transactionId,
    signedTransaction: hasSignature ? "bW9jay1zaWduZWQ=" : null,
    blockhash: hasSignature ? "blk-1" : null,
    lastValidBlockHeight:
      overrides.lastValidBlockHeight === undefined
        ? EXPIRED_HEIGHT
        : overrides.lastValidBlockHeight,
    outcome: overrides.outcome ?? "submitted",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  expect(persisted).toBe(true);
}

/**
 * RPC answer table: per-method result, `{ throws }` for an uncertain
 * transport, or nothing at all (also uncertain).
 */
type RpcAnswers = Partial<
  Record<
    "getBlockHeight" | "getSignatureStatuses" | "getTransaction",
    unknown | { throws: Error }
  >
>;

function transportWith(answers: RpcAnswers): PendingAttemptRpcTransport {
  return async (method, params) => {
    const answer = answers[method as keyof RpcAnswers];
    if (answer && typeof answer === "object" && "throws" in answer) {
      throw answer.throws;
    }
    if (answer === undefined) {
      throw new Error(
        `UNEXPECTED_RPC_METHOD: ${method} ${JSON.stringify(params)}`
      );
    }
    return answer;
  };
}

/** Transport wrapper: runs a side effect before the getTransaction answer. */
function transportWithMidflight(
  answers: RpcAnswers,
  sideEffect: () => void
): PendingAttemptRpcTransport {
  const inner = transportWith(answers);
  return async (method, params) => {
    if (method === "getTransaction") {
      sideEffect();
    }
    return inner(method, params);
  };
}

const SILENT_HISTORY = { context: { slot: 1 }, value: [null] };
const KNOWN_CONFIRMED_STATUS = {
  context: { slot: 2 },
  value: [{ slot: 123, confirmations: "1", err: null, status: "ok" }],
};
const KNOWN_FAILED_STATUS = {
  context: { slot: 2 },
  value: [{ slot: 123, confirmations: null, err: { InstructionError: [0, 0] } }],
};

beforeEach(() => {
  clearPendingPaymentAttempt();
});

afterEach(() => {
  clearPendingPaymentAttempt();
});

describe("pending-attempt reconciliation — safe release", () => {
  it("releases ONLY when expiry + history silence + ledger silence all hold", async () => {
    seedPendingRecord({ lastValidBlockHeight: EXPIRED_HEIGHT });

    const outcome = await reconcileStalePendingPaymentAttempt({
      rpcTransport: transportWith({
        // Finalized height exhausted the window PLUS the safety margin.
        getBlockHeight: EXPIRED_HEIGHT + PENDING_ATTEMPT_RECONCILE_MARGIN_BLOCKS + 1,
        getSignatureStatuses: SILENT_HISTORY,
        getTransaction: null,
      }),
    });

    expect(outcome.status).toBe("released");
    expect(outcome.releaseReason).toBe("EXPIRED_AND_ABSENT");
    expect(readPendingPaymentAttempt()).toBeNull();
  });

  it("keeps the record while the blockhash window is still alive — even though history and the ledger are silent", async () => {
    seedPendingRecord({ lastValidBlockHeight: EXPIRED_HEIGHT });

    const outcome = await reconcileStalePendingPaymentAttempt({
      rpcTransport: transportWith({
        // Exactly AT the margin: `height <= lastValid + margin` keeps.
        getBlockHeight: EXPIRED_HEIGHT + PENDING_ATTEMPT_RECONCILE_MARGIN_BLOCKS,
        getSignatureStatuses: SILENT_HISTORY,
        getTransaction: null,
      }),
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("BLOCKHASH_WINDOW_NOT_PROVABLY_EXPIRED");
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
  });
});

describe("pending-attempt reconciliation — fail closed", () => {
  it("never releases when the RPC is unavailable (height)", async () => {
    seedPendingRecord();

    const outcome = await reconcileStalePendingPaymentAttempt({
      rpcTransport: transportWith({
        getBlockHeight: { throws: new Error("rpc down") },
      }),
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("BLOCK_HEIGHT_UNAVAILABLE");
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
  });

  it("never releases when the RPC is unavailable (status search)", async () => {
    seedPendingRecord({ lastValidBlockHeight: EXPIRED_HEIGHT });

    const outcome = await reconcileStalePendingPaymentAttempt({
      rpcTransport: transportWith({
        getBlockHeight: 999999999,
        getSignatureStatuses: { throws: new Error("history down") },
      }),
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("SIGNATURE_STATUS_UNAVAILABLE");
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
  });

  it("never releases when the RPC is unavailable (transaction lookup)", async () => {
    seedPendingRecord({ lastValidBlockHeight: EXPIRED_HEIGHT });

    const outcome = await reconcileStalePendingPaymentAttempt({
      rpcTransport: transportWith({
        getBlockHeight: 999999999,
        getSignatureStatuses: SILENT_HISTORY,
        getTransaction: { throws: new Error("ledger down") },
      }),
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("TRANSACTION_LOOKUP_UNAVAILABLE");
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
  });

  it("never releases on an unreadable height value", async () => {
    for (const height of [0, 1.5, "262236000", null]) {
      seedPendingRecord();

      const outcome = await reconcileStalePendingPaymentAttempt({
        rpcTransport: transportWith({ getBlockHeight: height }),
      });

      expect(outcome.status).toBe("kept");
      expect(outcome.reason).toBe("BLOCK_HEIGHT_UNREADABLE");
      expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
      clearPendingPaymentAttempt();
    }
  });

  it("never releases on an unreadable signature-history body", async () => {
    for (const statuses of [
      null,
      {},
      { context: { slot: 1 } },
      { value: [] },
      { value: ["garbage"] },
    ]) {
      seedPendingRecord();

      const outcome = await reconcileStalePendingPaymentAttempt({
        rpcTransport: transportWith({
          getBlockHeight: 999999999,
          getSignatureStatuses: statuses,
        }),
      });

      expect(outcome.status).toBe("kept");
      expect(outcome.reason).toBe("SIGNATURE_STATUS_UNREADABLE");
      expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
      clearPendingPaymentAttempt();
    }
  });

  it("keeps the record when the lookups contradict (history silent, ledger HAS the transaction)", async () => {
    seedPendingRecord();

    const outcome = await reconcileStalePendingPaymentAttempt({
      rpcTransport: transportWith({
        getBlockHeight: 999999999,
        getSignatureStatuses: SILENT_HISTORY,
        getTransaction: { slot: 123, meta: { err: null } },
      }),
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("TRANSACTION_FOUND");
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
  });

  it("keeps the record when the transactionId is unusable (never reaches the RPC)", async () => {
    seedPendingRecord({ transactionId: "SHORT" });

    const observed: string[] = [];
    const outcome = await reconcileStalePendingPaymentAttempt({
      rpcTransport: async (method) => {
        observed.push(method);
        return null;
      },
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("TRANSACTION_ID_UNUSABLE");
    expect(observed).toHaveLength(0);
    expect(readPendingPaymentAttempt()?.transactionId).toBe("SHORT");
  });

  it("keeps the record when lastValidBlockHeight was never recorded", async () => {
    seedPendingRecord({ lastValidBlockHeight: null });

    const outcome = await reconcileStalePendingPaymentAttempt({
      rpcTransport: transportWith({ getBlockHeight: 999999999 }),
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("BLOCKHASH_WINDOW_UNPROVABLE");
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
  });

  it("does not clear a record that was replaced between the on-chain reads and the release", async () => {
    seedPendingRecord();

    const outcome = await reconcileStalePendingPaymentAttempt({
      rpcTransport: transportWithMidflight(
        {
          getBlockHeight: 999999999,
          getSignatureStatuses: SILENT_HISTORY,
          getTransaction: null,
        },
        () => {
          // Replaces the pointer mid-flight, exactly like an overlapping
          // process would, taking the on-chain reads off guard.
          writePendingPaymentAttempt({
            version: 2,
            paymentIntentId: "intent-OTHER",
            creatorIdentityId: "identity-1",
            network: "solana",
            account: "SomeAccount11111111111111111111111111111111",
            transactionId: TX,
            signedTransaction: "bW9jay1zaWduZWQ=",
            blockhash: "blk-1",
            lastValidBlockHeight: EXPIRED_HEIGHT,
            outcome: "submitted",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      ),
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("PENDING_RECORD_CHANGED_DURING_RECONCILIATION");
    // The replaced record is NOT cleared by a reconciliation built for
    // the previous one.
    expect(readPendingPaymentAttempt()?.paymentIntentId).toBe("intent-OTHER");
  });
});

describe("pending-attempt reconciliation — existing transactions", () => {
  it("never clears the record when the signature status is known (confirmed)", async () => {
    seedPendingRecord();

    const outcome = await reconcileStalePendingPaymentAttempt({
      rpcTransport: transportWith({
        getBlockHeight: 999999999,
        getSignatureStatuses: KNOWN_CONFIRMED_STATUS,
      }),
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("TRANSACTION_STATUS_KNOWN");
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
  });

  it("never clears the record when the signature status is known (FAILED on-chain)", async () => {
    seedPendingRecord();

    const outcome = await reconcileStalePendingPaymentAttempt({
      rpcTransport: transportWith({
        getBlockHeight: 999999999,
        getSignatureStatuses: KNOWN_FAILED_STATUS,
      }),
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("TRANSACTION_STATUS_KNOWN");
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
  });
});

describe("pending-attempt reconciliation — untouched records", () => {
  it("does nothing when there is no pending record", async () => {
    const outcome = await reconcileStalePendingPaymentAttempt({
      rpcTransport: transportWith({ getBlockHeight: 1 }),
    });

    expect(outcome.status).toBe("no_pending_record");
  });

  it("never touches a record without a transactionId (unknown outcome)", async () => {
    seedPendingRecord({ transactionId: null, outcome: "unknown" });

    const observed: string[] = [];
    const outcome = await reconcileStalePendingPaymentAttempt({
      rpcTransport: async (method) => {
        observed.push(method);
        return null;
      },
    });

    expect(outcome.status).toBe("no_transaction_to_recover");
    expect(observed).toHaveLength(0);
    const remaining = readPendingPaymentAttempt();
    expect(remaining?.outcome).toBe("unknown");
    expect(remaining?.transactionId).toBeNull();
  });
});

describe("pending-attempt reconciliation — bounded transient retries", () => {
  it("retries a TRANSIENT height failure ONCE, then proceeds with the safe checks", async () => {
    seedPendingRecord({ lastValidBlockHeight: EXPIRED_HEIGHT });

    let heightCalls = 0;
    const outcome = await reconcileStalePendingPaymentAttempt({
      retryDelayMs: 0,
      rpcTransport: async (method) => {
        if (method === "getBlockHeight") {
          heightCalls += 1;
          if (heightCalls === 1) {
            // Exactly the proxy's transient edge signal.
            throw new Error("SOLANA_RPC_HTTP_502");
          }
          return (
            EXPIRED_HEIGHT + PENDING_ATTEMPT_RECONCILE_MARGIN_BLOCKS + 1
          );
        }
        if (method === "getSignatureStatuses") return SILENT_HISTORY;
        return null; // getTransaction
      },
    });

    expect(outcome.status).toBe("released");
    expect(outcome.releaseReason).toBe("EXPIRED_AND_ABSENT");
    // The transient blip consumed exactly one extra attempt — no more.
    expect(heightCalls).toBe(2);
  });

  it("keeps the record and reports a transport outage after the retries are exhausted (HTTP 429)", async () => {
    seedPendingRecord();

    let heightCalls = 0;
    const outcome = await reconcileStalePendingPaymentAttempt({
      retryDelayMs: 0,
      rpcTransport: async (method) => {
        if (method === "getBlockHeight") {
          heightCalls += 1;
          throw new Error("SOLANA_RPC_HTTP_429");
        }
        throw new Error(`UNEXPECTED_RPC_METHOD: ${method}`);
      },
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("BLOCK_HEIGHT_UNAVAILABLE");
    expect(outcome.transportUnavailable).toBe(true);
    // Bounded: one initial read plus one retry, then STOP.
    expect(heightCalls).toBe(2);
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
  });

  it("bounds the retries for a transient 5xx on the status lookup", async () => {
    seedPendingRecord({ lastValidBlockHeight: EXPIRED_HEIGHT });

    let statusCalls = 0;
    const outcome = await reconcileStalePendingPaymentAttempt({
      retryDelayMs: 0,
      rpcTransport: async (method) => {
        if (method === "getBlockHeight") return 999999999;
        if (method === "getSignatureStatuses") {
          statusCalls += 1;
          throw new Error("SOLANA_RPC_HTTP_503");
        }
        throw new Error(`UNEXPECTED_RPC_METHOD: ${method}`);
      },
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("SIGNATURE_STATUS_UNAVAILABLE");
    expect(outcome.transportUnavailable).toBe(true);
    expect(statusCalls).toBe(2);
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
  });

  it("does NOT retry a NON-transient refusal and never calls it a network outage", async () => {
    seedPendingRecord();

    let heightCalls = 0;
    const outcome = await reconcileStalePendingPaymentAttempt({
      retryDelayMs: 0,
      rpcTransport: async (method) => {
        if (method === "getBlockHeight") {
          heightCalls += 1;
          // A 4xx other than 429 is a configuration/bug signal.
          throw new Error("SOLANA_RPC_HTTP_400");
        }
        throw new Error(`UNEXPECTED_RPC_METHOD: ${method}`);
      },
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("BLOCK_HEIGHT_UNAVAILABLE");
    expect(outcome.transportUnavailable).toBeFalsy();
    expect(heightCalls).toBe(1);
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
  });

  it("never retries a SUCCESSFUL `null` answer — absence is an observation, not an error", async () => {
    seedPendingRecord({ lastValidBlockHeight: EXPIRED_HEIGHT });

    const calls: string[] = [];
    const outcome = await reconcileStalePendingPaymentAttempt({
      retryDelayMs: 0,
      rpcTransport: async (method) => {
        calls.push(method);
        if (method === "getBlockHeight") {
          return EXPIRED_HEIGHT + PENDING_ATTEMPT_RECONCILE_MARGIN_BLOCKS + 1;
        }
        if (method === "getSignatureStatuses") return SILENT_HISTORY;
        return null;
      },
    });

    expect(outcome.status).toBe("released");
    // Each read happened exactly once: a definitive `null` is never re-read.
    expect(calls).toEqual([
      "getBlockHeight",
      "getSignatureStatuses",
      "getTransaction",
    ]);
  });

  it("a transient transport outage can only DELAY a release, never cause one", async () => {
    seedPendingRecord({ lastValidBlockHeight: EXPIRED_HEIGHT });

    const outcome = await reconcileStalePendingPaymentAttempt({
      retryDelayMs: 0,
      rpcTransport: async (method) => {
        if (method === "getBlockHeight") return 999999999;
        if (method === "getSignatureStatuses") return SILENT_HISTORY;
        throw new Error("SOLANA_RPC_HTTP_504"); // getTransaction blocked
      },
    });

    expect(outcome.status).toBe("kept");
    expect(outcome.reason).toBe("TRANSACTION_LOOKUP_UNAVAILABLE");
    expect(outcome.transportUnavailable).toBe(true);
    // Both proof checks were blocked, so the pointer survives.
    expect(readPendingPaymentAttempt()?.transactionId).toBe(TX);
  });
});
