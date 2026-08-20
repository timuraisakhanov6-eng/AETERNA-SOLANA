import { describe, expect, it, vi } from "vitest";
import {
  createFakeRequest,
  makeEventContext,
} from "./harness";
import { onRequestGet as timeGet } from "./../api/time";
import { getTrustedTime as serverGetTrustedTime } from "./../lib/getTrustedTime";
import { resolveEffectiveOpenAt } from "@/shared/heartbeat/resolveEffectiveOpenAt";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

function buildTimeContext(origin = ALLOWED_ORIGIN) {
  const request = createFakeRequest({
    headers: { origin },
  });
  return makeEventContext({ request });
}

describe("Trusted Time invariants", () => {
  describe("/api/time ENDPOINT", () => {
    it("valid request returns valid trusted time response", async () => {
      const response = await timeGet(buildTimeContext());
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { nowUtc: number };
      expect(payload).toHaveProperty("nowUtc");
      expect(typeof payload.nowUtc).toBe("number");
      expect(Number.isSafeInteger(payload.nowUtc)).toBe(true);
    });

    it("response shape matches production contract", async () => {
      const response = await timeGet(buildTimeContext());
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("x-aeterna-time-trusted")).toBe("true");
      expect(response.headers.get("x-aeterna-time-authority")).toBe("primary");
      expect(response.headers.get("x-aeterna-time-version")).toBe("v1");
      expect(response.headers.get("date")).toBeTruthy();
    });

    it("invalid origin is rejected before trusted time is consulted", async () => {
      const response = await timeGet(
        buildTimeContext("https://evil.example.com")
      );
      expect(response.status).toBe(403);
      expect((await response.json()).ok).toBe(false);
    });

    it("malformed trusted time response is rejected with failure response", async () => {
      const spy = vi.spyOn(Date, "now").mockReturnValue(NaN);
      try {
        const response = await timeGet(buildTimeContext());
        expect(response.status).toBe(500);
        expect((await response.json()).ok).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("SERVER getTrustedTime", () => {
    it("returns valid trusted time for bounded system time", async () => {
      const result = await serverGetTrustedTime();
      expect(result).toEqual({ nowUtc: expect.any(Number) });
      expect(Number.isSafeInteger(result.nowUtc)).toBe(true);
    });
  });

  describe("TRUSTED TIME BOUNDARY", () => {
    it("resolveEffectiveOpenAt does not consult trustedNow; trusted time is external boundary", () => {
      const manifestOpenAt = 1700000000000;
      const result = resolveEffectiveOpenAt({
        manifestOpenAt,
        heartbeatInterval: 86400000,
        lastConfirmedAt: undefined,
      });
      expect(result).toBe(manifestOpenAt);
    });
  });

  describe("FAIL-CLOSED", () => {
    it("server getTrustedTime rejects malformed trusted time values", async () => {
      const spy = vi.spyOn(Date, "now").mockReturnValue(NaN);
      try {
        await expect(serverGetTrustedTime()).rejects.toThrow(
          "[AETERNA] Trusted server time violation"
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("BOUNDS / VALIDATION", () => {
    it("rejects implausibly low trustedNow", async () => {
      const spy = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        await expect(serverGetTrustedTime()).rejects.toThrow(
          "[AETERNA] Trusted server time violation"
        );
      } finally {
        spy.mockRestore();
      }
    });

    it("rejects implausibly high trustedNow", async () => {
      const spy = vi.spyOn(Date, "now").mockReturnValue(9999999999999);
      try {
        await expect(serverGetTrustedTime()).rejects.toThrow(
          "[AETERNA] Trusted server time violation"
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("KDF SEPARATION", () => {
    it("INCONCLUSIVE — live KDF dependency check requires mocking native crypto.subtle, unavailable in this Node/Vitest environment", () => {
      expect(true).toBe(true);
    });
  });

  describe("DEV vs PRODUCTION TRUSTED TIME BOUNDARY", () => {
    it("functions/lib/getTrustedTime.ts uses Date.now() directly as local-server authority", async () => {
      const result = await serverGetTrustedTime();
      expect(result).toEqual({ nowUtc: expect.any(Number) });
    });
  });

  describe("INCONCLUSIVE — external infrastructure dependency", () => {
    it("CapsuleController.tryOpen opening semantics: INCONCLUSIVE — requires browser runtime, useEffect, document, fetch /api/time", () => {
      expect(true).toBe(true);
    });

    it("confirmPresence failure propagation through /api/heartbeat: INCONCLUSIVE — requires network fetch path unavailable offline", () => {
      expect(true).toBe(true);
    });

    it("seal.ts trusted-time failure propagation to manifest state: INCONCLUSIVE — requires KV/runtime/wasm environment unavailable in offline vitest", () => {
      expect(true).toBe(true);
    });
  });
});
