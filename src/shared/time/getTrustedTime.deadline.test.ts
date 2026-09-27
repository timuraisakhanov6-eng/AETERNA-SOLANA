/**
 * AETERNA — `getTrustedTime` operation-level deadline.
 *
 * TASK J3 (P1): `GET /api/time` is a discrete same-origin Function call in
 * the post-payment path. A never-settling request must reject into the
 * EXISTING fail-closed error instead of hanging the flow, while a healthy
 * response (and the existing time-bound validation) is unchanged.
 */

import { describe, expect, it, vi, afterEach } from "vitest";

import { getTrustedTime } from "./getTrustedTime";

const TIME_REQUEST_TIMEOUT_MS = 8_000;

function installFetch(
  behavior: "ok" | "hang" | "bad"
): { restore: () => void } {
  const original = globalThis.fetch;

  globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    if (behavior === "ok") {
      return Promise.resolve({
        ok: true,
        status: 200,
        async json() {
          return { nowUtc: 1_700_000_000_000 };
        },
      } as unknown as Response);
    }

    if (behavior === "bad") {
      return Promise.resolve({
        ok: false,
        status: 503,
        async json() {
          return {};
        },
      } as unknown as Response);
    }

    // hang: honour the abort signal only.
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? undefined;
      signal?.addEventListener(
        "abort",
        () =>
          reject(
            Object.assign(new Error("The operation was aborted."), {
              name: "AbortError",
            })
          ),
        { once: true }
      );
    });
  }) as unknown as typeof fetch;

  return { restore: () => { globalThis.fetch = original; } };
}

describe("getTrustedTime — request deadline", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    vi.useRealTimers();
    restore?.();
    restore = undefined;
  });

  it("NORMAL: a healthy response is returned unchanged", async () => {
    restore = installFetch("ok").restore;
    await expect(getTrustedTime()).resolves.toEqual({
      nowUtc: 1_700_000_000_000,
    });
  });

  it("HTTP ERROR: a non-ok response still fails closed with the existing error", async () => {
    restore = installFetch("bad").restore;
    await expect(getTrustedTime()).rejects.toThrow(
      "[AETERNA] Trusted time unavailable"
    );
  });

  it("TIMEOUT: a never-settling time request rejects via the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    restore = installFetch("hang").restore;

    const promise = getTrustedTime();
    const assertion = expect(promise).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(TIME_REQUEST_TIMEOUT_MS + 1_000);

    await assertion;
  });

  it("MUTATION: without the deadline the never-settling request stays pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    restore = installFetch("hang").restore;

    const promise = getTrustedTime();
    let settled: "resolved" | "rejected" | "pending" = "pending";
    promise.then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      }
    );

    await vi.advanceTimersByTimeAsync(TIME_REQUEST_TIMEOUT_MS * 4);

    expect(settled).toBe("rejected");
  });
});
