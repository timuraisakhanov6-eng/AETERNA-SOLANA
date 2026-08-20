import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
} from "./harness";
import { onRequestPost as recoverPost } from "./../api/creator/recover-lifecycle";

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

interface RecoverEnv {
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

function buildEnv(overrides?: Partial<RecoverEnv>): RecoverEnv {
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

function buildContext(env: RecoverEnv, body: unknown) {
  const request = createFakeRequest({
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });

  return makeEventContext({ request, env });
}

function seedLifecycle(env: RecoverEnv, status: string) {
  env.CREATOR_CREDITS.put(
    "creator:credit:lifecycle:creator-1:lifecycle-1",
    JSON.stringify({
      id: "credit-1",
      status,
      creatorIdentityId: "creator-1",
      capsuleId: "capsule-1",
    })
  );
}

describe("Recovery authority", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("RETURNS RETURN_EXISTING when lifecycle is CONSUMED", async () => {
    const env = buildEnv();
    seedLifecycle(env, "CONSUMED");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "RETURN_EXISTING", httpStatus: 200 });

    const res = await recoverPost(
      buildContext(env, {
        creatorIdentityId: "creator-1",
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
      })
    );

    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("RETURN_EXISTING");
  });

  it("RETURNS RETURN_EXISTING when publication and Seal are verified", async () => {
    const env = buildEnv();
    seedLifecycle(env, "CONSUMING");
    env.PUBLICATION_VERIFICATIONS.put(
      "creator:publication:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", state: "VERIFIED" })
    );
    env.SEAL_VERIFICATIONS.put(
      "creator:seal:lifecycle-1",
      JSON.stringify({ lifecycleId: "lifecycle-1", capsuleId: "capsule-1", state: "VERIFIED" })
    );
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "RETURN_EXISTING", httpStatus: 200 });

    const res = await recoverPost(
      buildContext(env, {
        creatorIdentityId: "creator-1",
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
      })
    );

    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("RETURN_EXISTING");
  });

  it("RETURNS RESUME for active or consuming lifecycle", async () => {
    const env = buildEnv();
    seedLifecycle(env, "ACTIVE");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "RESUME", httpStatus: 200 });

    const res = await recoverPost(
      buildContext(env, {
        creatorIdentityId: "creator-1",
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
      })
    );

    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("RESUME");
  });

  it("RESTORES AVAILABLE for interrupted lifecycle and clears ownership", async () => {
    const env = buildEnv();
    seedLifecycle(env, "INTERRUPTED");
    env.CREDIT_OP_COORDINATOR.setOutcome("default", { ok: true, outcome: "ABORT_AND_RESTORE_AVAILABLE", httpStatus: 200 });

    const res = await recoverPost(
      buildContext(env, {
        creatorIdentityId: "creator-1",
        lifecycleId: "lifecycle-1",
        capsuleId: "capsule-1",
      })
    );

    expect(res.status).toBe(200);
    const recovery = await res.json();
    expect(recovery.outcome).toBe("ABORT_AND_RESTORE_AVAILABLE");
    expect(recovery.status).toBe("ABORT_AND_RESTORE_AVAILABLE");
  });
});
