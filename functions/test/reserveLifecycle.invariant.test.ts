import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";
import { onRequestPost as reserveLifecyclePost } from "./../api/creator/reserve-lifecycle";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

interface ReserveEnv {
  BUSINESS_QUOTES: ReturnType<typeof createFakeKV>;
  CREATOR_CREDITS: ReturnType<typeof createFakeKV>;
  CREDIT_OP_COORDINATOR: {
    idFromName(name: string): { id: string };
    get(binding: { id: string }): {
      fetch(request: Request): Promise<Response>;
    };
  };
}

function createFakeCoordinator() {
  const outcomes = new Map<string, { ok: boolean; outcome?: string; httpStatus?: number }>();
  return {
    idFromName(_name: string): { id: string } {
      return { id: "coordinator-1" };
    },
    get(_binding: { id: string }) {
      return {
        async fetch(request: Request) {
          const configured = outcomes.get("default");
          if (!configured) {
            return new Response(JSON.stringify({ ok: false, error: "NO_OUTCOME" }), { status: 500 });
          }

          let requestBody: Record<string, unknown> = {};
          try {
            requestBody = (await request.json()) as Record<string, unknown>;
          } catch {
            // ignore parse errors in fake coordinator
          }

          const httpStatus = configured.httpStatus ?? (configured.ok ? 200 : 409);
          const body: Record<string, unknown> = {
            ok: configured.ok,
            status: configured.outcome ?? httpStatus,
            creatorCreditId: "credit-1",
            lifecycleId: typeof requestBody.lifecycleId === "string" ? requestBody.lifecycleId : null,
            revision: 2,
          };
          if (configured.outcome) {
            body.outcome = configured.outcome;
          }
          return new Response(JSON.stringify(body), { status: httpStatus });
        },
      };
    },
    setOutcome(key: string, outcome: { ok: boolean; outcome?: string; httpStatus?: number }) {
      outcomes.set(key, outcome);
      if (key !== "default") {
        outcomes.set("default", outcome);
      }
    },
  };
}

function buildEnv(overrides?: Partial<ReserveEnv>): ReserveEnv {
  return {
    BUSINESS_QUOTES: createFakeKV(),
    CREATOR_CREDITS: createFakeKV(),
    CREDIT_OP_COORDINATOR: createFakeCoordinator(),
    ...overrides,
  };
}

function buildContext(env: ReserveEnv, body: unknown) {
  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });

  return makeEventContext({ request, env });
}

const CAPSULE_ID = "a".repeat(64);
const CREATOR_IDENTITY_ID = "a".repeat(32);
const LIFE_CYCLE_ID = "lifecycle-1";

function seedQuote(env: ReserveEnv, capsuleId: string) {
  env.BUSINESS_QUOTES.put(
    capsuleId,
    JSON.stringify({
      capsuleId,
      expectedAmount: 1,
      currency: "USD",
      expiresAt: Date.now() + 60_000,
    })
  );
}

function seedCredit(env: ReserveEnv, status: string) {
  env.CREATOR_CREDITS.put(
    `creator:credit:index:${CREATOR_IDENTITY_ID}:${CAPSULE_ID}`,
    "credit-1"
  );
  env.CREATOR_CREDITS.put(
    "creator:credit:credit-1",
    JSON.stringify({
      id: "credit-1",
      creatorIdentityId: CREATOR_IDENTITY_ID,
      status,
      capsuleId: CAPSULE_ID,
      lifecycleId: status === "CONSUMING" ? LIFE_CYCLE_ID : null,
      revision: 1,
      updatedAt: Date.now(),
    })
  );
}

describe("Reserve lifecycle boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("RESERVES an AVAILABLE credit and transitions to CONSUMING", async () => {
    const env = buildEnv();
    seedQuote(env, CAPSULE_ID);
    seedCredit(env, "AVAILABLE");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "RESERVED", httpStatus: 200 });

    const res = await reserveLifecyclePost(
      buildContext(env, {
        creatorIdentityId: CREATOR_IDENTITY_ID,
        capsuleId: CAPSULE_ID,
        lifecycleId: LIFE_CYCLE_ID,
      })
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.lifecycleId).toBe(LIFE_CYCLE_ID);
  });

  it("REJECTS when Creator Credit is not found", async () => {
    const env = buildEnv();
    seedQuote(env, CAPSULE_ID);

    const res = await reserveLifecyclePost(
      buildContext(env, {
        creatorIdentityId: CREATOR_IDENTITY_ID,
        capsuleId: CAPSULE_ID,
        lifecycleId: LIFE_CYCLE_ID,
      })
    );

    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("CREATOR_CREDIT_NOT_FOUND");
  });

  it("REJECTS duplicate reservation for a different lifecycle", async () => {
    const env = buildEnv();
    seedQuote(env, CAPSULE_ID);
    seedCredit(env, "CONSUMING");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: false, outcome: "ALREADY_CONSUMING", httpStatus: 409 });

    const res = await reserveLifecyclePost(
      buildContext(env, {
        creatorIdentityId: CREATOR_IDENTITY_ID,
        capsuleId: CAPSULE_ID,
        lifecycleId: `${LIFE_CYCLE_ID}-2`,
      })
    );

    expect(res.status).toBe(409);
    expect((await res.json()).outcome).toBe("ALREADY_CONSUMING");
  });

  it("RETURNS existing reservation for the same lifecycle", async () => {
    const env = buildEnv();
    seedQuote(env, CAPSULE_ID);
    seedCredit(env, "CONSUMING");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "ALREADY_RESERVED_FOR_SAME_LIFECYCLE", httpStatus: 200 });

    const res = await reserveLifecyclePost(
      buildContext(env, {
        creatorIdentityId: CREATOR_IDENTITY_ID,
        capsuleId: CAPSULE_ID,
        lifecycleId: LIFE_CYCLE_ID,
      })
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.lifecycleId).toBe(LIFE_CYCLE_ID);
  });

  it("REJECTS wrong Creator Identity", async () => {
    const env = buildEnv();
    seedQuote(env, CAPSULE_ID);
    seedCredit(env, "AVAILABLE");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: false, outcome: "IDENTITY_MISMATCH", httpStatus: 409 });

    const res = await reserveLifecyclePost(
      buildContext(env, {
        creatorIdentityId: `${CREATOR_IDENTITY_ID}-other`,
        capsuleId: CAPSULE_ID,
        lifecycleId: LIFE_CYCLE_ID,
      })
    );

    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("CREATOR_CREDIT_NOT_FOUND");
  });

  it("REJECTS forged lifecycleId without binding", async () => {
    const env = buildEnv();
    seedQuote(env, CAPSULE_ID);
    seedCredit(env, "AVAILABLE");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: false, outcome: "LIFECYCLE_NOT_FOUND", httpStatus: 409 });

    const res = await reserveLifecyclePost(
      buildContext(env, {
        creatorIdentityId: CREATOR_IDENTITY_ID,
        capsuleId: CAPSULE_ID,
        lifecycleId: "forged-lifecycle",
      })
    );

    expect(res.status).toBe(409);
    expect((await res.json()).outcome).toBe("LIFECYCLE_NOT_FOUND");
  });

  it("RETURNS existing result on retry after lost response", async () => {
    const env = buildEnv();
    seedQuote(env, CAPSULE_ID);
    seedCredit(env, "CONSUMING");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "ALREADY_RESERVED_FOR_SAME_LIFECYCLE", httpStatus: 200 });

    const first = await reserveLifecyclePost(
      buildContext(env, {
        creatorIdentityId: CREATOR_IDENTITY_ID,
        capsuleId: CAPSULE_ID,
        lifecycleId: LIFE_CYCLE_ID,
      })
    );

    const second = await reserveLifecyclePost(
      buildContext(env, {
        creatorIdentityId: CREATOR_IDENTITY_ID,
        capsuleId: CAPSULE_ID,
        lifecycleId: LIFE_CYCLE_ID,
      })
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondPayload = await second.json();
    expect(secondPayload.ok).toBe(true);
    expect(secondPayload.lifecycleId).toBe(LIFE_CYCLE_ID);
  });

  it("REJECTS reserve when Business Quote is missing", async () => {
    const env = buildEnv();

    const res = await reserveLifecyclePost(
      buildContext(env, {
        creatorIdentityId: CREATOR_IDENTITY_ID,
        capsuleId: CAPSULE_ID,
        lifecycleId: LIFE_CYCLE_ID,
      })
    );

    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("BUSINESS_QUOTE_NOT_FOUND");
  });
});
