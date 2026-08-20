# AETERNA — Finalization, Publication/Seal Verification, and Lifecycle Recovery Runtime Interface Architecture

Status: DESIGN ONLY — READ-ONLY  
Authority: Architecture / Design Document  
Version: 1.0

---

## 1. PURPOSE

This document defines the exact missing runtime interface contracts required to safely complete:

CONSUMING
→ authoritative publication verification
→ authoritative Seal verification
→ atomic finalization
→ CONSUMED

and safe interrupted-lifecycle recovery.

This document does NOT implement production code, tests, configuration, wallets, crypto, storage semantics, or Emergency Runtime behavior.

---

## 2. AUTHORITATIVE PUBLICATION VERIFICATION INTERFACE

### 2.1 Client Evidence vs Authoritative Facts

Client may submit evidence identifiers only:
- publication identifier / transaction id / hash;
- provider-specific evidence reference;
- optional submission context fields.

Client evidence is NOT authority.

Authoritative publication facts MUST be established by the server from:
- authoritative Irys/network source;
OR
- an explicitly trusted verification provider.

### 2.2 Interface Contract

Conceptual inputs:
- lifecycleId;
- capsuleId;
- creatorIdentityId;
- client-submitted publication evidence identifiers.

Server MUST independently establish:
- publication exists in authoritative source;
- publication identifier matches submitted evidence binding;
- publication is bound to the expected capsule/lifecycle/artifact;
- publication is in the required success/finality state;
- publication belongs to the correct network/provider context;
- publication is not another capsule's publication.

### 2.3 Evidence Binding

Authoritative publication result MUST be bound to:
- lifecycleId;
- capsuleId;
- creatorIdentityId;
- expected publication purpose;
- expected artifact/manifest/vault association.

Replay protection:
- verification state is server-tracked;
- duplicate verification request for same evidence/lifecycle MUST return existing state.

### 2.4 Publication State Model

Conceptual states:
- NOT_VERIFIED
- PENDING
- VERIFIED
- FAILED/REJECTED

Valid transitions:
- NOT_VERIFIED -> PENDING
- PENDING -> VERIFIED
- PENDING -> NOT_VERIFIED

### 2.5 Provider-Neutrality Rule

Exact Irys/network verification provider is implementation-selection PENDING.
The interface MUST remain provider-neutral:
- server enforces publication facts through an internal adapter/provider boundary;
- provider-specific behavior is isolated behind a verifier interface;
- this document does NOT invent a provider.

---

## 3. AUTHORITATIVE SEAL VERIFICATION INTERFACE

### 3.1 Evidence and Authority

The authoritative Seal evidence is:
- server-side confirmation that the canonical Manifest was successfully committed with correct binding.

Frontend claims such as "sealed=true", success screens, URL state, and React state MUST NOT be authority.

### 3.2 Interface Contract

Conceptual inputs:
- lifecycleId;
- capsuleId;
- creatorIdentityId;
- upload-token / manifest publication reference.

Server MUST independently establish:
- correct capsuleId;
- correct lifecycleId;
- correct Creator Identity entitlement context;
- manifest exists and matches expected immutable manifest;
- integrity state confirms Vault/manifest consistency required by canonical contract;
- actual successful Seal state is reached;
- publication verification for this capsule/lifecycle is complete.

### 3.3 Evidence Binding

Authoritative Seal result MUST be bound to:
- capsuleId;
- lifecycleId;
- creatorIdentityId;
- publication result;
- canonical Manifest.

Frontend state MUST NOT create or modify Seal truth.

### 3.4 Seal State Model

Conceptual states:
- NOT_VERIFIED
- PENDING
- VERIFIED

Valid transitions:
- NOT_VERIFIED -> PENDING
- PENDING -> VERIFIED

---

## 4. FINALIZATION ENDPOINT CONTRACT

### 4.1 Conceptual Contract

The finalization authority performs:

CONSUMING
+
publication VERIFIED
+
Seal VERIFIED
+
correct binding

→ CONSUMED

It MUST NOT accept frontend claims as proof.

### 4.2 Request Inputs

Minimum required server-side inputs:
- lifecycleId;
- capsuleId;
- creatorIdentityId.

### 4.3 Authoritative Preconditions

Server MUST verify:
- Creator Credit exists and status is CONSUMING;
- Credit is bound to the supplied Creator Identity and lifecycleId;
- authoritative publication verification exists for this lifecycle/capsule;
- authoritative Seal verification exists for this lifecycle/capsule;
- lifecycle ownership is current and valid;
- no competing lifecycle owns this Credit.

### 4.4 Idempotency

Repeated finalization request for same lifecycle/capsule:
- MUST return existing authoritative finalization result;
- MUST NOT create another consumption event;
- MUST NOT alter already-CONSUMED state.

### 4.5 Serialization Boundary

Server MUST serialize finalization authority for the same Creator Credit against:
- recovery authority;
- new lifecycle reservation authority.

Only one authority may succeed for a given Credit at a time.

### 4.6 Failure Behavior

Failure cases:
- missing publication verification -> fail closed;
- missing Seal verification -> fail closed;
- wrong lifecycle binding -> reject;
- wrong Creator Identity -> reject;
- Credit not CONSUMING -> reject;
- duplicate finalization -> return existing result;
- storage unavailable -> fail closed, retry safe.

### 4.7 Result States

Conceptual results:
- CONSUMED;
- already CONSUMED idempotent result;
- reject with authoritative reason.

---

## 5. STATE MODEL AND UNIQUENESS BOUNDARIES

### 5.1 Minimum Conceptual Records

Credit Record:
- creatorCreditId;
- creatorIdentityId;
- status;
- lifecycleId;
- quote/payment binding identifiers;
- timestamps.

Lifecycle Record:
- lifecycleId;
- creatorIdentityId;
- creatorCreditId;
- capsuleId;
- status;
- publication verification state;
- Seal verification state;
- timestamps.

Publication Verification Record:
- lifecycleId;
- capsuleId;
- creatorIdentityId;
- publication evidence identifiers;
- authoritative verification result;
- verification timestamp.

Seal Verification Record:
- lifecycleId;
- capsuleId;
- creatorIdentityId;
- manifest binding;
- authoritative Seal result;
- verification timestamp.

### 5.2 Uniqueness Boundaries

- one Creator Credit MAY have at most one active/consuming lifecycle at a time;
- one lifecycleId maps to at most one Creator Credit;
- one capsuleId maps to at most one authoritative publication result for finalization;
- one lifecycle/capsule combination maps to at most one authoritative Seal result for finalization.

### 5.3 Storage Neutrality

Exact Cloudflare KV schema is implementation-selection PENDING.
The architecture MUST preserve these uniqueness boundaries regardless of storage implementation.

---

## 6. RECOVERY INTERFACE

### 6.1 State Transitions

Lifecycle:
- ACTIVE -> INTERRUPTED/UNKNOWN
- INTERRUPTED/UNKNOWN -> ACTIVE
- INTERRUPTED/UNKNOWN -> FAILED/ABORTED
- FAILED/ABORTED -> no automatic AVAILABLE restoration without explicit recovery authority

Credit:
- CONSUMING -> AVAILABLE ONLY after explicit recovery authority confirms:
  - no authoritative publication + Seal finalization exists;
  - lifecycle is legitimately failed/abandoned;
  - no competing lifecycle owns the Credit;
  - restoration is idempotent;
  - restoration cannot occur after authoritative final success.

### 6.2 Recovery Authority Interface

Conceptual recovery request:
- lifecycleId;
- capsuleId;
- creatorIdentityId.

Server MUST determine:
- current authoritative lifecycle state;
- current authoritative publication state;
- current authoritative Seal state;
- current Credit state;
- whether any competing lifecycle/ownership exists.

Allowed outcomes:
- resume existing lifecycle;
- abort lifecycle and restore Credit to AVAILABLE;
- return existing authoritative state without mutation.

### 6.3 No Arbitrary Timeout

Recovery MUST rely on authoritative evidence, not timers invented without architectural justification.
If heartbeat/reconciliation is needed:
- define it as an architectural responsibility interface;
- leave exact mechanism PENDING.

### 6.4 Serialization

Recovery authority MUST be serialized server-side against:
- finalization authority;
- new lifecycle reservation authority.

Only one authority may succeed for a given Credit at a time.

---

## 7. RACE CONDITION MODEL

### 7.1 Recovery vs Publication Success

- publication verification and recovery MUST NOT both create valid progress independently;
- finalization authority wins if publication completes while recovery is evaluating;
- recovery MUST NOT restore Credit if publication becomes VERIFIED before recovery commits.

### 7.2 Recovery vs Seal Success

- Seal verification advances lifecycle toward finalization;
- recovery MUST NOT restore Credit if Seal becomes VERIFIED before recovery commits;
- finalization authority wins over recovery.

### 7.3 Recovery vs Finalization

- recovery and finalization MUST be serialized;
- if finalization begins first, recovery sees CONSUMED and terminates;
- if recovery begins first but publication/Seal finalize before recovery commits, recovery sees authoritative final state and aborts restoration.

### 7.4 Duplicate Finalization

- duplicate finalization request MUST return existing CONSUMED result;
- server MUST track finalization state.

### 7.5 Late Publication Evidence

- late publication evidence for an already finalized lifecycle MUST be bound-checked;
- if lifecycle/Credit is CONSUMED, late evidence MUST NOT create another ownership or entitlement.

### 7.6 Late Seal Evidence

- same rule as publication evidence;
- late Seal evidence MUST be bound to exact lifecycle/capsule/Creator Identity.

### 7.7 New Lifecycle While Old Lifecycle Is Unresolved

- new lifecycle request for same Creator Credit MUST be rejected while old lifecycle is unresolved/active;
- new lifecycle MAY proceed only after old lifecycle is in a terminal state that does not own the Credit.

### 7.8 Required Invariants

- ONE Credit -> MAXIMUM ONE active lifecycle owner;
- ONE lifecycle -> MAXIMUM ONE finalization.

---

## 8. EXISTING CODE MAPPING

### 8.1 functions/api/capsule/seal.ts

Current responsibility:
- manifest structural validation;
- upload-token enforcement;
- payment authority enforcement;
- Vault pointer verification via Irys gateway;
- manifest commit;
- authority token persistence;
- deletion of payment/quote/token authority.

Missing responsibility:
- no authoritative Seal verification record;
- no Credit finalization transition CONSUMING -> CONSUMED;
- no binding of Seal result to Creator Identity/lifecycleId/Credit state.

Future contract:
- Seal endpoint remains the irreversible event boundary;
- after manifest commit, Seal endpoint records authoritative Seal verification result;
- finalization remains a separate authority after Seal verification is established.

### 8.2 functions/api/upload.ts

Current responsibility:
- upload-token validation;
- ciphertext/chunk ingestion;
- publication via Executor Hot;
- storage pointer registry.

Missing responsibility:
- no authoritative publication verification record;
- no binding of publication result to lifecycle/capsule/Creator Identity;
- no publication state transition to VERIFIED for downstream finalization.

Future contract:
- upload/publication result becomes authoritative input for publication verification;
- publication verification endpoint/interface consumes publication outcome and transitions publication state to VERIFIED.

### 8.3 functions/api/creator/reserve-lifecycle.ts

Current responsibility:
- Credit AVAILABLE -> CONSUMING transition;
- lifecycle ownership binding to Creator Identity and Credit;
- idempotency for repeated reserve requests.

Missing responsibility:
- no publication verification interface;
- no Seal verification interface;
- no finalization endpoint;
- no recovery authority interface.

Future contract:
- reserve-lifecycle continues to own reservation semantics;
- finalization/recovery/new-lifecycle interfaces consult reserve-lifecycle state for Credit ownership.

### 8.4 Current Storage Authority

- `VERIFIED_PAYMENTS` currently stores payment authorization;
- `UPLOAD_TOKENS` currently stores upload authorization;
- `CAPSULE_MANIFESTS` currently stores manifest authority;
- `AUTHORITY_TOKENS` currently stores seal authority fragment;
- `CREATOR_CREDITS` currently stores Credit/lifecycle reservation state;
- `CREATOR_IDENTITIES` currently stores identity proof state.

Missing state stores/interfaces:
- authoritative publication verification records bound to lifecycle/capsule/Creator Identity;
- authoritative Seal verification records bound to lifecycle/capsule/Creator Identity;
- finalization audit record;
- recovery state/history.

Exact storage naming/schema remains implementation-selection PENDING.

---

## 9. SECURITY ATTACK MODEL

A. Fake publication ID
PENDING — blocked in interface by requiring authoritative source verification; exact verifier/provider PENDING.

B. Another capsule publication
PASS — publication evidence MUST be bound to exact lifecycle/capsule/Creator Identity.

C. Fake Seal
PASS — Seal authority is established server-side from manifest commit and authoritative publication verification; frontend cannot create Seal truth.

D. Another capsule Seal
PASS — Seal verification is bound to exact lifecycle/capsule/Creator Identity.

E. Replay publication evidence
PASS — server tracks publication verification state; duplicate returns existing result.

F. Replay Seal evidence
PASS — server tracks Seal state; duplicate returns existing result.

G. Duplicate finalization
PASS — finalization endpoint tracks finalization state and returns existing result.

H. Wrong lifecycleId
PASS — all finalization inputs are bound-checked against authoritative reservation state.

I. Wrong capsuleId
PASS — publication/Seal/finalization bindings enforce capsuleId match.

J. Wrong Creator Identity
PASS — Credit, lifecycle, publication, Seal, and finalization are bound to immutable Creator Identity.

K. Recovery race into successful finalization
PASS — recovery and finalization are serialized server-side; only one authority may succeed.

L. Late publication after recovery
PASS — recovery requires absence of authoritative publication + Seal; late publication after recovery must fail because state is no longer CONSUMING or recovery was invalid.

M. Late Seal after recovery
PASS — same rule as publication.

N. Frontend forged state
PASS — frontend cannot create/modify authoritative publication, Seal, finalization, or recovery state.

---

## 10. CANONICAL CONSISTENCY

### 10.1 Alignment Check

- WP-5/Creator Identity: unchanged; finalization/recovery bind to immutable Creator Identity.
- WP-6/Creator Credit: preserved; CONSUMING -> CONSUMED requires publication + Seal; CONSUMING -> AVAILABLE only via explicit recovery authority.
- WP-7/Service Payment: unchanged; payment remains upstream prerequisite.
- WP-8/Capsule Lifecycle: preserved; lifecycleId is authoritative owner during CONSUMING.
- WP-9/Upload Token: preserved; upload authorization remains upstream of publication.
- WP-10/Publication, Seal, Recovery: this document refines WP-10 into explicit runtime interfaces without changing canonical semantics.

### 10.2 Ambiguities

Explicit ambiguities remaining in canonical documentation:
- exact Irys publication verification provider/mechanism;
- exact Seal verification implementation;
- exact recovery timeout/policy;
- exact Cloudflare data-store schema for publication/Seal/finalization/recovery records.

This document marks these PENDING and defines minimum safe interface contracts.

### 10.3 Contradictions

No contradictions found in current canonical documentation that require silent rewrite.
If a contradiction is discovered later, it MUST be reported explicitly.

---

## 11. IMPLEMENTATION PENDING DECISIONS

- exact Irys publication verification provider/adapter;
- exact publication finality threshold;
- exact Seal verification adapter/implementation;
- exact recovery timeout/policy, if any;
- exact heartbeat/reconciliation mechanism, if any;
- exact Cloudflare KV keys/schema for publication, Seal, finalization, recovery state;
- exact route names/endpoint surface for publication verification, finalization, recovery.

---

## 12. MINIMUM IMPLEMENTATION WORK REQUIRED

1. Implement authoritative publication verification interface:
   - server-side verifier boundary;
   - publication state records;
   - binding to lifecycle/capsule/Creator Identity.

2. Implement authoritative Seal verification interface:
   - server-side Seal state record;
   - binding to lifecycle/capsule/Creator Identity/publication result.

3. Implement finalization endpoint:
   - enforce publication VERIFIED + Seal VERIFIED + correct binding;
   - atomic CONSUMING -> CONSUMED;
   - idempotent duplicate handling;
   - serialization against recovery and new reservation.

4. Implement recovery authority interface:
   - evaluate authoritative publication/Seal/lifecycle/Credit state;
   - allow resume or restore-to-AVAILABLE only when safe;
   - serialize against finalization and new reservation.

5. Bind existing endpoints to new interfaces without changing crypto, storage, manifest, Vault, or Emergency Runtime semantics.

---
