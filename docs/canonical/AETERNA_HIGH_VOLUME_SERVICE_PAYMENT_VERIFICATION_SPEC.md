# AETERNA — High-Volume Service Payment Verification Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_MULTISIG_MECHANISM_SPEC.md
- AETERNA_SETTLEMENT_WALLET_SIGNER_OPERATIONS_POLICY.md
- AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md

---

## 1. ARCHITECTURE OVERVIEW

The AETERNA Service Payment verification layer is designed for high-volume,
viral payment traffic from day one.

Canonical payment context:
- Base Mainnet
- native USDC
- USD 1.00 service fee
- MVP Settlement Wallet: 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755
- future migration to Safe 2-of-3 multisig
- authority chain: Creator Identity -> immutable Quote -> verified payment -> Credit

Architectural principles:
- server-side authority is non-negotiable;
- event ingestion is separate from verification authority;
- payment index is authoritative;
- all failures are fail-closed;
- frontend state is never authority;
- provider-neutral abstraction is preserved.

This document defines architecture only.
It does NOT select providers, create accounts, or modify production code.

---

## 2. EVENT-DRIVEN PAYMENT INGESTION

### 2.1 Conceptual Architecture

Base Mainnet native USDC Transfer events
-> ingestion pipeline
-> normalized payment record
-> quote/payment reconciliation
-> authoritative verification

Separate layers:

INGESTION LAYER:
- listens for USDC Transfer events on Base Mainnet;
- filters by recipient = MVP Settlement Wallet;
- normalizes event data;
- writes indexed payment records;
- detects duplicates/replays.

VERIFICATION AUTHORITY LAYER:
- owns payment verification state machine;
- independently verifies payment facts from trusted network source;
- binds verified payments to quotes and Creator Identities;
- grants Credit atomically.

Event receipt alone MUST NOT equal VERIFIED PAYMENT.

### 2.2 Ingestion Requirements

The ingestion layer MUST:
- process USDC Transfer events for the canonical recipient;
- handle burst traffic and duplicate events;
- deduplicate by (chainId, transactionHash, logIndex);
- store firstSeenAt for each event;
- surface events to the verification authority layer.

The ingestion layer MUST NOT:
- grant Credit;
- modify quote state;
- treat receipt of an event as verified payment;
- bypass server-side verification.

### 2.3 Normalized Payment Record

Each ingested event becomes a normalized payment record containing:
- chainId;
- transactionHash;
- blockHash;
- blockNumber;
- logIndex;
- sender;
- recipient;
- tokenContractIdentity;
- exactAtomicAmount;
- confirmation/finality state;
- firstSeenAt;
- verifiedAt;
- quote binding;
- Creator Identity binding;
- consumed/replayed state.

---

## 3. PAYMENT INDEX

### 3.1 Index Structure

The authoritative payment index is a server-side indexed representation
of all payment events and their verification state.

Required fields per indexed record:
- chainId;
- transactionHash;
- blockHash;
- blockNumber;
- logIndex;
- sender;
- recipient;
- tokenContractIdentity;
- exactAtomicAmount;
- confirmation/finality state;
- firstSeenAt;
- verifiedAt;
- quoteId;
- creatorIdentityId;
- consumed/replayed state.

### 3.2 Uniqueness Constraints

Primary uniqueness constraint:
- (chainId, transactionHash, logIndex) uniquely identifies a token
  transfer event.

Secondary constraints:
- (recipient, transactionHash, exactAtomicAmount) used for lookup;
- (quoteId, transactionHash) used for binding verification;
- (creatorIdentityId, transactionHash) used for identity collision detection;
- paymentEvidenceId used for replay detection.

### 3.3 Index Operations

The payment index MUST support:
- insert new event;
- lookup by (chainId, transactionHash, logIndex);
- lookup by recipient + time range;
- lookup by quoteId;
- lookup by creatorIdentityId;
- mark as verified;
- mark as rejected;
- mark as consumed/replayed;
- idempotent insert/replay detection.

### 3.4 Storage Requirements

The index MUST be:
- authoritative server-side;
- durable across restarts;
- queryable for verification and audit;
- compatible with Cloudflare runtime constraints.

Exact storage technology is PENDING implementation decision.

---

## 4. VERIFICATION PIPELINE

### 4.1 Pipeline Stages

Payment evidence
-> indexed lookup
-> trusted network lookup
-> sender check
-> recipient check
-> network check
-> native USDC check
-> exact amount check
-> confirmation/finality check
-> replay check
-> Quote association
-> Creator Identity association
-> VERIFIED

No frontend signal may bypass any stage.

### 4.2 Stage Definitions

1. Indexed lookup:
   - server looks up payment event in authoritative payment index;
   - if not found, fetch from trusted network source and insert.

2. Trusted network lookup:
   - server independently establishes payment facts from trusted network
     source;
   - client-supplied evidence is reference only, not authority.

3. Sender check:
   - verified payment sender matches server-verified account binding for
     Creator Identity associated with the quote.

4. Recipient check:
   - verified payment recipient matches canonical Settlement Wallet
     recipient recorded in immutable quote.

5. Network check:
   - verified payment network matches selectedNetwork recorded in immutable
     quote.

6. Native USDC check:
   - verified payment asset matches selectedPaymentAsset recorded in
     immutable quote.

7. Exact amount check:
   - verified payment amount matches exactAtomicAmount recorded in immutable
     quote.

8. Confirmation/finality check:
   - payment has reached required confirmation/finality for Base Mainnet;
   - exact threshold is PENDING network policy.

9. Replay check:
   - payment evidence has not been previously verified;
   - payment evidence has not previously granted a Creator Credit.

10. Quote association:
    - payment is associated with exactly one immutable quote;
    - quote is still active and bound to authenticated Creator Identity.

11. Creator Identity association:
    - verified payment is bound to exactly one Creator Identity.

12. VERIFIED:
    - all checks pass;
    - state transitions to VERIFIED atomically.

### 4.3 Fail-Closed Rules

If any stage fails or cannot be completed:
-> payment is NOT verified
-> Credit is NOT granted
-> state is retained for retry/audit

---

## 5. RPC ARCHITECTURE

### 5.1 Provider Tiers

Production RPC architecture MUST NOT rely on public Base RPC as sole
authority for high-volume traffic.

Provider tiers:
- PRIMARY: dedicated primary Base RPC provider;
- SECONDARY: dedicated secondary Base RPC provider;
- OPTIONAL TERTIARY: optional tertiary fallback provider.

Public Base RPC:
- MAY be used as tertiary fallback only;
- MUST NOT be the production authority for high-volume verification.

### 5.2 Provider Requirements

Any Base Mainnet RPC provider MUST satisfy:
- Base Mainnet support;
- high throughput;
- WebSocket/event support for ingestion;
- historical transaction/log lookup;
- log filtering;
- reliability/availability;
- documented rate limits;
- failover support;
- auditability;
- Cloudflare Workers compatibility.

### 5.3 Operational Parameters

Required operational parameters:
- timeout: per-request timeout MUST be defined server-side;
- retry: retry count MUST be limited;
- backoff: exponential backoff with jitter;
- rate-limit handling: detect rate-limit responses and back off;
- failover: automatic failover from primary to secondary;
- provider disagreement: detect conflicting responses and fail-closed.

Provider disagreement handling:
- if primary and secondary providers disagree on payment facts:
  - do NOT guess;
  - fail-closed: payment NOT verified;
  - alert operators;
  - retain state for manual/additional verification.

### 5.4 Verification Authority

The verification authority remains:
- AETERNA server logic + blockchain facts from trusted network source.

Provider selection does NOT change verification authority.

---

## 6. PRIMARY / SECONDARY PROVIDERS

### 6.1 Provider Selection Requirements

Before any provider is selected for production use, it MUST satisfy:

- Base Mainnet support;
- high throughput;
- WebSocket/event support;
- historical transaction lookup;
- log filtering;
- reliability;
- documented rate limits;
- failover support;
- auditability;
- Cloudflare Workers compatibility.

### 6.2 Provider Neutrality

The verification adapter MUST remain provider-neutral:
- new providers MAY be added as adapters;
- no provider MAY be hardcoded into canonical payment verification logic;
- provider selection is a separate canonical decision.

### 6.3 Current Status

- Primary provider: PENDING selection
- Secondary provider: PENDING selection
- Tertiary fallback: PENDING selection

No provider is selected in this document.

---

## 7. SCALE / QUEUEING

### 7.1 Synchronous vs Asynchronous

Synchronous:
- user-initiated verification request;
- server responds with current verification state;
- timeout/retry handled client-side.

Asynchronous:
- blockchain event ingestion;
- payment record normalization;
- quote/payment reconciliation;
- delayed confirmation/finality tracking;
- retry queue for failed verifications.

### 7.2 Queue Architecture

Conceptual queues:
- ingestion queue: incoming blockchain events;
- verification queue: payments pending verification;
- retry queue: failed verifications pending retry;
- reconciliation queue: payments pending final reconciliation.

Queue requirements:
- durable across restarts;
- ordered by event time;
- supports priority for user-facing verification;
- supports dead-letter handling for permanent failures;
- supports replay recovery.

### 7.3 User Flow

User flow states:

PENDING:
- payment evidence submitted;
- server has registered evidence;
- verification in progress or awaiting confirmations.

VERIFIED:
- all verification checks passed;
- Credit may be granted atomically.

FAILED:
- verification failed;
- no Credit granted;
- state retained for audit.

User flow MUST NOT grant Credit in PENDING state.
Credit is granted ONLY after VERIFIED state.

---

## 8. IDEMPOTENCY / REPLAY

### 8.1 Duplicate Event Handling

| Scenario | Behavior |
|---|---|
| duplicate txHash + same logIndex | recognized as duplicate; no duplicate record |
| same payment submitted twice | second submission returns existing state |
| same quote submitted twice | second submission returns existing state |
| same payment across two Creator Identities | at most one Credit granted; second identity rejected |
| delayed duplicate event | recognized by (chainId, txHash, logIndex); no duplicate |
| provider retry | idempotent; returns existing result |

### 8.2 Replay Rules

- ONE eligible payment -> MAXIMUM ONE Credit.
- Replay of verified payment evidence MUST NOT grant additional Credit.
- Replay of consumed payment evidence MUST return existing result.
- Duplicate payment evidence against multiple quotes or identities MUST be
  detected and MUST grant at most one Credit.

### 8.3 Idempotency Keys

Server-generated idempotency keys:
- quoteId for quote operations;
- paymentEvidenceId for payment operations;
- challengeId for identity operations.

Client-submitted identifiers are NOT idempotency keys.

---

## 9. REORG / FINALITY

### 9.1 State Machine

Conceptual Base Mainnet payment state machine:

OBSERVED:
- payment event detected in block;

CONFIRMING:
- payment included in block with confirmations;

FINAL:
- payment has reached required confirmation/finality threshold;

REORGED:
- payment was in a reorged block;
- payment MUST be re-evaluated;

INVALIDATED:
- payment is no longer valid due to reorg;
- verification MUST be reverted;
- Credit MUST NOT be granted.

### 9.2 Reorg Handling

Rules:
- server tracks blockHash and blockNumber for each payment event;
- if a reorg is detected:
  - payments in reorged blocks move to REORGED state;
  - verification for REORGED payments is re-evaluated;
  - if payment is no longer valid, state -> INVALIDATED;
  - no Credit is granted for INVALIDATED payments;
- if payment reappears in new block:
  - state -> OBSERVED -> CONFIRMING -> FINAL;
  - verification proceeds normally.

### 9.3 Finality Threshold

Required confirmation/finality threshold for Base Mainnet:
- PENDING NETWORK POLICY.

The server MUST enforce the configured threshold before granting Credit.
The exact threshold MUST be defined per network before production use.

### 9.4 Failure Behavior

| Scenario | Behavior |
|---|---|
| transaction initially observed | OBSERVED state |
| transaction included | CONFIRMING state |
| confirmation pending | wait for threshold |
| reorg detected | REORGED -> re-evaluate |
| final/accepted state | FINAL -> proceed to verification |

---

## 10. THROUGHPUT

### 10.1 Scaling Dimensions

The system MUST be designed for the following scaling dimensions:

- ingestion throughput: events/sec from Base USDC Transfer stream;
- verification throughput: verifications/sec for concurrent user requests;
- RPC request rate: independent lookups per verification;
- indexed event rate: new payment events indexed/sec;
- queue depth: maximum pending events/verifications;
- concurrent verification count: parallel verifications allowed;
- storage write throughput: payment index writes/sec.

### 10.2 Throughput Requirements

The architecture MUST support:
- burst traffic without dropping events;
- repeated verification requests without duplicate processing;
- delayed confirmations without premature Credit grant;
- provider outage without data loss.

### 10.3 Backpressure

Backpressure requirements:
- if ingestion rate exceeds processing capacity:
  - queue events;
  - alert operators;
  - do NOT drop events;
- if verification queue exceeds capacity:
  - queue verifications;
  - return PENDING to user;
  - do NOT grant Credit prematurely.

### 10.4 No TPS Guarantee Without Evidence

This document does NOT claim a numeric TPS guarantee without evidence.
Numeric throughput targets require load testing and provider evaluation,
which are PENDING.

---

## 11. MONITORING

### 11.1 Required Metrics

The verification layer MUST expose or support the following metrics:

- payments detected/sec: number of USDC Transfer events ingested/sec;
- payments verified/sec: number of payments verified/sec;
- pending payments: current count of payments in PENDING state;
- failed verification: count of verifications that reached FAILED state;
- RPC errors: count of RPC provider errors by provider;
- provider latency: p50/p95/p99 latency per provider;
- provider disagreement: count of conflicting responses between providers;
- queue depth: current depth of ingestion/verification/retry queues;
- reconciliation backlog: count of payments pending reconciliation;
- duplicate/replay attempts: count of detected duplicate/replay attempts;
- Credit grant failures: count of failed Credit grants.

### 11.2 Alerting

Alerting requirements:
- provider error rate exceeds threshold;
- provider latency exceeds threshold;
- queue depth exceeds threshold;
- verification failure rate exceeds threshold;
- replay/detection rate exceeds threshold;
- Credit grant failure rate exceeds threshold.

Exact alert thresholds and channels are PENDING operational decision.

---

## 12. FAILURE MODES

### 12.1 Failure Mode Matrix

| Scenario | Safe Outcome |
|---|---|
| A. primary RPC down | failover to secondary; event retained in queue |
| B. secondary RPC down | failover to tertiary or public RPC; event retained |
| C. WebSocket disconnect | reconnect; resume ingestion from last event; backfill gap |
| D. delayed event | event inserted when received; verification proceeds normally |
| E. RPC disagreement | fail-closed; payment NOT verified; alert operators; retain state |
| F. blockchain reorg | REORGED state; re-evaluate; INVALIDATED if no longer valid |
| G. database/KV unavailable | queue events locally; retry storage; do NOT grant Credit |
| H. duplicate event | deduplicate by (chainId, txHash, logIndex); no duplicate record |
| I. lost client response | server retains state; client re-queries; idempotent result |
| J. traffic spike | backpressure; queue events; alert operators; do NOT drop |
| K. viral payment burst | scale ingestion; queue verifications; return PENDING; no premature Credit |

### 12.2 General Rule

Never convert uncertainty into VERIFIED.
All failures are fail-closed.

---

## 13. CLOUDFLARE COMPATIBILITY

### 13.1 Conceptual Placement

Conceptual placement of components:

| Component | Conceptual Placement | Status |
|---|---|---|
| Pages Functions | HTTP endpoints for quote creation, evidence submission, state reads | existing |
| Workers | verification orchestration, trusted network queries | existing |
| Durable Objects | serialization, concurrent verification/credit grant | existing |
| KV | payment evidence state, idempotency cache | PENDING exact implementation |
| Queues | async ingestion, retry, reconciliation | PENDING implementation |
| External RPC | trusted Base Mainnet blockchain queries | PENDING provider selection |

### 13.2 Compatibility Requirements

All components MUST:
- be browser-compatible;
- NOT depend on Node-only runtime assumptions;
- operate within Cloudflare runtime constraints;
- support provider-neutral architecture.

### 13.3 No Configuration Changes

This document does NOT modify wrangler.toml or Cloudflare configuration.
Exact Cloudflare implementation is PENDING.

---

## 14. SETTLEMENT WALLET SCALE

### 14.1 Wallet is Not Per-User Container

The Settlement Wallet does NOT become a per-user state container.

Mass incoming USDC transfers do NOT require a new wallet for each payment.

The Settlement Wallet is:
- a single canonical recipient address;
- a payment destination only;
- not an accounting container per user.

### 14.2 Scaling Concerns

Scaling concerns are:
- blockchain/RPC ingestion throughput;
- payment verification throughput;
- event indexing;
- quote/payment reconciliation;
- treasury balance management;
- withdrawal operations.

Future Safe migration remains independent of scaling architecture.

### 14.3 Treasury Boundary

Treasury sweep / Safe migration:
- remains a future operational requirement;
- does NOT require per-user wallet architecture;
- does NOT change payment verification architecture.

---

## 15. REMAINING PENDING DECISIONS

The following decisions remain PENDING and MUST be resolved before
production activation:

PENDING CANONICAL DECISION
- exact price source/oracle for USD 1.00 conversion;
- exact confirmation/finality thresholds per supported network;
- exact payment provider/RPC/adapter for initial production;
- exact primary/secondary/tertiary RPC providers;
- exact payment evidence formats per network/provider;
- exact Cloudflare Pages/Workers route and data-store architecture;
- exact queue/event-processing implementation;
- exact reconciliation/refund policy for misdirected or expired payments;
- exact legal review outcome for service entitlement in selected
  jurisdictions;
- exact Safe migration timing/procedure.

No implementation MAY finalize production payment verification until all
PENDING items are resolved and documented in canonical specifications.

---

## 16. SECURITY MODEL

Mandatory security invariants:
- server-side authority for all payment decisions;
- immutable quote locks asset, network, amount, recipient, and Creator
  Identity;
- single-use quote and payment evidence;
- server MUST independently establish payment facts from a trusted network
  source rather than accepting client-supplied evidence as authoritative;
- replay-resistant verification;
- frontend non-authority;
- Creator Credit bound to Creator Identity, not raw address;
- concurrent verification/credit grant serialized server-side;
- Settlement Wallet operational separation;
- wallet/account switching cannot transfer credit between identities;
- one Creator Credit is permitted at most one downstream consumption
  attempt;
- event ingestion is separate from verification authority;
- payment index is authoritative server-side;
- all failures are fail-closed.

---

## 17. DECISION SUMMARY

Exact architectural decisions made:
- event-driven ingestion separates event receipt from verification
  authority;
- payment index is authoritative server-side with uniqueness constraint
  (chainId, transactionHash, logIndex);
- verification pipeline has defined stages with fail-closed semantics;
- RPC architecture uses primary/secondary/optional tertiary providers;
- public Base RPC MUST NOT be production authority for high-volume traffic;
- provider selection remains PENDING;
- idempotency is enforced server-side via payment evidence tracking;
- reorg handling uses explicit state machine with PENDING network policy
  finality threshold;
- scaling dimensions are defined without numeric TPS guarantees;
- monitoring categories are defined;
- failure modes are defined with safe outcomes;
- Cloudflare conceptual placement is defined without configuration changes;
- Settlement Wallet is not a per-user container;
- mass payment scaling is verification/indexing/reconciliation problem.

Pending decisions:
- exact RPC providers;
- exact finality threshold;
- exact evidence formats;
- exact Cloudflare data-store/queue implementation;
- exact reconciliation policy;
- exact Safe migration timing.

---

## 18. REFERENCES

- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_MULTISIG_MECHANISM_SPEC.md
- AETERNA_SETTLEMENT_WALLET_SIGNER_OPERATIONS_POLICY.md
- AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
