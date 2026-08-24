# AETERNA — Distributed Creator Credit Serialization Architecture Specification

Status: NOT READY FOR IMPLEMENTATION  
Authority: Architecture / Design Document  
Version: 1.0

## 1. Problem Statement

ONE Creator Credit MUST map to MAXIMUM ONE active lifecycle owner.

Currently, reserve-lifecycle, finalize-credit, and recover-lifecycle need a shared authoritative serialization boundary that remains correct under:

- different Worker isolates;
- concurrent requests;
- retries after lost responses;
- device/tab changes.

## 2. Current Limitation

functions/lib/creditOperationLock.ts documents its own limitation:

- Cloudflare KV provides no atomic compare-and-swap.
- This is NOT a strong distributed lock.
- Concurrent workers can still interleave reads/writes.

Mechanism today:
- get existence check
- put ownership token
- try/finally token-match delete

This is best-effort process-local coordination. It does NOT prevent:
Request A read AVAILABLE
Request B read AVAILABLE
Request A write CONSUMING
Request B write CONSUMING
both succeeding.

## 3. Security Invariant

ONE Creator Credit
→ MAXIMUM ONE active lifecycle owner

This must hold for:
- AVAILABLE → CONSUMING reservation
- CONSUMING → CONSUMED finalization
- CONSUMING → AVAILABLE recovery
- any future authoritative Credit mutation

No transition may be justified by frontend state.

## 4. Distributed Concurrency Model

Target model:
- operations on different Credits proceed independently;
- operations on the same Credit are serialized through one authoritative boundary;
- outcome after concurrent requests is deterministic and auditable.

## 5. Preferred Architecture

Preferred: Cloudflare Durable Object acting as CreditOperationCoordinator.

Reasons:
- single-threaded serial execution per Credit;
- durable state survives crashes;
- request serialization is inherent;
- compatible with current Cloudflare Workers architecture;
- no reliance on KV atomicity.

Conceptual boundary:
reserve / finalize / recovery
→ CreditOperationCoordinator(creditId)
→ single-threaded state machine transition
→ persistent Credit/lifecycle record update
→ result

## 6. Alternative Architectures Considered

A. Strongly-consistent transactional database
- correctness: high
- Cloudflare compatibility: requires new provider, not currently configured
- status: not viable without new infrastructure

B. Current KV best-effort token
- correctness: insufficient under concurrent isolates
- status: rejected

C. Provider-neutral adapter with external coordination
- correctness: depends on provider
- status: deferred; would introduce provider dependency

## 7. Failure Model

A. Worker crashes during reservation
- DO keeps Credit state; restart/retry sees authoritative state
- no permanent lock

B. Worker crashes during finalization
- DO continues to serial state; no half-committed state

C. Worker crashes during recovery
- DO continues; recovery reruns deterministically

D. request timeout / client disconnect
- DO operation continues to completion
- client retry reads authoritative state

E. duplicate request
- same lifecycle idempotent
- different lifecycle rejected while CONSUMING

F. two workers process simultaneously
- DO serializes by creditId
- only one transition succeeds

## 8. Lock / Ownership Model

If Durable Object selected:

Lock key:
- creator:credit:op:<creatorCreditId>

Ownership token:
- DO-internal monotonic operation id

Acquisition:
- single request handled at a time by DO

Release:
- automatic after operation completes

Crash handling:
- DO durable state survives crashes; no stale external token

Fencing:
- DO internal operation sequence number

## 9. Fencing / Version Model

Requires:
- operation version or monotonic revision per Credit record
- prevents stale write after newer state

Preferred:
- DO-managed revision embedded in Credit record
- reject writes with older revision

## 10. Reservation Contract

reserve(creatorCreditId, lifecycleId, creatorIdentityId)

Result classes:
- RESERVED
- ALREADY_RESERVED_FOR_SAME_LIFECYCLE
- ALREADY_CONSUMING
- ALREADY_CONSUMED
- IDENTITY_MISMATCH
- INVALID

Atomic requirement:
- read AVAILABLE and write CONSUMING must be indivisible for same creditId

## 11. Finalization Contract

CONSUMING
+ authoritative publication VERIFIED
+ authoritative Seal VERIFIED
+ correct binding
→ CONSUMED

Serialization: same DO boundary as reservation/recovery

## 12. Recovery Contract

CONSUMING
→ AVAILABLE

must be serialized against reservation, finalization, other recovery.

Recovery must never restore Credit after authoritative final success.

## 13. Idempotency

- reservation: same lifecycle returns existing authoritative reservation
- retry: lost response retry reads authoritative state
- finalization: duplicate returns existing CONSUMED result
- recovery: duplicate returns existing recovery outcome

## 14. Lifecycle Ownership

Bindings:
- creatorCreditId
- creatorIdentityId
- lifecycleId
- capsuleId
- status

Invariant:
ONE Credit → ONE active lifecycle owner

## 15. Threat Model

A. two Workers reserve same Credit
ISSUE with current KV; PASS with DO serialization

B. two devices reserve same Credit
ISSUE with current KV; PASS with DO serialization

C. reserve vs finalize
ISSUE with current KV; PASS with DO serialization

D. reserve vs recovery
ISSUE with current KV; PASS with DO serialization

E. finalize vs recovery
PASS today via shared weak token; DO preserves this

F. two recoveries
PASS via weak token today; DO preserves this stronger

G. stale writer after crash
ISSUE with current KV; DO provides deterministic recovery

H. retry after lost response
PASS via idempotent reads today; DO preserves

I. stale client state
PASS: server state is authoritative

J. forged lifecycleId
PASS: server tracks binding

K. forged Creator Identity
PASS: challenge/verify boundary upstream

## 16. Cloudflare Deployment Requirements

Required for implementation:
- Durable Object binding in wrangler.toml
- CreditOperationCoordinator DO class
- DO migration name
- Worker-to-DO routing for reserve/finalize/recovery

Current project state:
- wrangler.toml contains only KV namespaces
- No durable_objects section present
- No DO code exists

## 17. Implementation Boundary

Conceptual components:

CreditOperationCoordinator
- serializes all authoritative operations for one creditId
- maintains Credit/lifecycle state
- enforces state machine transitions
- emits deterministic outcomes

reserve-lifecycle.ts
- delegates to Coordinator
- returns Coordinator outcome

finalize-credit.ts
- delegates to Coordinator
- returns Coordinator outcome

recover-lifecycle.ts
- delegates to Coordinator
- returns Coordinator outcome

State persistence
- DO durable storage or bound KV with DO-mediated atomicity

Idempotency
- Coordinator tracks operation keys
- duplicate requests return existing state

Fencing/versioning
- Coordinator-managed revision per Credit record

## 18. Pending Decisions

A. SECURITY INVARIANTS
- ONE Credit → ONE active lifecycle owner: MUST be preserved
- recovery must not restore after final success: MUST be preserved
- frontend non-authority: MUST be preserved

B. ARCHITECTURAL DECISIONS
- Select Durable Object as distributed serialization primitive
- Define DO migration name and binding
- Define DO request/response contract

C. IMPLEMENTATION DETAILS
- DO class file location
- routing from endpoints to DO
- exact persistence schema inside DO
- timeout/reconciliation policy

D. PROVIDER/INFRASTRUCTURE SELECTION
- Cloudflare Durable Objects confirmed as preferred mechanism
- No external provider required

## 19. Migration Plan

1. Add durable_objects binding to wrangler.toml
2. Implement CreditOperationCoordinator DO
3. Rebuild reserve-lifecycle, finalize-credit, recover-lifecycle to delegate to DO
4. Add concurrency/integration tests against DO behavior
5. Validate fail-closed behavior and crash recovery

## 20. Security Proof / Invariants

Required proofs after implementation:
- Two concurrent reserve requests for same Credit cannot both succeed
- Recovery cannot race finalization
- Finalization cannot race reservation
- Stale writes are rejected by fencing/revision check
- Crash during operation does not create orphan lock
- Retry after lost response returns authoritative state
- Recovery never restores CONSUMED Credit

Current status:
- Invariants defined
- Mechanism selected: Durable Object
- Implementation pending
- Proof pending implementation
