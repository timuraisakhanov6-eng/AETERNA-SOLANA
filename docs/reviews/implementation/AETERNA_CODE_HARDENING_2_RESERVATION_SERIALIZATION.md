# AETERNA — CODE-HARDENING-2: Reservation Serialization Status

Status: BLOCKED  
Authority: Implementation Record  
Version: 1.0

## 1. Finding

`functions/api/creator/reserve-lifecycle.ts` does NOT use the shared
credit operation lock. The current shared lock implementation in
`functions/lib/creditOperationLock.ts` cannot provide the strong
distributed serialization required for atomic `AVAILABLE -> CONSUMING`
reservation under concurrent server execution.

## 2. Evidence

File: `functions/lib/creditOperationLock.ts`
Lines: 7-16, 39-56

The helper explicitly documents its limitation:

- "Cloudflare KV does not provide atomic compare-and-swap."
- "This is NOT a strong distributed lock."
- "Concurrent workers can still interleave reads/writes."

Mechanism:
- `get` for existence check
- `put` token
- `try`/`finally` with token-match delete

This is a best-effort ownership token. It does not prevent interleaving
reads/writes between check and commit, and it is not atomic across
isolates/workers.

File: `functions/api/creator/reserve-lifecycle.ts`
Lines: 128-172

Reservation flow:
1. Read lifecycle index (`get`)
2. Read credit index (`get`)
3. Check status (`AVAILABLE`)
4. Write credit record (`put`)
5. Write lifecycle index (`put`)
6. Write credit index (`put`)

No shared lock surrounds these operations.

## 3. Cloudflare KV Concurrency Analysis

Current project KV usage:
- `CREATOR_CREDITS` — plain KV namespace interface
- `PUBLICATION_VERIFICATIONS` — plain KV namespace interface
- `SEAL_VERIFICATIONS` — plain KV namespace interface

Cloudflare KV guarantees:
- eventual consistency for writes
- no atomic compare-and-swap
- no distributed lock primitive

`withCreditOperation` in current form:
- process-local best-effort check-then-put
- NOT safe against concurrent workers/isolates
- may allow two concurrent reservations to both observe AVAILABLE
  before either commits CONSUMING

Result:
- TWO concurrent reservations for the SAME Credit can BOTH succeed
- ONE Credit can receive TWO active lifecycle owners
- This violates the core invariant:
  ONE Creator Credit -> MAXIMUM ONE active lifecycle owner

## 4. Why CODE-HARDENING-2 Cannot Complete With Current Primitives

The user's absolute rule states:

> "Do NOT replace it with an unsafe homegrown lock just to make tests pass."
> "If an already-established project mechanism safely solves the problem: use it."
> "If the current Cloudflare KV architecture cannot provide strong distributed serialization ... mark CODE-HARDENING-2 = BLOCKED."

The project currently has NO established safe distributed serialization
mechanism for Creator Credit reservation. Adding a weaker lock would
violate the first rule. Pretending the current best-effort token is
atomic would violate the second rule.

## 5. Honest Assessment

What the current code actually guarantees:
- retry of SAME lifecycleId returns existing reservation (idempotency by key)
- different lifecycleIds CAN both observe AVAILABLE and BOTH transition to CONSUMING
- different Creator Identities CAN both observe AVAILABLE and BOTH transition

What the code does NOT guarantee:
- atomic AVAILABLE -> CONSUMING
- exactly one active lifecycle per Credit under concurrency
- safety against concurrent workers/isolates

## 6. Minimum Stronger Mechanism Required

To complete CODE-HARDENING-2 safely, the project needs ONE of:
1. A Cloudflare primitive that provides atomic compare-and-swap for KV;
2. A Durable Object with single-threaded serialization authority;
3. A Workers-side advisory lock in a system with linearizable consistency;
4. An architectural change that moves reservation authority to a
   serialized execution environment.

## 7. No Code Changes Made

No production code, tests, configuration, or documentation was modified
to fake or weaken this finding.

## 8. Next Phase Recommendation

1. Evaluate Cloudflare Durable Objects for Creator Credit reservation
   serialization.
2. If Durable Objects are acceptable, redesign `withCreditOperation`
   around DO single-threaded execution.
3. Re-run CODE-HARDENING-2 only after a genuine distributed serialization
   mechanism is established.
4. Do NOT mark reservation as atomically serialized until then.

## 9. Validation

No validation was performed because no code changes were made.

## 10. Remaining PENDING Items

- Atomic Creator Credit reservation mechanism
- Distributed serialization primitive for reserve/finalize/recovery
- Reservation attack tests (meaningful only with real serialization)
- Honest-user retry behavior under real serialization

## 11. Blockers

1. Cloudflare KV lacks atomic compare-and-swap
2. Current `withCreditOperation` is best-effort, not strong/distributed
3. No established project-native distributed serialization mechanism exists
4. `reserve-lifecycle.ts` is outside the weak lock entirely
