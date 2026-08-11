export interface UploadTag {
  name: string;
  value: string;
}

export interface UploadReceipt {
  id: string;
}

export interface ExecutorTransport {
  ready(): Promise<void>;

  getPrice(size: number): Promise<unknown>;

  getBalance(): Promise<unknown>;

  fund(amount: bigint): Promise<void>;

  upload(
    data: Uint8Array,
    tags: UploadTag[]
  ): Promise<UploadReceipt>;
}

/**
 * AtomicAmountLike
 *
 * Minimal BigNumber-compatible surface. Executor Hot (frozen, per
 * AETERNA_EXECUTOR_PUBLICATION_SPEC_v1 Section 5) calls exactly these
 * four operations on values returned from getPrice()/getBalance() —
 * see functions/lib/executorHot.ts, publishCiphertext():
 *
 *   basePrice.multipliedBy(IRYS_FUNDING_MULTIPLIER)
 *   price.minus(nodeBalance)
 *   nodeBalance.isLessThan(price)
 *   price.toString() / basePrice.toString() / nodeBalance.toString()
 *
 * This is intentionally narrower than a full BigNumber.js surface —
 * it is the exact contract Executor Hot depends on, nothing more.
 */
export interface AtomicAmountLike {
  multipliedBy(multiplier: number): AtomicAmountLike;
  minus(other: AtomicAmountLike): AtomicAmountLike;
  isLessThan(other: AtomicAmountLike): boolean;
  toString(): string;
}

/**
 * IrysRuntime
 *
 * This is the ACTUAL surface functions/lib/executorHot.ts calls on
 * the value returned by createExecutorTransport(). It intentionally
 * mirrors the shape of the legacy @irys/sdk client object, because
 * Executor Hot (frozen) was written against that shape and MUST NOT
 * be modified. Only the transport implementation may change — the
 * contract it must honor is this interface.
 *
 * The narrower `ExecutorTransport` interface above is retained as
 * forward-looking documentation of an eventual cleaner boundary, but
 * is not what production code currently calls.
 */
export interface IrysRuntime {
  /** EVM address Executor Hot signs and pays from. */
  address: string;

  getPrice(size: number): Promise<AtomicAmountLike>;

  utils: {
    getBalance(address: string): Promise<AtomicAmountLike>;
  };

  fund(atomicAmount: bigint): Promise<void>;

  uploadData(
    data: Uint8Array,
    opts: { tags: UploadTag[] }
  ): Promise<UploadReceipt>;
}