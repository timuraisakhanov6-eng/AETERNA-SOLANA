/**
 * AETERNA — ExecutorTransport (Irys, Cloudflare Workers runtime)
 *
 * Replaces the Node-only @irys/upload SDK, which cannot run on
 * Cloudflare Workers because it pulls in @irys/bundles' Node
 * entrypoint (tmp-promise → fs.realpathSync, unimplemented on
 * workerd — see AETERNA canonical handoff notes).
 *
 * This module talks to the Irys node directly:
 *
 *   - price / balance reads  → plain HTTP GET against the node
 *   - funding                → a normal EVM transaction, signed and
 *                               sent with `ethers` (already a project
 *                               dependency, already used identically
 *                               in functions/lib/executorHot.ts)
 *   - data item construction
 *     and signing             → `arbundles/web`, the same library
 *                               @irys/upload uses internally, but its
 *                               *browser* build. The browser build has
 *                               no fs/tmp-promise dependency — it
 *                               builds and signs the ANS-104 data item
 *                               entirely in memory using Web Crypto —
 *                               and is therefore safe on workerd. Only
 *                               the Node build was ever the problem.
 *   - publication             → one HTTP POST of the signed, raw data
 *                               item bytes to the node's /tx endpoint.
 *
 * This file is the ONLY thing that may change per the AETERNA Freeze.
 * It exports createExecutorTransport() with the exact call signature
 * and return-value contract that functions/lib/executorHot.ts (frozen)
 * already depends on — see IrysRuntime in ./types.ts for that contract.
 *
 * Nothing here may be imported by, or leak into, any other layer.
 */

import type { IrysRuntime, AtomicAmountLike, UploadTag, UploadReceipt } from "./types";

/* ================= CONSTANTS ================= */

// Canonical Irys mainnet node — matches the value already documented
// in wrangler.toml's Executor Hot section. Executor Hot itself does
// not pass this through createExecutorTransport()'s arguments (its
// own IRYS_NODE_URL constant is dead code left over from the SDK
// migration), so the transport owns it directly.
const IRYS_NODE_URL = "https://node1.irys.xyz";

// Irys uploads for AETERNA are funded via Base Mainnet ETH — matches
// wrangler.toml and the RPC/chain choice already made in executorHot.ts.
const IRYS_TOKEN = "base-eth";

const IRYS_HTTP_TIMEOUT_MS = 15_000;

/* ================= HTTP HELPERS ================= */

// Cap on how much of a response body is ever included in an error
// message or diagnostic log. This is diagnostic text only — never
// capability material — but the node is an external, untrusted peer,
// so its response is bounded before it touches logs regardless.
const IRYS_ERROR_BODY_PREVIEW_MAX = 300;

async function irysFetch(path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IRYS_HTTP_TIMEOUT_MS);

  try {
    return await fetch(`${IRYS_NODE_URL}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function previewBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > IRYS_ERROR_BODY_PREVIEW_MAX
      ? `${text.slice(0, IRYS_ERROR_BODY_PREVIEW_MAX)}…`
      : text;
  } catch {
    return "";
  }
}

/**
 * Fetches `path`, and on either a non-2xx status OR a response body
 * that fails `parse`, throws an Error whose message embeds the HTTP
 * status and a bounded preview of the raw body. This is what makes
 * the first live deploy self-diagnosing: if the node's response
 * shape for /price, /account/balance, or /info differs from what's
 * assumed here, the resulting error tells you exactly what came
 * back instead of just "it didn't work".
 */
async function irysFetchAndParse<T>(
  path: string,
  errorCode: string,
  parse: (res: Response) => Promise<T>,
): Promise<T> {
  const res = await irysFetch(path);

  if (!res.ok) {
    const body = await previewBody(res);
    throw new Error(
      `${errorCode}_HTTP_${res.status}${body ? `: ${body}` : ""}`,
    );
  }

  // Clone so a JSON-parse failure can still fall back to reading the
  // raw body for the error message (a body can only be read once).
  const clone = res.clone();
  try {
    return await parse(res);
  } catch (err) {
    const body = await previewBody(clone);
    throw new Error(
      `${errorCode}_INVALID_RESPONSE${body ? `: ${body}` : ""} (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
}

/* ================= ATOMIC AMOUNT ================= */

/**
 * Minimal integer-atomic-unit amount type satisfying AtomicAmountLike.
 *
 * The legacy @irys/sdk client returned BigNumber.js instances here.
 * Executor Hot only ever calls multipliedBy() with a small integer
 * multiplier (IRYS_FUNDING_MULTIPLIER = 2), minus(), isLessThan(), and
 * toString() — see the IrysRuntime doc comment in ./types.ts. A plain
 * BigInt wrapper covers that exact contract without pulling in a
 * decimal math dependency for what is, in practice, integer wei/atomic
 * arithmetic.
 */
class AtomicAmount implements AtomicAmountLike {
  private readonly value: bigint;

  constructor(value: bigint | string | number) {
    this.value = typeof value === "bigint" ? value : BigInt(value);
  }

  multipliedBy(multiplier: number): AtomicAmount {
    if (!Number.isInteger(multiplier)) {
      throw new Error("ATOMIC_AMOUNT_NONINTEGER_MULTIPLIER");
    }
    return new AtomicAmount(this.value * BigInt(multiplier));
  }

  minus(other: AtomicAmountLike): AtomicAmount {
    return new AtomicAmount(this.value - BigInt(other.toString()));
  }

  isLessThan(other: AtomicAmountLike): boolean {
    return this.value < BigInt(other.toString());
  }

  toString(): string {
    return this.value.toString();
  }
}

/* ================= NODE INFO ================= */

interface IrysNodeInfo {
  addresses?: Record<string, string>;
}

let cachedFundingAddress: string | null = null;

async function getFundingAddress(): Promise<string> {
  if (cachedFundingAddress) return cachedFundingAddress;

  const info = await irysFetchAndParse("/info", "IRYS_INFO", async (res) => {
    const body = (await res.json()) as IrysNodeInfo;
    if (typeof body !== "object" || body === null) {
      throw new Error("not a JSON object");
    }
    return body;
  });

  const address = info.addresses?.[IRYS_TOKEN];

  if (!address || typeof address !== "string") {
    throw new Error("IRYS_FUNDING_ADDRESS_UNAVAILABLE");
  }

  cachedFundingAddress = address;
  return address;
}

/**
 * Raw bigint read of the Irys node's reported prepaid balance for
 * `queryAddress`. Shared by utils.getBalance() (which wraps it in
 * the AtomicAmountLike interface executorHot.ts expects) and by
 * fund()'s internal sync-wait below, which needs plain bigint math
 * to compare against a target rather than the wrapper type.
 */
async function getBalanceAtomic(queryAddress: string): Promise<bigint> {
  const value = await irysFetchAndParse(
    `/account/balance/${IRYS_TOKEN}?address=${encodeURIComponent(queryAddress)}`,
    "IRYS_BALANCE",
    async (res) => {
      const body = (await res.json()) as { balance?: unknown };
      if (typeof body.balance !== "string" && typeof body.balance !== "number") {
        throw new Error("missing/non-numeric 'balance' field");
      }
      return String(body.balance);
    },
  );
  return BigInt(value);
}

// How long fund() itself will wait, after the on-chain deposit
// confirms, for the Irys node's own balance endpoint to reflect it.
//
// Root cause this addresses: executorHot.ts (frozen — see file
// header) polls node-side balance sync for only 10 attempts / 2s
// each (20s total) after fund() returns, then gives up with
// EXECUTOR_FUNDING_SYNC_TIMEOUT. In production that 20s window is
// frequently shorter than the node's real indexing lag for a fresh
// Base-mainnet deposit, so uploads were failing closed (safely, but
// unnecessarily) even though the funds had already landed. Since
// executorHot.ts cannot be changed, fund() instead absorbs the wait
// itself: it doesn't return until the node's balance has actually
// caught up (or this generous ceiling is reached), so the frozen
// poll loop in executorHot.ts almost always succeeds on its very
// first check afterward.
const FUNDING_SYNC_POLL_INTERVAL_MS = 3_000;
const FUNDING_SYNC_MAX_WAIT_MS = 90_000;

/* ================= TRANSPORT ================= */

export async function createExecutorTransport(
  privateKey: string,
  rpcUrl: string,
): Promise<IrysRuntime> {
  // Loaded dynamically, mirroring the existing dynamic `import("ethers")`
  // in executorHot.ts — keeps these out of the cold-start path for
  // requests that never reach publication.
  const { Wallet, JsonRpcProvider } = await import("ethers");

  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);

  const fromHex = (hex: string): Uint8Array => {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  };

  const base64urlEncode = (bytes: Uint8Array): string => {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  };

  // Replaces the removed `arbundles/web` runtime dependency.
  // This local builder is byte-for-byte compatible with arbundles'
  // EthereumSigner + createData() and runs on Cloudflare Workers
  // via WebCrypto/ethers pure-JS primitives.
  let ans104OwnerBytes: Uint8Array | null = null;
  let ans104OwnerHex: string | null = null;

  async function buildAns104DataItem(
    data: Uint8Array,
    tags: UploadTag[],
  ): Promise<{ raw: Uint8Array; id: string }> {
    const signingWallet = new Wallet(privateKey, provider);

    // Owner / public key: 65-byte uncompressed secp256k1 pubkey
    const ownerHex = signingWallet.signingKey.publicKey.slice(2); // strip 0x
    if (ans104OwnerHex !== ownerHex) {
      ans104OwnerHex = ownerHex;
      ans104OwnerBytes = fromHex(ownerHex);
    }
    const owner = ans104OwnerBytes!;

    // AVSC TAP tag serialization, byte-for-byte identical to
    // arbundles `serializeTags`.
    const serializeTags = (list: UploadTag[]): Uint8Array => {
      const out: number[] = [];
      const writeLong = (n: number) => {
        const v = n < 0 ? (~n << 1) | 1 : n << 1;
        let m = v;
        while (m > 0x7f) {
          out.push((m & 0x7f) | 0x80);
          m >>>= 7;
        }
        out.push(m);
      };
      const writeString = (s: string) => {
        const bytes = new TextEncoder().encode(s);
        writeLong(bytes.byteLength);
        for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
      };
      writeLong(list.length);
      for (const t of list) {
        writeString(t.name);
        writeString(t.value);
      }
      out.push(0);
      return Uint8Array.from(out);
    };

    const _tags = serializeTags(tags);
    const _data = data;
    const signatureLength = 65;
    const ownerLength = 65;
    const target_length = 1;
    const anchor_length = 1;
    const tags_length = 16 + _tags.byteLength;
    const data_length = _data.byteLength;
    const length =
      2 +
      signatureLength +
      ownerLength +
      target_length +
      anchor_length +
      tags_length +
      data_length;
    const bytes = new Uint8Array(length);

    bytes.set(new Uint8Array([0x00, 0x03]), 0);

    bytes.set(owner, 67);

    bytes[132] = 0; // no target
    bytes[133] = 0; // no anchor

    const tags_start = 134;
    const tagsCountBytes = new Uint8Array(8);
    let tagsCount = tags.length;

    for (let i = 0; i < 8; i++) {
      tagsCountBytes[i] = tagsCount & 0xff;
      tagsCount = Math.floor(tagsCount / 256);
    }

    bytes.set(tagsCountBytes, tags_start); // tagsCount = tags.length, LE
    bytes.set(
      new Uint8Array([_tags.byteLength, 0, 0, 0, 0, 0, 0, 0]),
      tags_start + 8,
    ); // tagsSize, LE
    bytes.set(_tags, tags_start + 16);

    const data_start = tags_start + 16 + _tags.byteLength;
    bytes.set(_data, data_start);

    // SHA-384 deepHash of the 8-element ANS-104 list.
    const sha384 = async (buf: BufferSource): Promise<Uint8Array> => {
      return Uint8Array.from(await crypto.subtle.digest("SHA-384", buf));
    };

    const deepHash = async (input: unknown): Promise<Uint8Array> => {
      if (
        input instanceof Uint8Array ||
        typeof input === "string" ||
        ArrayBuffer.isView(input)
      ) {
        const len =
          typeof input === "string"
            ? new TextEncoder().encode(input).byteLength
            : input.byteLength;
        const tag = new Uint8Array([
          ...new TextEncoder().encode("blob"),
          ...new TextEncoder().encode(String(len)),
        ]);
        const payload =
          typeof input === "string"
            ? new TextEncoder().encode(input)
            : new Uint8Array(input);
        const tagged = new Uint8Array([
          ...await sha384(tag),
          ...await sha384(payload),
        ]);
        return sha384(tagged);
      }

      if (Array.isArray(input)) {
        const tag = new Uint8Array([
          ...new TextEncoder().encode("list"),
          ...new TextEncoder().encode(String(input.length)),
        ]);
        let acc = await sha384(tag);
        for (const item of input) {
          const hash = await deepHash(item);
          const pair = new Uint8Array([...acc, ...hash]);
          acc = await sha384(pair);
        }
        return acc;
      }

      throw new Error("Unsupported deepHash input");
    };

    const signatureData = await deepHash([
      new TextEncoder().encode("dataitem"),
      new TextEncoder().encode("1"),
      new TextEncoder().encode("3"),
      owner,
      new Uint8Array(0),
      new Uint8Array(0),
      _tags,
      _data,
    ]);

    // EIP-191 personal_sign via ethers v6 wallet.
    const signature = await signingWallet.signMessage(
      new Uint8Array(signatureData),
    );

    const stripped = fromHex(signature.slice(2));
    bytes.set(stripped, 2);

    const sha256 = async (buf: ArrayBufferView): Promise<Uint8Array> => {
      return Uint8Array.from(await crypto.subtle.digest("SHA-256", buf));
    };

    const id = base64urlEncode(await sha256(stripped));

    return { raw: Uint8Array.from(bytes), id };
  }

  const address = await (async () => {
    const { Wallet } = await import("ethers");
    return new Wallet(privateKey).address;
  })();

  return {
    address,

    async getPrice(size: number): Promise<AtomicAmountLike> {
      const value = await irysFetchAndParse(
        `/price/${IRYS_TOKEN}/${size}`,
        "IRYS_PRICE",
        async (res) => {
          const text = (await res.text()).trim();
          // Some node versions return a bare integer string, others
          // wrap it as JSON (`"123"` or `{"price":"123"}`-shaped).
          // Try bare-integer first since that's the documented
          // behavior; only reach for JSON if that fails.
          if (/^\d+$/.test(text)) return text;
          const parsed = JSON.parse(text) as unknown;
          if (typeof parsed === "string" || typeof parsed === "number") {
            return String(parsed);
          }
          if (parsed && typeof parsed === "object" && "price" in parsed) {
            return String((parsed as { price: unknown }).price);
          }
          throw new Error("unrecognized price response shape");
        },
      );
      return new AtomicAmount(value);
    },

    utils: {
      async getBalance(queryAddress: string): Promise<AtomicAmountLike> {
        const value = await getBalanceAtomic(queryAddress);
        return new AtomicAmount(value);
      },
    },

    async fund(atomicAmount: bigint): Promise<void> {
      const to = await getFundingAddress();

      const before = await getBalanceAtomic(address);

      const tx = await wallet.sendTransaction({
        to,
        value: atomicAmount,
      });

      // One confirmation guarantees the transaction actually landed
      // on-chain — it does not guarantee Irys has observed it yet.
      await tx.wait(1);

      // Wait here, inside the one file the Freeze allows to change,
      // until the node's own balance endpoint reflects the deposit.
      // See FUNDING_SYNC_MAX_WAIT_MS above for why this exists.
      const target = before + atomicAmount;
      const deadline = Date.now() + FUNDING_SYNC_MAX_WAIT_MS;

      while (Date.now() < deadline) {
        const current = await getBalanceAtomic(address);
        if (current >= target) return;

        await new Promise((resolve) =>
          setTimeout(resolve, FUNDING_SYNC_POLL_INTERVAL_MS),
        );
      }

      // Deliberately not thrown: the funds are safely confirmed
      // on-chain and will sync eventually. Returning here — rather
      // than failing — lets executorHot.ts's own post-fund poll make
      // the final call under its existing, frozen Failure Law
      // semantics (fail-closed, retryable, Upload Token stays valid)
      // if node-side sync is still lagging beyond even this window.
    },

    async uploadData(
      data: Uint8Array,
      opts: { tags: UploadTag[] },
    ): Promise<UploadReceipt> {
      const { raw } = await buildAns104DataItem(data, opts.tags);

      const res = await irysFetch(`/tx/${IRYS_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: raw,
      });

      if (!res.ok) {
        const body = await previewBody(res);
        throw new Error(`IRYS_UPLOAD_HTTP_${res.status}${body ? `: ${body}` : ""}`);
      }

      const clone = res.clone();
      let receipt: { id?: unknown };
      try {
        receipt = (await res.json()) as { id?: unknown };
      } catch (err) {
        const body = await previewBody(clone);
        throw new Error(
          `IRYS_UPLOAD_INVALID_RESPONSE${body ? `: ${body}` : ""} (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }

      if (typeof receipt.id !== "string" || receipt.id.length === 0) {
        throw new Error(
          `IRYS_UPLOAD_INVALID_RECEIPT: ${JSON.stringify(receipt).slice(0, IRYS_ERROR_BODY_PREVIEW_MAX)}`,
        );
      }

      return { id: receipt.id };
    },
  };
}