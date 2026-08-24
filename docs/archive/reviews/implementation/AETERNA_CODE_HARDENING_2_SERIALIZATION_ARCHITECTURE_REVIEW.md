# AETERNA — CODE-HARDENING-2: Serialization Architecture Review

Status: NOT READY FOR IMPLEMENTATION  
Authority: Read-Only Architecture Review  
Version: 1.0

## 1. Finding

The current shared serialization mechanism in functions/lib/creditOperationLock.ts is:
- best-effort
- NOT strong/distributed
- process-local at best
- vulnerable to concurrent Worker execution

## 2. Evidence

File: functions/lib/creditOperationLock.ts
- "Cloudflare KV does not provide atomic compare-and-swap."
- "This is NOT a strong distributed lock."
- "Concurrent workers can still interleave reads/writes."

File: functions/api/creator/reserve-lifecycle.ts
- Does NOT use withCreditOperation
- Reads lifecycle index, credit index, status, then writes Credit/lifecycle/index sequentially
- No shared lock surrounds reservation

## 3. Threat Model Assessment

A. two Workers reserve same Credit — ISSUE
B. two devices reserve same Credit — ISSUE
C. reserve vs finalize — ISSUE
D. reserve vs recovery — ISSUE
E. finalize vs recovery — PASS via weak token; insufficient for new reservation boundary
F. two recoveries — PASS via weak token
G. stale writer after crash — ISSUE
H. retry after lost response — PASS via idempotent reads
I. stale client state — PASS
J. forged lifecycleId — PASS
K. forged Creator Identity — PASS

## 4. Required Architecture

Durable Object CreditOperationCoordinator selected as preferred mechanism.

Rationale:
- Single-threaded serial execution per creatorCreditId
- Durable state survives crashes
- No reliance on KV atomicity
- Compatible with current Cloudflare Workers architecture

## 5. Current Blocker

wrangler.toml contains no durable_objects section.
No DO implementation exists.
Current KV-based lock cannot provide required guarantee.

## 6. Implementation Boundary

CreditOperationCoordinator DO must:
- Serialize reserve/finalize/recovery by creatorCreditId
- Maintain authoritative Credit/lifecycle state
- Enforce state machine transitions
- Provide idempotent outcomes
- Support fencing/revision checks

## 7. Completion Rule

SPEC-WP-12 = NOT READY FOR IMPLEMENTATION until:
1. Durable Object binding added to wrangler.toml
2. CreditOperationCoordinator DO implemented
3. Reserve-lifecycle delegates to DO
4. Concurrency tests validate DO serialization
5. Crash/recovery behavior validated

## 8. Final Confirmation

"No production code, tests, configuration, wallets, payment architecture, crypto, storage, Vault, Manifest, Seal, Trusted Time, Heartbeat, or Emergency Runtime were modified."
