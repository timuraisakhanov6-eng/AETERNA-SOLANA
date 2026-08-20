# AETERNA — Creator Credit Consumption & Capsule Creation Interface Architecture Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
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

This document defines the exact architectural contract between:

Creator Identity
→ Creator Credit
→ Capsule Creation Lifecycle
→ Irys Publication
→ Seal
→ final Credit consumption

This document does NOT implement the capsule runtime, storage,
encryption, Seal semantics, Irys integration, or protocol core.

## 2. SCOPE

This specification covers:

- Creator Credit authority and binding;
- atomic Credit reservation for capsule creation;
- lifecycle ownership;
- failure, abort, and recovery rules;
- final consumption conditions;
- cross-layer authority boundaries;
- idempotency and concurrency contracts;
- Cloudflare architectural responsibilities.

This specification explicitly excludes:

- payment endpoint implementation;
- wallet integration;
- Irys integration;
- UI;
- crypto;
- storage;
- CapsuleHold implementation;
- Seal implementation;
- package.json;
- wrangler.toml.

## 3. CREATOR CREDIT AUTHORITY

Creator Credit authority:

- Creator Credit is the authoritative entitlement for one capsule
  creation attempt.
- Creator Credit is bound to one authenticated Creator Identity.
- Creator Credit state is authoritative server-side.
- Frontend state is NEVER authoritative for Credit state.

Canonical Credit states:

- AVAILABLE
- CONSUMING
- CONSUMED

Valid transitions:

- AVAILABLE -> CONSUMING
- CONSUMING -> AVAILABLE
- CONSUMING -> CONSUMED

Forbidden transitions:

- AVAILABLE -> CONSUMED without CONSUMING;
- CONSUMED -> AVAILABLE without explicit recovery from canonical Creator
  Credit specification;
- any transition that creates more than one Credit from one verified
  payment.

## 4. CAPSULE CREATION ATTEMPT

A capsule creation attempt is a server-tracked lifecycle identifier for one
attempt to consume one Creator Credit.

When an attempt begins:

- The server atomically reserves one AVAILABLE Creator Credit for the
  authenticated Creator Identity;
- The server records a lifecycle identifier bound to that Creator Identity
  and that Creator Credit;
- The lifecycle is now the authoritative owner of the Credit while state
  is CONSUMING.

One Credit MAY have at most one active lifecycle at a time.

Two simultaneous requests MUST produce:

ONE successful reservation
and
ONE rejection / already-in-use result.

## 5. ATOMIC CREDIT RESERVATION

Reservation contract:

- server-authoritative;
- atomic;
- serialized;
- bound to one Creator Identity;
- bound to one capsule lifecycle identifier.

Reservation transition:

AVAILABLE -> CONSUMING

Requirements:

- The server MUST serialize reservation attempts for the same Creator
  Credit.
- Frontend state MUST NOT determine whether reservation succeeded.
- A lost server response after successful reservation MUST NOT allow a
  second successful reservation of the same Credit.

Idempotency:

- A repeated reservation request for the same lifecycle MUST return the
  existing reservation state or equivalent already-processed result.
- The server MUST track reservation state to enforce idempotency without
  inventing a specific database schema.

## 6. LIFECYCLE OWNERSHIP

Lifecycle ownership means:

- The lifecycle identifier is the authoritative owner of the Credit while
  state is CONSUMING.
- Ownership is bound to one Creator Identity.
- Ownership is bound to one Creator Credit.
- Ownership MUST NOT be inferred from frontend state.
- Ownership MUST NOT move to another request, lifecycle, or identity
  without explicit server authority.

If another request claims the same Credit:

- The server MUST reject the claim while the Credit is CONSUMING.
- Only the owning lifecycle may proceed toward final consumption.

## 7. FAILURE, ABORT, AND RECOVERY

Canonical failure handling:

- preparation failure -> lifecycle aborted -> Credit restored to AVAILABLE;
- encryption failure -> lifecycle aborted -> Credit restored to AVAILABLE;
- upload start failure -> lifecycle aborted -> Credit restored to AVAILABLE;
- upload interruption -> lifecycle aborted -> Credit restored to AVAILABLE;
- Irys payment failure -> lifecycle aborted -> Credit restored to AVAILABLE;
- Irys publication failure -> lifecycle aborted -> Credit restored to
  AVAILABLE;
- publication verification failure -> lifecycle aborted -> Credit restored
  to AVAILABLE;
- seal failure -> lifecycle aborted -> Credit restored to AVAILABLE;
- browser crash -> lifecycle aborted -> Credit restored to AVAILABLE;
- tab close -> lifecycle aborted -> Credit restored to AVAILABLE;
- network interruption -> lifecycle aborted -> Credit restored to AVAILABLE;
- server timeout -> lifecycle aborted -> Credit restored to AVAILABLE;
- client retry -> idempotent; no duplicate lifecycle or Credit.

Restoration rule:

- CONSUMING -> AVAILABLE is allowed only on failure before successful
  final result.
- Successful final result is defined by Section 8 only.

Stale CONSUMING recovery:

- A legitimate interrupted lifecycle MUST be distinguishable from an
  attacker replaying or duplicating lifecycle requests.
- The architecture MUST allow recovery without permanently locking a
  legitimate user's Credit.
- The architecture MUST NOT allow interruption/retry behavior to create
  two simultaneous capsule lifecycles.
- Exact recovery mechanism is implementation-selection PENDING, but the
  architectural interface contract MUST support safe restoration.

## 8. FINAL CONSUMPTION

Creator Credit becomes CONSUMED ONLY after ALL of the following:

1. required publication has successfully completed;
2. canonical Seal has successfully completed;
3. capsule reaches the successful sealed result.

Forbidden consumption triggers:

- Create click alone;
- preparation success alone;
- upload start alone;
- Irys payment alone;
- any partial success before canonical sealed result.

Only the authoritative server-side/canonical lifecycle evidence may
trigger final consumption.

Frontend claims such as UI status, localStorage flags, or React state
MUST NOT trigger final consumption.

## 9. CROSS-LAYER AUTHORITY

Authority boundaries:

- Payment Layer:
  verified payment -> Creator Credit entitlement.
- Creator Credit Layer:
  Credit state -> permission to begin one capsule lifecycle.
- Capsule Lifecycle Layer:
  successful publication + Seal -> final Credit consumption.

No layer may infer the authority of another layer from frontend state.
Each layer must enforce its own authority server-side.

## 10. CREATOR IDENTITY IMMUTABILITY

During an active lifecycle:

- Creator Identity MUST remain immutable;
- bound payment account MUST remain immutable for the relevant step;
- wallet/account/network/provider switching MUST NOT silently transfer
  lifecycle ownership;
- a new identity MUST NOT inherit the old Credit or lifecycle.

If the user changes wallet/account/network/provider during an active
lifecycle:

- the active lifecycle MUST be treated as aborted;
- Creator Credit MUST be restored to AVAILABLE if it was CONSUMING;
- a new lifecycle requires re-establishing Creator Identity.

## 11. RETRY AND IDEMPOTENCY

Conceptual idempotency rules:

- reserve Credit:
  repeated reserve requests for same Creator Identity/lifecycle context
  MUST NOT create duplicate reservation;
- begin lifecycle:
  repeated begin requests for same reserved Credit MUST return existing
  lifecycle or equivalent already-processed result;
- retry preparation:
  safe retry within same lifecycle MUST NOT duplicate lifecycle ownership;
- retry upload:
  safe retry within same lifecycle MUST NOT duplicate entitlement;
- retry publication verification:
  safe retry MUST NOT duplicate Credit or lifecycle authority;
- retry Seal:
  safe retry MUST NOT duplicate final consumption;
- final Credit consumption:
  repeated finalization requests for same lifecycle MUST return existing
  CONSUMED result or equivalent already-processed result.

Lost response handling:

- A lost response after successful reservation MUST NOT allow a second
  successful reservation of the same Credit.
- The server MUST track reservation and lifecycle state to make retries
  safe without client-side authority.

## 12. STATE MACHINE

Conceptual canonical state machine:

CREDIT:
- AVAILABLE
- CONSUMING
- CONSUMED

LIFECYCLE:
- NOT_STARTED
- ACTIVE
- FAILED / ABORTED
- SUCCESSFUL

Valid transitions:

- AVAILABLE -> CONSUMING
- CONSUMING -> AVAILABLE
- CONSUMING -> CONSUMED
- NOT_STARTED -> ACTIVE
- ACTIVE -> FAILED / ABORTED
- ACTIVE -> SUCCESSFUL

Forbidden transitions:

- AVAILABLE -> CONSUMED without CONSUMING and SUCCESSFUL lifecycle;
- CONSUMED -> AVAILABLE without explicit recovery from canonical Creator
  Credit specification;
- two ACTIVE lifecycles for the same Credit;
- frontside state transitions without server authority.

## 13. SECURITY INVARIANTS

Explicit guarantees:

- one Credit cannot be reserved twice concurrently;
- one lifecycle cannot own two Credits accidentally;
- one Creator Identity cannot transfer a Credit to another identity;
- frontend cannot create or fake CONSUMING;
- frontend cannot create or fake CONSUMED;
- retries cannot duplicate state transitions;
- failed lifecycle cannot silently lose or duplicate Credit;
- successful publication + Seal is the only final consumption condition;
- server-side authority is required for every state transition.

## 14. ATTACK-SCENARIO REVIEW

A. Two simultaneous CREATE requests
PASS — server serializes Credit reservation; at most one ACTIVE lifecycle
per Credit.

B. Same Credit from two browser tabs
PASS — server-side reservation is authoritative; second tab receives
already-in-use or equivalent rejection.

C. Same Credit from two devices
PASS — server-side reservation is bound to Creator Identity and Credit;
second device cannot obtain second reservation.

D. Modified localStorage
PASS — frontend storage is never authoritative for Credit or lifecycle
state.

E. Modified sessionStorage
PASS — frontend storage is never authoritative.

F. Modified React state
PASS — frontend state is never authoritative.

G. Modified URL
PASS — URL parameters are never authoritative for Credit or lifecycle.

H. Forged lifecycle ID
PASS — lifecycle ID must be server-issued and bound to reserved Credit;
forged ID cannot obtain ownership.

I. Replayed reservation request
PASS — server tracks reservation state; replay returns existing state or
already-processed result.

J. Duplicate finalization request
PASS — server tracks lifecycle and Credit state; duplicate finalization
returns existing CONSUMED result or equivalent already-processed result.

K. Lost server response followed by retry
PASS — retry sees existing server-side reservation or lifecycle state;
no duplicate state transition.

L. Browser crash after CONSUMING
PENDING — recovery depends on distinguishing legitimate interrupted
lifecycle from attacker replay; exact mechanism remains PENDING, but the
architecture MUST support safe restoration without permanent Credit loss.

M. Network failure after CONSUMING
PENDING — same reasoning as L; architecture must allow safe retry and
authoritative state reconciliation.

N. Irys publication failure
PASS — lifecycle aborted; Credit restored to AVAILABLE per canonical
failure rules.

O. Seal failure
PASS — lifecycle aborted; Credit restored to AVAILABLE per canonical
failure rules.

P. Wallet switch during lifecycle
PASS — treated as new identity; active lifecycle aborted; Credit restored
to AVAILABLE.

Q. Account switch during lifecycle
PASS — treated as new identity/account; active lifecycle aborted; Credit
restored to AVAILABLE.

R. Network switch during lifecycle
PASS — treated as potential identity change; active lifecycle aborted;
Credit restored to AVAILABLE.

S. Attempt to bind another Creator Identity
PASS — Credit is bound to one Creator Identity; new identity cannot claim
existing Credit or lifecycle.

T. Attempt to use one Credit for two lifecycle IDs
PASS — one Credit MAY have at most one active lifecycle; second lifecycle
is rejected.

## 15. CAPSULE / SEAL INTERFACE CONTRACT

This section defines the conceptual interface that the downstream capsule
runtime must provide to the Credit layer.

The Credit layer MUST NOT trust frontend claims for lifecycle outcomes.
Final state MUST be established by authoritative server-side/canonical
lifecycle evidence.

Conceptual signals/results:

- lifecycle started:
  server records ACTIVE lifecycle bound to reserved Credit and Creator
  Identity;
- lifecycle active:
  lifecycle owns Credit while state is CONSUMING;
- publication attempted:
  lifecycle reports Irys publication attempt;
- publication verified:
  server or canonical lifecycle evidence confirms successful publication;
- Seal attempted:
  lifecycle reports Seal attempt;
- Seal succeeded:
  server or canonical lifecycle evidence confirms successful Seal;
- lifecycle failed:
  server transitions lifecycle to FAILED / ABORTED;
- lifecycle aborted:
  server restores Credit to AVAILABLE.

Final consumption condition:

- The Credit layer MUST receive authoritative evidence of successful
  publication AND successful Seal before transitioning Credit to CONSUMED.
- The Credit layer MUST NOT consume Credit based on frontend UI status,
  localStorage, sessionStorage, or client-supplied flags.

## 16. CLOUDFLARE RESPONSIBILITY BOUNDARY

Architectural responsibilities:

- Credit reservation:
  server atomically reserves AVAILABLE -> CONSUMING;
- lifecycle ownership:
  server records and validates lifecycle ownership of Credit;
- state serialization:
  server serializes Credit and lifecycle state transitions;
- identity binding:
  server binds reservation and lifecycle to immutable Creator Identity;
- failure/recovery:
  server determines when CONSUMING -> AVAILABLE is allowed;
- final consumption:
  server transitions Credit to CONSUMED only after authoritative
  publication + Seal evidence;
- idempotency:
  server tracks reservation, lifecycle, and consumption state to make
  retries safe;
- concurrency:
  server prevents concurrent reservations and duplicate consumption.

Rules:

- All Credit and lifecycle decisions MUST be authoritative server-side.
- Frontend MAY display state.
- Frontend MUST NOT create, modify, or prove Credit or lifecycle state.
- Endpoints MUST be browser-compatible.
- Endpoints MUST NOT depend on Node-only runtime assumptions.
- Implementation MAY be hosted on Cloudflare Pages/Workers.

## 17. OBSERVABILITY / AUDIT

Mandatory security facts:

The server MUST maintain authoritative state sufficient to reconstruct:

- Credit reservation;
- lifecycle ownership;
- publication outcome;
- Seal outcome;
- final Credit consumption;
- duplicate/replay rejection;
- failure and recovery transitions.

Non-blocking recommendations:

- rate limiting on reservation and lifecycle endpoints;
- audit logging for reservation, lifecycle start, failure, recovery, and
  consumption events;
- anomaly detection for unusual reservation patterns.

## 18. UNRESOLVED IMPLEMENTATION DECISIONS

Genuinely unresolved and implementation-selection PENDING:

- exact Credit reservation storage mechanism;
- exact concurrency primitive for AVAILABLE -> CONSUMING;
- exact lifecycle identifier format;
- exact recovery mechanism for stale CONSUMING;
- exact heartbeat/reconciliation mechanism if used;
- exact Cloudflare Pages/Workers route names;
- exact Cloudflare data-store implementation;
- exact authoritative publication/Seal evidence format and verification
  flow;
- exact Irys publication verification interface;
- exact Seal verification interface;
- exact timeout or reconciliation policy for interrupted lifecycles.

Architecture/security invariants that MUST already be explicit:

- server-side authority for all Credit and lifecycle state transitions;
- atomic reservation AVAILABLE -> CONSUMING;
- one Credit per active lifecycle;
- frontend non-authority;
- immutable Creator Identity during lifecycle;
- fail-closed behavior for ambiguous states;
- final consumption only after successful publication + Seal;
- cross-layer authority boundaries.

## 19. CANONICAL CONSISTENCY

Verified against:

- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md

No contradictions found.

If a contradiction is discovered in future, it MUST be reported rather
than silently changing other canonical documents.

## 20. REFERENCES

- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- Irys official documentation:
  - https://docs.irys.xyz/build/d/features/supported-tokens
  - https://docs.irys.xyz/build/d/irys-in-the-browser
  - https://docs.irys.xyz/build/d/quickstart
  - https://docs.irys.xyz/build/d/sdk/setup
  - https://docs.irys.xyz/build/d/networks
