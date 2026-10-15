/**
 * AETERNA — strict signed-transaction broadcast invariants
 *
 * Proves the server half of the capture-signature-before-broadcast
 * design with REAL ed25519 test keypairs and the REAL canonical
 * transaction builder (@solana/web3.js + @solana/spl-token):
 *
 *  - only a fully signed CANONICAL payment transaction is accepted;
 *  - amount, mint, destination, payer, program set, account set and
 *    instruction shape are all validated from the compiled message;
 *  - the signature is bound to the payment attempt ATOMICALLY and
 *    BEFORE the network call, so two tabs/devices cannot broadcast two
 *    transactions for one purchase;
 *  - a replayed request is idempotent, a mismatching RPC answer fails
 *    closed, and a failed broadcast keeps the binding (never a new
 *    transaction).
 *
 * No real wallet, no real payment, no real network: the RPC transport is
 * stubbed at `globalThis.fetch`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  createFakeCreditCoordinatorBinding,
  createFakeKV,
} from "./harness";
import { onRequestPost as broadcastPost } from "../api/solana/broadcast";
import { base58Encode } from "../lib/solana/legacyTransaction";

const ORIGIN = "https://aeternacapsule.com";
const SETTLEMENT = "6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RPC_URL = "https://rpc.example.invalid";
const IDENTITY = "creator-1";
const INTENT = "intent-broadcast-1";
const BLOCKHASH = "11111111111111111111111111111111";
/** A second, equally valid 32-byte blockhash (different message). */
const ALT_BLOCKHASH = base58Encode(new Uint8Array(32).fill(2));

/** The canonical mainnet-beta genesis hash the endpoint must observe. */
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** A different chain's genesis hash (stand-in for devnet/testnet). */
const FOREIGN_GENESIS = base58Encode(new Uint8Array(32).fill(9));

const payer = Keypair.generate();
const payerAddress = payer.publicKey.toBase58();

const mint = new PublicKey(USDC_MINT);
const settlement = new PublicKey(SETTLEMENT);
const sourceAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false);
const destinationAta = getAssociatedTokenAddressSync(mint, settlement, false);

interface Env {
  SOLANA_MAINNET_RPC_URL: string;
  CREATOR_IDENTITIES: ReturnType<typeof createFakeKV>;
  CREDIT_OP_COORDINATOR: ReturnType<typeof createFakeCreditCoordinatorBinding>;
}

function buildEnv(): Env {
  const identities = createFakeKV();
  identities.put(
    `creator:identity:solana:${payerAddress}`,
    JSON.stringify({ id: IDENTITY, account: payerAddress, network: "solana" })
  );
  identities.put(`creator:identity:id:${IDENTITY}`, `solana:${payerAddress}`);
  return {
    SOLANA_MAINNET_RPC_URL: RPC_URL,
    CREATOR_IDENTITIES: identities,
    CREDIT_OP_COORDINATOR: createFakeCreditCoordinatorBinding(),
  };
}

async function call(
  coordinator: Env["CREDIT_OP_COORDINATOR"],
  name: string,
  payload: Record<string, unknown>
) {
  const stub = coordinator.get(coordinator.idFromName(name));
  const res = await stub.fetch(
    new Request("https://aeterna-credit-coordinator.invalid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

/** Reserve the purchase attempt exactly like create-quote does. */
async function reserveAttempt(env: Env) {
  await call(env.CREDIT_OP_COORDINATOR, `identity:${IDENTITY}`, {
    op: "identity-reserve-attempt",
    creatorIdentityId: IDENTITY,
    quoteId: INTENT,
    paymentIntentId: INTENT,
  });
}

/** Build + sign the canonical payment transaction (client builder shape). */
function canonicalSignedTransaction(options: {
  includeAtaCreate?: boolean;
  amount?: bigint;
  destination?: PublicKey;
  mintKey?: PublicKey;
  /** Different message => a genuinely different signature. */
  blockhash?: string;
} = {}): { base64: string; signature: string } {
  const amount = options.amount ?? 1_000_000n;
  const destination = options.destination ?? destinationAta;
  const mintKey = options.mintKey ?? mint;

  const tx = new Transaction();
  if (options.includeAtaCreate ?? true) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        destination,
        settlement,
        mintKey,
        TOKEN_PROGRAM_ID
      )
    );
  }
  tx.add(
    createTransferInstruction(
      sourceAta,
      destination,
      payer.publicKey,
      amount,
      [payer],
      TOKEN_PROGRAM_ID
    )
  );
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = options.blockhash ?? BLOCKHASH;
  tx.sign(payer);

  const signature = tx.signature ? tx.signature.toString("base64") : "";
  void signature;
  return {
    base64: tx.serialize().toString("base64"),
    // The Solana transaction signature is the base58 of the first signature.
    signature: base58Encode(new Uint8Array(tx.signatures[0]!.signature)),
  };
}

function post(env: Env, body: Record<string, unknown>) {
  return broadcastPost({
    request: {
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "origin"
            ? ORIGIN
            : name.toLowerCase() === "content-type"
            ? "application/json"
            : null,
      },
      json: async () => body,
    },
    env,
  } as never);
}

let rpcCalls: { url: string; body: unknown }[] = [];
let rpcResponder: (body: Record<string, unknown>) => unknown;

/** The JSON-RPC method a recorded call used. */
function methodOf(call: { body: unknown }): string {
  return String((call.body as Record<string, unknown> | null)?.["method"] ?? "");
}

/** Only the calls that actually carried a broadcast to the network. */
function sendCalls(): { url: string; body: unknown }[] {
  return rpcCalls.filter((c) => methodOf(c) === "sendTransaction");
}

/** A genesis probe answer, as a real node would return it. */
function genesisAnswer(body: Record<string, unknown>, hash: unknown) {
  return { jsonrpc: "2.0", id: body["id"], result: hash };
}

beforeEach(() => {
  rpcCalls = [];
  rpcResponder = (body) => {
    // The network guard probe: answer like a real mainnet-beta node.
    if (body["method"] === "getGenesisHash") {
      return genesisAnswer(body, MAINNET_GENESIS);
    }
    // Echo the submitted signature, like a real RPC would.
    const params = body["params"] as unknown[];
    const raw = String(params[0] ?? "");
    const tx = Transaction.from(Buffer.from(raw, "base64"));
    return { jsonrpc: "2.0", id: body["id"], result: base58Encode(new Uint8Array(tx.signatures[0]!.signature)) };
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: string }) => {
      rpcCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => rpcResponder(body),
      } as Response;
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("strict broadcast — canonical acceptance", () => {
  it("accepts a fully signed canonical payment and returns the transaction signature", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const { base64, signature } = canonicalSignedTransaction();

    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload["signature"]).toBe(signature);
    // The network guard runs FIRST, then the broadcast — both against the
    // SERVER-configured endpoint only.
    expect(rpcCalls.map(methodOf)).toEqual(["getGenesisHash", "sendTransaction"]);
    expect(rpcCalls.every((c) => c.url === RPC_URL)).toBe(true);
    const rpcBody = rpcCalls[1]!.body as Record<string, unknown>;
    expect(rpcBody["method"]).toBe("sendTransaction");
    // The RPC receives the SAME signed bytes that were validated.
    const params = rpcBody["params"] as unknown[];
    expect(params[0]).toBe(base64);
  });

  it("accepts the canonical transaction without the ATA-create instruction", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const { base64 } = canonicalSignedTransaction({ includeAtaCreate: false });

    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });
    expect(res.status).toBe(200);
  });

  it("ignores any client-supplied RPC URL (server configuration only)", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const { base64 } = canonicalSignedTransaction();

    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
      rpcUrl: "https://attacker.example.invalid",
      method: "sendTransaction",
    });

    expect(res.status).toBe(200);
    expect(rpcCalls.every((c) => c.url === RPC_URL)).toBe(true);
  });
});

describe("strict broadcast — content validation", () => {
  const rejections: Array<[string, () => { base64: string }]> = [
    ["a wrong amount", () => canonicalSignedTransaction({ amount: 999_999n })],
    [
      "a foreign destination",
      () =>
        canonicalSignedTransaction({
          destination: getAssociatedTokenAddressSync(mint, Keypair.generate().publicKey, false),
        }),
    ],
    [
      "a foreign mint",
      () =>
        canonicalSignedTransaction({
          mintKey: new PublicKey("So11111111111111111111111111111111111111112"),
        }),
    ],
  ];

  for (const [label, build] of rejections) {
    it(`rejects ${label}`, async () => {
      const env = buildEnv();
      await reserveAttempt(env);
      const res = await post(env, {
        paymentIntentId: INTENT,
        creatorIdentityId: IDENTITY,
        signedTransaction: build().base64,
      });
      expect(res.status).toBe(400);
      expect(rpcCalls).toHaveLength(0);
    });
  }

  it("rejects an extra instruction (unknown program)", async () => {
    const env = buildEnv();
    await reserveAttempt(env);

    const tx = new Transaction().add(
      createTransferInstruction(sourceAta, destinationAta, payer.publicKey, 1_000_000n, [payer], TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: settlement, lamports: 1 })
    );
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = BLOCKHASH;
    tx.sign(payer);

    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: tx.serialize().toString("base64"),
    });
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects a transaction signed by a wallet that is not this identity", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const { base64 } = canonicalSignedTransaction();

    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: "someone-else",
      signedTransaction: base64,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects an UNSIGNED transaction", async () => {
    const env = buildEnv();
    await reserveAttempt(env);

    const tx = new Transaction().add(
      createTransferInstruction(sourceAta, destinationAta, payer.publicKey, 1_000_000n, [payer], TOKEN_PROGRAM_ID)
    );
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = BLOCKHASH;
    // Deliberately NOT signed.

    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64"),
    });
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects an oversized payload before decoding", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: "A".repeat(2000),
    });
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("strict broadcast — signature binding", () => {
  it("binds the signature BEFORE the RPC call", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const { base64, signature } = canonicalSignedTransaction();

    await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });

    const resolved = await call(env.CREDIT_OP_COORDINATOR, `identity:${IDENTITY}`, {
      op: "identity-resolve-intent",
      creatorIdentityId: IDENTITY,
      paymentIntentId: INTENT,
    });
    expect(resolved.data["broadcastSignature"]).toBe(signature);
  });

  it("replays the SAME signature idempotently (lost response)", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const { base64, signature } = canonicalSignedTransaction();

    const first = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });
    const second = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await second.json()) as Record<string, unknown>)["signature"]).toBe(signature);
    // Both broadcasts carried byte-identical payloads.
    const sent = sendCalls().map((c) => (c.body as Record<string, unknown>)["params"] as unknown[]);
    expect(sent[0]![0]).toBe(sent[1]![0]);
  });

  it("refuses a DIFFERENT signature for the same intent (two tabs, one purchase)", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const first = canonicalSignedTransaction();
    // A second, independently signed transaction for the same intent:
    // a different message (blockhash) and therefore a different
    // signature — exactly what a second tab or device would produce.
    const second = canonicalSignedTransaction({ blockhash: ALT_BLOCKHASH });
    expect(second.signature).not.toBe(first.signature);

    const res1 = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: first.base64,
    });
    const res2 = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: second.base64,
    });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(409);
    expect(((await res2.json()) as Record<string, unknown>)["error"]).toBe(
      "SIGNATURE_ALREADY_BOUND"
    );
    // Only the first transaction ever reached the network.
    expect(sendCalls()).toHaveLength(1);
  });

  it("serializes CONCURRENT different signatures: at most one broadcast", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const a = canonicalSignedTransaction();
    const b = canonicalSignedTransaction({ blockhash: ALT_BLOCKHASH });

    const [ra, rb] = await Promise.all([
      post(env, { paymentIntentId: INTENT, creatorIdentityId: IDENTITY, signedTransaction: a.base64 }),
      post(env, { paymentIntentId: INTENT, creatorIdentityId: IDENTITY, signedTransaction: b.base64 }),
    ]);

    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(sendCalls()).toHaveLength(1);
  });

  it("never broadcasts when the attempt is already paid (granting/fulfilled)", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    await call(env.CREDIT_OP_COORDINATOR, `identity:${IDENTITY}`, {
      op: "identity-authorize-grant",
      creatorIdentityId: IDENTITY,
      quoteId: INTENT,
      paymentIntentId: INTENT,
      transactionId: "tx-1",
    });

    const { base64 } = canonicalSignedTransaction();
    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe(
      "INTENT_ALREADY_PAID"
    );
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses an unknown intent without touching the network", async () => {
    const env = buildEnv();
    const { base64 } = canonicalSignedTransaction();
    const res = await post(env, {
      paymentIntentId: "never-reserved",
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });
    expect(res.status).toBe(409);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("strict broadcast — RPC failure handling", () => {
  it("fails closed when the RPC returns a DIFFERENT signature", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const { base64 } = canonicalSignedTransaction();
    rpcResponder = (body) =>
      body["method"] === "getGenesisHash"
        ? genesisAnswer(body, MAINNET_GENESIS)
        : {
            jsonrpc: "2.0",
            id: 1,
            result: "SomeOtherSignatureThatIsNotOurs111111111111111",
          };

    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe(
      "RPC_SIGNATURE_MISMATCH"
    );
  });

  it("keeps the binding when the RPC fails (never a new transaction)", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const { base64, signature } = canonicalSignedTransaction();
    // The network guard SUCCEEDS; only the broadcast itself fails.
    rpcResponder = (body) =>
      body["method"] === "getGenesisHash"
        ? genesisAnswer(body, MAINNET_GENESIS)
        : {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32002, message: "Transaction simulation failed" },
          };

    const failed = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });
    expect(failed.status).toBe(502);

    // The signature stayed bound, so the retry resumes the SAME bytes.
    const resolved = await call(env.CREDIT_OP_COORDINATOR, `identity:${IDENTITY}`, {
      op: "identity-resolve-intent",
      creatorIdentityId: IDENTITY,
      paymentIntentId: INTENT,
    });
    expect(resolved.data["broadcastSignature"]).toBe(signature);

    rpcResponder = (body) => {
      if (body["method"] === "getGenesisHash") {
        return genesisAnswer(body, MAINNET_GENESIS);
      }
      const params = body["params"] as unknown[];
      const tx = Transaction.from(Buffer.from(String(params[0]), "base64"));
      return { jsonrpc: "2.0", id: body["id"], result: base58Encode(new Uint8Array(tx.signatures[0]!.signature)) };
    };
    const retried = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });
    expect(retried.status).toBe(200);
    // The retry sent byte-identical payloads.
    const sent = sendCalls().map((c) => (c.body as Record<string, unknown>)["params"] as unknown[]);
    expect(sent[0]![0]).toBe(sent[1]![0]);
  });

  it("treats an already-processed transaction as an idempotent success", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const { base64, signature } = canonicalSignedTransaction();
    rpcResponder = (body) =>
      body["method"] === "getGenesisHash"
        ? genesisAnswer(body, MAINNET_GENESIS)
        : {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32002, message: "This transaction has already been processed" },
          };

    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)["signature"]).toBe(signature);
  });
});

describe("strict broadcast — network guard", () => {
  it("refuses to broadcast when the configured RPC is NOT mainnet-beta", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const { base64 } = canonicalSignedTransaction();
    rpcResponder = (body) =>
      body["method"] === "getGenesisHash"
        ? genesisAnswer(body, FOREIGN_GENESIS)
        : genesisAnswer(body, "should-never-be-called");

    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe(
      "RPC_NETWORK_MISMATCH"
    );
    // Nothing reached the network...
    expect(sendCalls()).toHaveLength(0);
    // ...and nothing was bound either: the attempt is untouched, so the
    // SAME signature can still be broadcast once the endpoint is fixed.
    const resolved = await call(env.CREDIT_OP_COORDINATOR, `identity:${IDENTITY}`, {
      op: "identity-resolve-intent",
      creatorIdentityId: IDENTITY,
      paymentIntentId: INTENT,
    });
    expect(resolved.data["broadcastSignature"]).toBeNull();
    expect(resolved.data["state"]).toBe("reserved");
  });

  it("fails closed when the network cannot be determined (unusable probe answer)", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const { base64 } = canonicalSignedTransaction();
    rpcResponder = (body) =>
      body["method"] === "getGenesisHash"
        ? genesisAnswer(body, null)
        : genesisAnswer(body, "should-never-be-called");

    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe(
      "RPC_NETWORK_UNDETERMINED"
    );
    expect(sendCalls()).toHaveLength(0);
  });

  it("fails closed when the network probe is unavailable (RPC unreachable)", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const { base64 } = canonicalSignedTransaction();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("RPC_UNREACHABLE");
      })
    );

    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
    });

    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe(
      "RPC_NETWORK_UNAVAILABLE"
    );
    // A failed probe is NOT proof of network: nothing was bound either.
    const resolved = await call(env.CREDIT_OP_COORDINATOR, `identity:${IDENTITY}`, {
      op: "identity-resolve-intent",
      creatorIdentityId: IDENTITY,
      paymentIntentId: INTENT,
    });
    expect(resolved.data["broadcastSignature"]).toBeNull();
  });

  it("ignores a client-supplied cluster/genesis hint (server constant only)", async () => {
    const env = buildEnv();
    await reserveAttempt(env);
    const { base64, signature } = canonicalSignedTransaction();

    const res = await post(env, {
      paymentIntentId: INTENT,
      creatorIdentityId: IDENTITY,
      signedTransaction: base64,
      // A caller trying to move the expected network: all ignored.
      cluster: "devnet",
      genesisHash: FOREIGN_GENESIS,
      network: "solana-devnet",
      rpcUrl: "https://attacker.example.invalid",
    });

    // The server compares its OWN constant against the real node, so the
    // hints change nothing: the canonical transaction still broadcasts.
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)["signature"]).toBe(signature);
    expect(rpcCalls.map(methodOf)).toEqual(["getGenesisHash", "sendTransaction"]);
    expect(rpcCalls.every((c) => c.url === RPC_URL)).toBe(true);
  });
});
