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
- authoritative Irys Node/API;
OR
- an explicitly trusted verification provider.

Gateway propagation/availability:
- MAY be used as an additional availability signal;
- is NOT standalone finality authority.

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

### 2.5 Finality Rule

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

Provider-specific:
- exact confirmation count/finality threshold per network/provider;
- exact availability check mechanism.

### 2.6 Provider Selection

Primary authoritative source:
- Irys Node/API.

Secondary signal:
- Gateway propagation/availability may be used as an additional availability signal.
- Gateway is NOT standalone finality authority.

Client-supplied publicationId / txHash / providerRef:
- evidence references only;
- MUST NOT be treated as authority.

The active production Irys rail uses uploader.irys.xyz. This is the current deployed endpoint for the active Creator-paid Irys flow.

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

### 3.5 Seal commit and authoritative Seal verification

Seal commit is the irreversible manifest boundary.
Seal commit alone is NOT automatically authoritative Seal verification.

Separate seal/verify remains required to establish authoritative Seal evidence.

### 3.6 Publication / Seal / Finalize order

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

Released implementation (verified against the released source): the authoritative verification records are stored in the KV namespaces `PUBLICATION_VERIFICATIONS` and `SEAL_VERIFICATIONS`, and Credit state decisions (reserve / finalize / recover) are serialized by the `CreditOperationCoordinator` Durable Object bound as `CREDIT_OP_COORDINATOR` (functions/do/creditOperationCoordinator.ts, wrangler.toml).

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

Released implementation — signed owner proof (D3, functions/api/creator/recover-lifecycle.ts):

Knowing the identifiers above, being on an allowed Origin, and passing the rate limit are NOT authority. The recovery request MUST additionally carry a signed owner proof produced with the EXISTING identity scheme (the same SIWS / EIP-191 challenge + wallet signature scheme the payment flow uses — no new password, secret, or ownership model):

- challengeId — a challenge previously issued via /api/creator/issue-challenge;
- network — "solana" or an EVM network;
- account — the creator's wallet account (base58-decoded 32-byte public key for Solana, or a 0x-prefixed 20-byte address for EVM);
- signature — the wallet signature over the challenge message.

The endpoint verifies the signature (Solana: Ed25519 verification with the verification key bound to the claimed account; EVM: recovered address must equal the claimed account), resolves the server-side creator identity for that account, and requires it to equal BOTH the claimed creatorIdentityId AND the owner recorded on the lifecycle index. A request with missing or incomplete proof fields is rejected with 403 OWNER_PROOF_REQUIRED. Only then is the Durable Object asked to decide; the CreditOperationCoordinator remains the sole authority for the Credit state itself.

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

## 6A. RECIPIENT `recovering` PRESENTATION STATE (UI, PRESENTATION-ONLY)

Two unrelated concepts share similar names and MUST NOT be confused:

- Creator credit/lifecycle recovery — the server authority flow of §6 (functions/api/creator/recover-lifecycle.ts, CreditOperationCoordinator). It restores or resumes a Creator Credit lifecycle.
- Recipient `recovering` presentation state — a client UI state of the capsule view (src/pages/capsule/CapsuleController.tsx, CapsuleView.tsx). It is presentation-only and grants no authority. This section documents the UI state.

Entry conditions (all MUST hold; verified against the released source):

- the open attempt failed with a failure classified "retryable" by classifyOpenFailure() (src/lib/capsule/openFailure.ts) — the OPEN decision was never made because Trusted Time or the vault bytes could not be obtained, and nothing was decrypted. Unclassifiable failures default to "retryable"; this default preserves the capability, it does NOT weaken authorization, because every retry re-runs the full pipeline;
- Trusted Time has authoritatively established for this attempt that opening is due (nowUtc >= effectiveOpenAt) — the internal openDue flag;
- a recipient capability secret is present in this tab;
- no creator-authority capability is present.

If any condition fails, the normal SEALED presentation is kept.

Presentation: an amber pulsing lock icon with the role="status" text "Capsule could not be loaded. Retrying…" (CapsuleView.tsx). No vault content is rendered.

Fail-closed guarantees:

- the state is presentation-only; it never authorizes decryption or content display;
- every retry re-runs the complete pipeline: Trusted Time → manifest validation → integrity verification (size and vaultSha256) → decryption; content remains hidden until all steps succeed;
- terminal failures (invalid capability, AES-GCM authentication failure, integrity or size violation) are classified "terminal", are never retried, and never reach the `recovering` state;
- the recipient capability secret is restored to the in-tab reference so the existing bounded retry mechanism (5 s interval / focus / visibility) can re-attempt opening without a page reload; a stale or unmounted runtime never receives the capability.

A genuinely future-sealed capsule never enters this state: when Trusted Time authoritatively confirms nowUtc < effectiveOpenAt, the normal SEALED presentation is shown (this is the only path that may display SEALED before an open attempt).

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

IMPLEMENTATION STATUS (released source): the missing items are now implemented OUTSIDE seal.ts in the dedicated endpoint functions/api/seal/verify.ts, which establishes the authoritative Seal verification record in the SEAL_VERIFICATIONS KV namespace, requires prior publication verification (PUBLICATION_VERIFICATIONS), and is bound to lifecycle/capsule/Creator Identity. Finalization remains a separate authority (functions/api/creator/finalize-credit.ts).

Future contract:
- Seal endpoint remains the irreversible event boundary;
- after manifest commit, Seal endpoint records authoritative Seal verification result;
- finalization remains a separate authority after Seal verification is established.

### 8.2 functions/api/upload.ts

NOTE (released source): no functions/api/upload.ts exists in the released source. The upload surface is functions/api/upload-token.ts (upload authorization) together with functions/api/capsule/prepared.ts and functions/api/capsule/seal.ts (prepared-container ingestion and manifest commit).

Current responsibility:
- upload-token validation;
- ciphertext/chunk ingestion;
- storage pointer registry.

EXECUTOR HOT STATUS:
- the Executor Hot code path has been REMOVED from the runtime; it is historical/retired only;
- it is NOT part of the active business model;
- it is NOT a storage payer, treasury, or publication funder.

CANONICAL TARGET:
- Creator-paid Irys publication (Creator pays Irys directly; amount determined by Irys);
- server-side authoritative publication verification;
- AETERNA coordinates and verifies; AETERNA does not finance Irys;
- Executor Hot is not canonical publication authority.

Missing responsibility:
- no authoritative publication verification record;
- no binding of publication result to lifecycle/capsule/Creator Identity;
- no publication state transition to VERIFIED for downstream finalization.

IMPLEMENTATION STATUS (released source): the missing items are now implemented in functions/api/publication/verify.ts and functions/api/publication/claim.ts, which maintain the authoritative publication verification record in the PUBLICATION_VERIFICATIONS KV namespace, bind it to lifecycle/capsule/Creator Identity, and transition publication state to VERIFIED for downstream finalization.

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

IMPLEMENTATION STATUS (released source): finalization is implemented in functions/api/creator/finalize-credit.ts and recovery in functions/api/creator/recover-lifecycle.ts; both delegate the Credit state decision to the CreditOperationCoordinator Durable Object (functions/do/creditOperationCoordinator.ts, binding CREDIT_OP_COORDINATOR), which serializes reserve / finalize / recover operations per Credit. reserve-lifecycle.ts delegates its own reservation decision to the same coordinator (op "reserve"). The two verification interfaces live in functions/api/publication/verify.ts and functions/api/seal/verify.ts.

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

IMPLEMENTATION STATUS (released source): the verification stores are implemented as the KV namespaces PUBLICATION_VERIFICATIONS and SEAL_VERIFICATIONS, and the Credit state records (including finalization and recovery decisions) are held by the CreditOperationCoordinator Durable Object bound as CREDIT_OP_COORDINATOR. The remaining audit/history surface of the listed items is not separately implemented as named stores.

---

## 9. SECURITY ATTACK MODEL

A. Fake publication ID
PASS (released source) — blocked by requiring authoritative source verification, implemented in functions/api/publication/verify.ts against the authoritative Irys Node/API; gateway propagation is used only as an availability signal, never as standalone finality authority.

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

IMPLEMENTATION STATUS (released source): the first, second, and fourth items are now implemented (functions/api/publication/verify.ts with functions/api/publication/claim.ts; functions/api/seal/verify.ts; the PUBLICATION_VERIFICATIONS / SEAL_VERIFICATIONS KV namespaces and the CREDIT_OP_COORDINATOR Durable Object). The released recovery flow is evidence-based with no timers; no heartbeat/reconciliation mechanism is implemented, so the recovery timeout/policy item remains PENDING by design (see §6.3).

### 10.3 Contradictions

No contradictions found in current canonical documentation that require silent rewrite.
If a contradiction is discovered later, it MUST be reported explicitly.

---

## 11. IMPLEMENTATION PENDING DECISIONS

IMPLEMENTATION STATUS (released source): the following items are no longer pending — they are implemented in the released source:
- Irys publication verification provider/adapter — functions/api/publication/verify.ts (authoritative Irys Node/API);
- Seal verification adapter/implementation — functions/api/seal/verify.ts (SEAL_VERIFICATIONS);
- Cloudflare KV keys/schema for publication and Seal verification state — PUBLICATION_VERIFICATIONS and SEAL_VERIFICATIONS; Credit state records in the CREDIT_OP_COORDINATOR Durable Object;
- route names/endpoint surface — /api/publication/verify, /api/publication/claim, /api/seal/verify, /api/creator/finalize-credit, /api/creator/reserve-lifecycle, /api/creator/recover-lifecycle.

Still pending (no released implementation found):
- exact publication finality threshold details for the Irys rail;
- exact recovery timeout/policy, if any (recovery is evidence-based; no timers implemented);
- exact heartbeat/reconciliation mechanism, if any.

---

## 12. MINIMUM IMPLEMENTATION WORK REQUIRED

IMPLEMENTATION STATUS (released source): items 1–4 are implemented in the released source (functions/api/publication/verify.ts + claim.ts, functions/api/seal/verify.ts, functions/api/creator/finalize-credit.ts, functions/api/creator/recover-lifecycle.ts, CreditOperationCoordinator Durable Object); item 5 is satisfied without changes to crypto, storage, manifest, Vault, or Emergency Runtime semantics. The list below is retained as the original design record.

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
