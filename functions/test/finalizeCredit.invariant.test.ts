import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";
import { onRequestPost as finalizePost } from "./../api/creator/finalize-credit";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

interface FinalizeEnv {
  CREATOR_CREDITS: ReturnType<typeof createFakeKV>;
  PUBLICATION_VERIFICATIONS: ReturnType<typeof createFakeKV>;
  SEAL_VERIFICATIONS: ReturnType<typeof createFakeKV>;
  CREDIT_OP_COORDINATOR: {
    idFromName(name: string): { id: string };
    get(binding: { id: string }): {
      fetch(request: Request): Promise<Response>;
    };
  };
}

function buildEnv(overrides?: Partial<FinalizeEnv>): FinalizeEnv {
  return {
    CREATOR_CREDITS: createFakeKV(),
    PUBLICATION_VERIFICATIONS: createFakeKV(),
    SEAL_VERIFICATIONS: createFakeKV(),
    CREDIT_OP_COORDINATOR: createFakeCoordinator(),
    ...overrides,
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
        async fetch(_request: Request) {
          const configured = outcomes.get("default");
          if (!configured) {
            return new Response(JSON.stringify({ ok: false, error: "NO_OUTCOME" }), { status: 500 });
          }
          const httpStatus = configured.httpStatus ?? (configured.ok ? 200 : 409);
          const body: Record<string, unknown> = {
            ok: configured.ok,
            status: configured.outcome ?? httpStatus,
            creatorCreditId: "credit-1",
            lifecycleId: null,
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

function buildContext(env: FinalizeEnv, body: unknown) {
  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });

  return makeEventContext({ request, env });
}

function seedConsumingCredit(env: FinalizeEnv) {
  env.CREATOR_CREDITS.put(
    "creator:credit:lifecycle:creator-1:lifecycle-1",
    JSON.stringify({
      id: "credit-1",
      status: "CONSUMING",
      creatorIdentityId: "creator-1",
      capsuleId: "capsule-1",
    })
  );
}

describe("Finalization boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("REJECTS when publication is not verified", async () => {
    const env = buildEnv();
    seedConsumingCredit(env);
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: false, outcome: "PUBLICATION_NOT_VERIFIED", httpStatus: 409 });

    const res = await finalizePost(
      buildContext(env, {
        creatorIdentityId: "creator-1",
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
      })
    );

    expect(res.status).toBe(409);
  });

  it("REJECTS when Seal is not verified", async () => {
    const env = buildEnv();
    seedConsumingCredit(env);
    env.PUBLICATION_VERIFICATIONS.put(
      "creator:publication:lifecycle-1",
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        state: "VERIFIED",
      })
    );
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: false, outcome: "SEAL_NOT_VERIFIED", httpStatus: 409 });

    const res = await finalizePost(
      buildContext(env, {
        creatorIdentityId: "creator-1",
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
      })
    );

    expect(res.status).toBe(409);
  });

  it("TRANSITIONS CONSUMING -> CONSUMED when all evidence is present", async () => {
    const env = buildEnv();
    seedConsumingCredit(env);
    env.PUBLICATION_VERIFICATIONS.put(
      "creator:publication:lifecycle-1",
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        state: "VERIFIED",
      })
    );
    env.SEAL_VERIFICATIONS.put(
      "creator:seal:lifecycle-1",
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        state: "VERIFIED",
      })
    );
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "CONSUMED", httpStatus: 200 });

    const res = await finalizePost(
      buildContext(env, {
        creatorIdentityId: "creator-1",
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
      })
    );

    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("CONSUMED");
  });

  it("is idempotent for duplicate finalization", async () => {
    const env = buildEnv();
    seedConsumingCredit(env);
    env.PUBLICATION_VERIFICATIONS.put(
      "creator:publication:lifecycle-1",
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        state: "VERIFIED",
      })
    );
    env.SEAL_VERIFICATIONS.put(
      "creator:seal:lifecycle-1",
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        state: "VERIFIED",
      })
    );
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "CONSUMED", httpStatus: 200 });

    const context = buildContext(env, {
      creatorIdentityId: "creator-1",
      lifecycleId: "lifecycle-1",
      capsuleId: "capsule-1",
    });

    const first = await finalizePost(context);
    expect(first.status).toBe(200);

    const second = await finalizePost(context);
    expect(second.status).toBe(200);
    expect((await second.json()).outcome).toBe("CONSUMED");
  });

  it("clears active lifecycle ownership after CONSUMED", async () => {
    const env = buildEnv();
    seedConsumingCredit(env);
    env.PUBLICATION_VERIFICATIONS.put(
      "creator:publication:lifecycle-1",
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        state: "VERIFIED",
      })
    );
    env.SEAL_VERIFICATIONS.put(
      "creator:seal:lifecycle-1",
      JSON.stringify({
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
        state: "VERIFIED",
      })
    );
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "CONSUMED", httpStatus: 200 });

    const res = await finalizePost(
      buildContext(env, {
        creatorIdentityId: "creator-1",
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
      })
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.outcome).toBe("CONSUMED");
  });
});
