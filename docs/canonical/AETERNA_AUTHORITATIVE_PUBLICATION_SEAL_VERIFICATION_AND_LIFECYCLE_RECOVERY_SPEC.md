# AETERNA — Authoritative Publication, Seal Verification and Lifecycle Recovery Architecture Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_END_TO_END_CREATOR_CAPSULE_FLOW_IMPLEMENTATION_READINESS_REVIEW.md
- AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- Irys official documentation:
  - https://docs.irys.xyz/build/d/features/supported-tokens
  - https://docs.irys.xyz/build/d/irys-in-the-browser
  - https://docs.irys.xyz/build/d/quickstart
  - https://docs.irys.xyz/build/d/sdk/setup
  - https://docs.irys.xyz/build/d/networks

---

## 1. PURPOSE

This document defines the exact architectural contracts for:

- authoritative publication verification;
- authoritative Seal verification;
- final Credit consumption;
- stale/interrupted lifecycle recovery.

This document does NOT implement the capsule runtime, storage,
encryption, Seal logic, Irys integration, or protocol core.

## 2. SCOPE

This specification covers:

- authoritative publication evidence requirements;
- authoritative Seal evidence requirements;
- finalization sequence and atomicity;
- recovery state machine;
- interrupted lifecycle handling;
- cross-layer authority boundaries;
- Cloudflare architectural responsibilities.

This specification explicitly excludes:

- payment endpoint implementation;
- wallet integration;
- Irys implementation;
- UI;
- crypto;
- storage;
- CapsuleHold implementation;
- Seal implementation;
- package.json;
- wrangler.toml.

## 3. AUTHORITATIVE PUBLICATION VERIFICATION

### 3.1 Client-reported publication vs authoritative evidence

Client-reported publication:
- uploaded=true;
- publication successful;
- transaction hash submitted;
- Irys SDK callback;
- local React state.

These MUST NOT independently establish publication success.

Authoritative publication evidence is evidence established by the
server-side/canonical lifecycle authority from a trusted source.

### 3.2 Authoritative publication source and minimum evidence requirements

The server/lifecycle authority MUST independently establish:

- publication identifier;
- storage/publication network;
- authoritative provider/source;
- capsule/vault identifier association;
- manifest association where canonical;
- immutable publication result;
- verification of object existence/availability through an authoritative source;
- correct association between the published artifact and the lifecycle/capsule.

Primary authoritative source:
- Irys Node/API.

Secondary signal:
- gateway propagation/availability may be used as an additional availability signal.
- Gateway is NOT standalone finality authority.

Client-supplied publicationId / txHash / providerRef:
- evidence references only;
- MUST NOT be treated as authority.

The exact Irys Node/API endpoint/response fields remain implementation-selection PENDING.

### 3.3 Payment and publication authority separation

AETERNA Service Payment:
- $1.00 USDC;
- exactly 1 Creator Credit;
- exactly 1 capsule creation entitlement.

Irys publication/storage:
- paid separately by the creator;
- separate economic layer from AETERNA Service Payment;
- AETERNA $1 does NOT include Irys fees.

Executor Hot:
- NOT canonical target architecture;
- NOT AETERNA payment authority;
- NOT canonical publication authority;
- NOT canonical verifier;
- current presence in implementation is implementation residue only.

No implementation may treat Executor Hot as canonical publication verification source.

## 4. PUBLICATION EVIDENCE INTEGRITY

To prevent substitution attacks, the server must establish that:

published artifact
↔ current capsule lifecycle
↔ current Creator Identity / entitlement context where applicable
↔ expected manifest/vault association

The server MUST reject:

- arbitrary publication IDs;
- another user's transaction;
- another capsule's manifest;
- stale publication evidence;
- frontend-selected publication result.

Conceptual binding fields:

- lifecycle identifier;
- Creator Identity;
- capsule/vault identifier;
- manifest identifier where canonical;
- publication identifier;
- publication network;
- authoritative verification timestamp/result.

No specific database schema is invented here.

## 5. PUBLICATION FINALITY / AVAILABILITY

Publication success requires:

- payment to Irys or equivalent publication payment;
- upload submitted;
- transaction submitted;
- transaction confirmed;
- publication accepted;
- publication retrievable;
- publication final/immutable.

Only the condition selected as canonical success may allow the lifecycle
to advance.

Canonical finality rule:
- FINALITY THRESHOLD = provider-defined authoritative signal.
- Do NOT introduce artificial numeric confirmation counts.
- Do NOT introduce arbitrary timeouts.

VERIFIED requires:
- exact publication/data-item identifier confirmed by authoritative Irys source;
- correct Irys network confirmed;
- artifact existence confirmed;
- required availability signal successful;
- AETERNA binding matches:
  - creatorIdentityId
  - lifecycleId
  - capsuleId
- no unresolved/unknown conditions.

UNKNOWN / PENDING / provider unavailable:
- MUST NOT become VERIFIED;
- fail-closed.

If provider does not provide sufficient authoritative signal:
→ PENDING/UNKNOWN
→ NOT VERIFIED.

Mandatory:

- publication must be retrievable/available through an authoritative source;
- publication must be associated with the correct lifecycle/capsule;
- publication result must be immutable once verified.

Provider-specific:

- exact confirmation count/finality threshold per network/provider;
- exact availability check mechanism.

## 6. AUTHORITATIVE SEAL VERIFICATION

### 6.1 Frontend claims are insufficient

Frontend claims such as:
- sealed=true;
- success screen;
- API callback alone;
- local state;
- URL state

are NOT sufficient.

### 6.2 Required authoritative Seal evidence

The server/lifecycle authority MUST independently establish:

- Seal identifier or equivalent;
- correct capsule association;
- correct lifecycle identifier association;
- correct Creator Credit association;
- correct Creator Identity association;
- correct publication result association;
- canonical manifest/Seal state where applicable.

The exact Seal verification implementation may remain
implementation-selection PENDING.

### 6.3 Security invariant

CONSUMING
→ CONSUMED
MUST require:
AUTHORITATIVE PUBLICATION SUCCESS
AND
AUTHORITATIVE SEAL SUCCESS.

### 6.4 Seal commit and authoritative Seal verification

Seal commit is the irreversible manifest boundary.
Seal commit alone is NOT automatically authoritative Seal verification.

Separate seal/verify remains required to establish authoritative Seal evidence.

### 6.5 Publication / Seal / Finalize order

Canonical target order:
- upload;
- publication verification;
- seal;
- seal/verify;
- finalize-credit;
- Creator Credit CONSUMED.

Reason:
seal is irreversible manifest boundary;
publication must be independently verified before irreversible seal commit.

## 7. SEAL EVIDENCE BINDING

Authoritative Seal evidence MUST be bound to:

- the correct capsule;
- the correct lifecycle identifier;
- the correct Creator Credit;
- the correct Creator Identity;
- the correct publication result;
- the canonical manifest/Seal state where applicable.

Prevented attacks:

- another capsule's Seal evidence;
- replay of a previous successful Seal;
- client-forged Seal status;
- finalizing an unrelated lifecycle.

## 8. FINALIZATION CONTRACT

Exact conceptual finalization sequence:

1. Credit is CONSUMING.
2. Lifecycle is authoritative ACTIVE.
3. Publication is independently verified.
4. Seal is independently verified.
5. All bindings match the same lifecycle/capsule/Creator Identity.
6. Server atomically transitions:
   CONSUMING → CONSUMED.
7. Retry returns the already-finalized result without creating another
   consumption.

Requirements:

- final transition is server-authoritative;
- final transition is atomic/serialized;
- final transition is idempotent;
- final transition is bound to one lifecycle identifier.

No frontend event may perform or force final consumption.

## 9. STALE / INTERRUPTED LIFECYCLE

### 9.1 Distinction required

The architecture MUST distinguish:

A. an active lifecycle that is still legitimately progressing;

from

B. an abandoned/interrupted lifecycle that should eventually allow Credit recovery.

### 9.2 Required signals/evidence

The architecture MAY use:

- lifecycle heartbeat;
- explicit lifecycle status;
- progress evidence;
- publication status;
- Seal status;
- authoritative server-side reconciliation;
- explicit abort;
- resumability.

### 9.3 Constraints

The design MUST avoid:

- permanent Credit lock for an honest creator;
- automatic recovery while a legitimate lifecycle may still finish;
- double ownership;
- duplicate publication entitlement;
- duplicate finalization.

### 9.4 No arbitrary timeout

Do NOT invent an arbitrary timeout without architectural justification.

If a recovery timeout is used, it must be explicitly justified and
architecturally bounded.

## 10. RECOVERY STATE MACHINE

### 10.1 Canonical states

CREDIT:
- AVAILABLE
- CONSUMING
- CONSUMED

LIFECYCLE:
- NOT_STARTED
- ACTIVE
- INTERRUPTED / UNKNOWN
- FAILED / ABORTED
- SUCCESSFUL

PUBLICATION:
- NOT_VERIFIED
- PENDING
- VERIFIED

SEAL:
- NOT_VERIFIED
- PENDING
- VERIFIED

### 10.2 Valid transitions

- NOT_STARTED -> ACTIVE
- ACTIVE -> INTERRUPTED / UNKNOWN
- ACTIVE -> FAILED / ABORTED
- ACTIVE -> SUCCESSFUL
- INTERRUPTED / UNKNOWN -> ACTIVE
- INTERRUPTED / UNKNOWN -> FAILED / ABORTED
- CONSUMING -> AVAILABLE
- CONSUMING -> CONSUMED
- NOT_VERIFIED -> PENDING
- PENDING -> VERIFIED
- PENDING -> NOT_VERIFIED

### 10.3 Forbidden transitions

- CONSUMED -> AVAILABLE without explicit recovery from canonical Creator
  Credit specification;
- two ACTIVE lifecycles for the same Credit;
- frontend state transitions without server authority;
- CONSUMING -> CONSUMED without authoritative publication success and
  authoritative Seal success.

## 11. UNKNOWN STATE HANDLING

### 11.1 Hard cases

A. client loses response after publication succeeds;
B. client loses response after Seal succeeds;
C. server times out after publication;
D. server times out after Seal;
E. browser crashes during CONSUMING;
F. browser closes;
G. Irys publication is delayed;
H. publication exists but is temporarily unreachable;
I. Seal result is delayed;
J. user returns later;
K. client retries after unknown state.

### 11.2 Requirements

- The system MUST NOT resolve an UNKNOWN state based solely on frontend claims.
- Recovery MUST rely on authoritative evidence.
- The architecture MUST support safe retry and authoritative state reconciliation.
- The exact recovery mechanism is implementation-selection PENDING.

## 12. SAFE CREDIT RESTORATION

### 12.1 Conditions for CONSUMING -> AVAILABLE

CONSUMING -> AVAILABLE is allowed ONLY when:

- no authoritative successful publication + Seal exists;
- lifecycle is established as failed/abandoned according to the canonical recovery process;
- no competing lifecycle has gained ownership;
- restoration is idempotent;
- restoration cannot happen after authoritative final success.

### 12.2 No arbitrary timeout

Do NOT invent a fixed recovery timeout unless canonically justified.

If a recovery/reconciliation process is needed, define it as an
architectural responsibility and mark exact implementation details PENDING.

## 13. PROTECTION AGAINST RACE DURING RECOVERY

### 13.1 Tested scenarios

- recovery runs while publication completes;
- recovery runs while Seal completes;
- user retries while recovery is running;
- two recovery attempts run simultaneously;
- user starts a new capsule while old lifecycle is unresolved;
- old lifecycle later produces successful publication;
- old lifecycle later produces successful Seal.

### 13.2 Guarantee

ONE CREDIT
→ never two active owners.

A late successful finalization of an old lifecycle cannot silently create
a second capsule entitlement.

### 13.3 Required boundary

The architecture MUST serialize:

- recovery authority;
- finalization authority;
- new lifecycle reservation authority;

for the same Creator Credit.

Only one authority may succeed for a given Credit at a time.

## 14. RESUMABILITY

### 14.1 Determination

An interrupted lifecycle MAY be:

- resumable;
- recoverable then retryable as a new lifecycle;
- explicitly aborted;
- some combination depending on state.

The exact policy is implementation-selection PENDING.

### 14.2 Minimum contract

The architecture MUST support:

- safe restoration of legitimate interrupted lifecycles without permanent Credit loss;
- prevention of duplicate lifecycle ownership;
- prevention of duplicate final consumption;
- authoritative server-side state reconciliation.

If the canonical documents do not decide the exact policy:
mark it PENDING and explain the minimum security/reliability contract
required.

## 15. HONEST USER RECOVERY

### 15.1 Supported cases

The architecture MUST support:

- browser reload;
- browser crash;
- temporary network outage;
- delayed publication;
- delayed Seal;
- lost API response;
- user returning later.

### 15.2 Rule

The user must not be forced to pay a second $1 merely because the first
lifecycle was interrupted, unless the architecture establishes that the
Credit was already correctly consumed.

Recovery MUST rely on authoritative evidence, not frontend claims.

## 16. ATTACK REVIEW

A. Fake publication success
PASS — only authoritative publication evidence may advance lifecycle;
frontend claims are insufficient.

B. Fake Seal success
PASS — only authoritative Seal evidence may finalize Credit;
frontend claims are insufficient.

C. Another capsule's publication ID
PASS — publication evidence is bound to lifecycle/capsule/Creator Identity.

D. Another capsule's Seal evidence
PASS — Seal evidence is bound to lifecycle/capsule/Creator Identity.

E. Replayed publication evidence
PASS — server tracks publication verification state; replay returns existing result.

F. Replayed Seal evidence
PASS — server tracks Seal verification state; replay returns existing result.

G. Client changes lifecycle ID
PASS — lifecycle ID must be server-issued and bound to reserved Credit;
forged ID cannot obtain ownership.

H. Client changes capsule ID
PASS — capsule ID is bound to lifecycle and Credit server-side.

I. Client changes Creator Identity
PASS — Credit and lifecycle are bound to immutable Creator Identity.

J. Recovery while publication completes
PASS — recovery and finalization are serialized; only one authority may succeed.

K. Recovery while Seal completes
PASS — recovery and finalization are serialized; only one authority may succeed.

L. Duplicate recovery requests
PASS — server tracks recovery state; duplicate recovery returns existing state.

M. Duplicate finalization requests
PASS — server tracks finalization state; duplicate finalization returns existing CONSUMED result.

N. New lifecycle while old lifecycle unresolved
PASS — one Credit per active lifecycle; new lifecycle cannot start until old lifecycle is resolved.

O. Late publication of old lifecycle
PASS — recovery/finalization authority is serialized; late publication must match existing binding.

P. Late Seal of old lifecycle
PASS — recovery/finalization authority is serialized; late Seal must match existing binding.

Q. Browser crash
PENDING — recovery mechanism PENDING, but architecture supports safe restoration.

R. Lost server response
PASS — retry sees existing server-side state; no duplicate state transition.

S. Retry after unknown state
PASS — server authoritative state determines outcome; no frontend authority.

T. Two devices recover same lifecycle
PASS — recovery is serialized server-side; at most one recovery succeeds.

U. Two tabs recover same lifecycle
PASS — recovery is serialized server-side; at most one recovery succeeds.

V. Modified localStorage/sessionStorage/React/URL state
PASS — frontend state is never authoritative for lifecycle, publication, Seal, or Credit state.

## 17. CROSS-LAYER AUTHORITY

Authority boundaries:

- Payment Layer:
  verified payment -> Creator Credit entitlement.
- Creator Credit Layer:
  Credit state -> permission to begin one capsule lifecycle.
- Capsule Lifecycle Layer:
  lifecycle -> publication evidence + Seal evidence.
- Finalization Authority:
  authoritative publication evidence + authoritative Seal evidence + correct lifecycle binding -> CONSUMED.
- Recovery Authority:
  authoritative lifecycle evidence -> either continue, fail/abort, or restore Credit.

No layer may infer another layer's authority from client state.
Each layer must enforce its own authority server-side.

## 18. CLOUDFLARE RESPONSIBILITY BOUNDARY

Architectural responsibilities:

- publication verification orchestration:
  server coordinates authoritative publication evidence;
- Seal verification orchestration:
  server coordinates authoritative Seal evidence;
- finalization:
  server atomically transitions CONSUMING -> CONSUMED only after authoritative evidence;
- recovery:
  server determines when interrupted lifecycle may be resumed, aborted, or restored;
- state serialization:
  server serializes recovery, finalization, and new lifecycle attempts for same Credit;
- identity binding:
  server binds publication, Seal, finalization, and recovery to immutable Creator Identity.

Rules:

- All finalization and recovery decisions MUST be authoritative server-side.
- Frontend MAY display state.
- Frontend MUST NOT create, modify, or prove lifecycle, publication, Seal, or Credit state.
- Endpoints MUST be browser-compatible.
- Endpoints MUST NOT depend on Node-only runtime assumptions.
- Implementation MAY be hosted on Cloudflare Pages/Workers.

## 19. OBSERVABILITY / AUDIT

Mandatory security facts:

The server MUST maintain authoritative state sufficient to reconstruct:

- publication verification result;
- Seal verification result;
- final Credit consumption;
- recovery transitions;
- duplicate/replay rejection;
- lifecycle ownership history.

Non-blocking recommendations:

- rate limiting on finalization and recovery endpoints;
- audit logging for publication, Seal, finalization, and recovery events;
- anomaly detection for unusual recovery/finalization patterns.

## 20. UNRESOLVED IMPLEMENTATION DECISIONS

Genuinely unresolved and implementation-selection PENDING:

- exact Irys publication verification mechanism/provider;
- exact Irys finality threshold;
- exact publication availability check mechanism;
- exact Seal verification implementation;
- exact lifecycle heartbeat/reconciliation mechanism;
- exact recovery timeout/policy;
- exact Cloudflare Pages/Workers route names;
- exact Cloudflare data-store implementation;
- exact endpoint names.

Security/architectural invariants that MUST already be explicit:

- authoritative publication evidence required for final consumption;
- authoritative Seal evidence required for final consumption;
- server-side authority for all finalization and recovery decisions;
- atomic/serialized finalization bound to lifecycle;
- safe restoration of legitimate interrupted lifecycles;
- prevention of duplicate ownership/consumption during recovery;
- frontend non-authority.

## 21. CANONICAL CONSISTENCY

Verified against:

- AETERNA_END_TO_END_CREATOR_CAPSULE_FLOW_IMPLEMENTATION_READINESS_REVIEW.md
- AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md

No contradictions found.

If a contradiction is discovered in future, it MUST be reported rather
than silently changing other canonical documents.

## 22. REFERENCES

- AETERNA_END_TO_END_CREATOR_CAPSULE_FLOW_IMPLEMENTATION_READINESS_REVIEW.md
- AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- Irys official documentation:
  - https://docs.irys.xyz/build/d/features/supported-tokens
  - https://docs.irys.xyz/build/d/irys-in-the-browser
  - https://docs.irys.xyz/build/d/quickstart
  - https://docs.irys.xyz/build/d/sdk/setup
  - https://docs.irys.xyz/build/d/networks
