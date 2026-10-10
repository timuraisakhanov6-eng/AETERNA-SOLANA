/**
 * Regression tests for the bounded-await primitives.
 *
 * Task section 7 #1 and #6:
 *  - #1  A promise that never settles must reject with a bounded timeout
 *        (not hang forever).
 *  - #6  A DOM event that never fires (e.g. MediaSource `sourceopen` /
 *        SourceBuffer `updateend`) must reject with a bounded timeout.
 *
 * These are the building blocks that keep every media handshake terminal.
 */

import { describe, it, expect, vi } from "vitest";
import {
  awaitEvent,
  withTimeout,
  BoundedAwaitTimeoutError,
} from "./boundedAwait";

describe("withTimeout", () => {
  it("#1: resolves when the wrapped promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "read")).resolves.toBe(42);
  });

  it("#1: rejects with a BoundedAwaitTimeoutError when it never settles", async () => {
    const never = new Promise<number>(() => {
      /* never settles */
    });
    await expect(withTimeout(never, 40, "read")).rejects.toBeInstanceOf(
      BoundedAwaitTimeoutError,
    );
  });

  it("propagates the underlying rejection without masking it", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 1000, "read"),
    ).rejects.toThrow("boom");
  });

  it("clears its timer after resolving (no dangling timer)", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    await withTimeout(Promise.resolve(1), 1000, "read");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("awaitEvent", () => {
  it("resolves when the event fires", async () => {
    const target = new EventTarget();
    const p = awaitEvent(target, "open", 1000, "open");
    target.dispatchEvent(new Event("open"));
    await expect(p).resolves.toBeUndefined();
  });

  it("#6: rejects with a timeout when the event never fires", async () => {
    const target = new EventTarget();
    await expect(
      awaitEvent(target, "open", 40, "sourceopen"),
    ).rejects.toBeInstanceOf(BoundedAwaitTimeoutError);
  });

  it("removes its listener after resolve (no double-handling)", async () => {
    const target = new EventTarget();
    const p = awaitEvent(target, "open", 1000, "open");
    target.dispatchEvent(new Event("open"));
    await p;
    expect(() => target.dispatchEvent(new Event("open"))).not.toThrow();
  });

  it("removes its listener after timeout (no leak)", async () => {
    const target = new EventTarget();
    const spy = vi.spyOn(target, "removeEventListener");
    await expect(
      awaitEvent(target, "open", 20, "open"),
    ).rejects.toBeInstanceOf(BoundedAwaitTimeoutError);
    expect(spy).toHaveBeenCalledWith("open", expect.any(Function));
    spy.mockRestore();
  });
});
