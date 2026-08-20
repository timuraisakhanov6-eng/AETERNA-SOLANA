# AETERNA — SPEC-WP-14 Settlement Wallet and Payment Decision Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review evaluates whether current canonical documentation resolves the
Settlement Wallet custody, key management, address lifecycle, and payment
decision prerequisites required before AETERNA service payment provider
selection can proceed.

This review does NOT select a provider.
This review does NOT create a wallet.
This review does NOT invent an address.
This review does NOT modify production code.
This review does NOT create Cloudflare resources.

---

## 2. CANONICAL SOURCES REVIEWED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- docs/canonical/AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_CREATOR_CREDIT_SPEC.md
- docs/canonical/AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
- docs/canonical/AETERNA_COMPLETE_ENGINEERING_MODEL.md
- docs/canonical/AETERNA_COMPLETE_SYSTEM_LOGIC.md
- docs/canonical/AETERNA_COMPLETE_PROJECT_LOGIC.md
- docs/reviews/implementation/AETERNA_SPEC_WP_13_SERVICE_PAYMENT_PROVIDER_SELECTION_REVIEW.md
- docs/reviews/implementation/AETERNA_CODE_MIGRATION_6_CREDIT_RESERVATION_WIRING.md

---

## 3. SETTLEMENT WALLET — CANONICAL REQUIREMENTS

### 3.1 What the Settlement Wallet MUST provide

From canonical documents:

- ownership: AETERNA-owned, operated by AETERNA operational infrastructure;
- custody: private key custody separated from application logic;
- signing authority: restricted to authorized operational infrastructure;
  AETERNA server does NOT need wallet signing authority for creator service
  payments;
- operational control: access control limited to authorized operations;
  withdrawal authority follows separation of duties;
- compromise containment: architecture limits exposure if credentials are
  compromised; supports rotation/replacement without breaking existing
  quotes;
- withdrawal authority: explicit operational action, not automatic;
- monitoring: anomaly detection for receipt patterns, unauthorized
  withdrawals, misconfiguration;
- rotation/replacement: supported by architecture; exact procedure PENDING;
- address continuity: required for quote recipient binding integrity;
- auditability: operations auditable; history reconstructable;
- separation from application runtime: private keys NOT exposed to app
  runtime;
- separation from Irys publication funding: Settlement Wallet MUST NOT
  receive Irys payments.

### 3.2 Custody Models Contemplated

Canonical documents contemplate the following models without selecting one:
- externally managed wallet;
- multisig;
- institutional custody;
- hardware-backed key control;
- hot/cold separation.

### 3.3 Model Evaluation

| Model | Canonical Compatibility | Security | Operational Complexity | Recovery | Cloudflare Compatibility | Suitability for $1 recipient |
|---|---|---|---|---|---|---|
| externally managed wallet | compatible if separation preserved | depends on vendor | medium | vendor-dependent | compatible | possible |
| multisig | compatible | strong | high | complex | compatible | possible |
| institutional custody | compatible if separation preserved | strong | high | vendor-dependent | compatible | possible |
| hardware-backed key control | compatible | strong | high | complex | compatible | possible |
| hot/cold separation | recommended | strong | high | complex | compatible | possible |

No model is selected in canonical documents. Selection remains PENDING.

---

## 4. SETTLEMENT WALLET ADDRESS DEPENDENCY

Conceptual ordering defined in canonical documents:
1. wallet custody architecture selected
2. wallet created
3. wallet address verified
4. settlement wallet declared canonical
5. future quotes bind to that recipient

No step may be skipped.
No address may be invented before step 4 is complete.

Current state:
- step 1: PENDING
- step 2: not started
- step 3: not started
- step 4: not started
- step 5: blocked

---

## 5. SERVICE PAYMENT NETWORK / ASSET

### 5.1 Existing Canonical Recommendation

- architecture recommendation: provider-neutral multi-provider architecture
  with EVM injected wallet/provider path as initial concrete adapter;
- recommended initial assets: ETH on Ethereum Mainnet, USDC on Ethereum
  Mainnet.

### 5.2 Classification

A. Architecture recommendation:
- Provider-neutral multi-provider architecture is the canonical
  architectural recommendation.

B. Production selection:
- EVM injected wallet/provider path is recommended as initial adapter
  architecture.
- ETH on Ethereum Mainnet and USDC on Ethereum Mainnet are recommended
  initial assets for planning purposes.

C. Still pending:
- exact AETERNA payment network for initial production is NOT selected;
- exact AETERNA payment asset allowlist for initial production is NOT
  selected;
- exact payment provider/RPC/adapter for initial production is NOT selected.

Important distinction:
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md recommends an initial
  provider/assets for architectural planning purposes.
- This recommendation has NOT been promoted to canonical production
  authority because required infrastructure dependencies remain unresolved,
  specifically the Settlement Wallet.

No document was silently promoted from recommendation to production
authority.

---

## 6. PRICE SOURCE / USD 1.00

### 6.1 Fixed Commercial Denomination
- The AETERNA service fee is fixed at USD 1.00.
- This is a commercial denomination, not a network-native amount.

### 6.2 Actual Network Asset Amount
- The exact atomic amount in the selected payment asset MUST be derived
  server-side from the canonical USD 1.00.
- The conversion result MUST be recorded in the immutable quote.
- The frontend MAY display the converted amount; it does NOT determine the
  authoritative amount.

### 6.3 Oracle / Conversion Requirement
- The exact price source/oracle for USD 1.00 conversion is PENDING.
- The oracle MUST be:
  - trusted;
  - server-side;
  - time-bounded;
  - deterministic for a quote;
  - resistant to client manipulation.
- No oracle has been selected in canonical documents.

### 6.4 Quote Immutability
- exactAtomicAmount is a snapshot established at quote creation time.
- Later exchange-rate changes MUST NOT retroactively mutate already-issued
  quotes.

### 6.5 Rounding Rules
- Exact amount matching is REQUIRED against the immutable quote.
- Underpayment MUST NOT grant Creator Credit.
- Overpayment handling is a reconciliation decision outside Creator Credit
  semantics.
- Acceptable rounding rules are PENDING.

---

## 7. FINALITY

### 7.1 Requirement
- Each supported network MUST have an explicit confirmation/finality
  threshold configured server-side.
- The server MUST wait for the required confirmation/finality before
  granting Creator Credit.
- A blockchain reorganization or finality reversal that invalidates payment
  MUST revert verification and MUST NOT grant credit.

### 7.2 Current Status
- Exact confirmation/finality thresholds per supported network are PENDING.
- No threshold may be invented or assumed.

### 7.3 Information Needed
- confirmation/finality definition per network;
- reorg handling policy;
- transaction status lifecycle;
- provider disagreement resolution;
- delayed indexing handling.

All of the above remain PENDING.

---

## 8. PROVIDER SELECTION PREREQUISITES

Exact checklist:

| Item | Status |
|---|---|
| A. Settlement Wallet custody model | PENDING |
| B. Settlement Wallet address | PENDING |
| C. Network | RECOMMENDED, NOT production-selected |
| D. Asset | RECOMMENDED, NOT production-selected |
| E. Price conversion source | PENDING |
| F. Verification provider/RPC | PENDING |
| G. Finality thresholds | PENDING |
| H. Evidence format | PENDING |
| I. Replay policy | RESOLVED |
| J. Reconciliation/refund policy | PENDING |

Because items A, B, E, F, G, H, and J remain PENDING, and items C and D
remain recommendations rather than production selections, the prerequisites
for SPEC-WP-15 provider selection are NOT satisfied.

---

## 9. LEGACY ISOLATION

Explicitly, the following are NOT valid sources for provider selection,
custody decisions, or payment architecture:

- Paddle;
- old Executor Hot payment role;
- old web3 payment verifier;
- old block pricing;
- old payment receiver addresses;
- old Cloudflare resources.

Confirmed:
- Active runtime dependencies on legacy payment paths have been removed.
- /api/service-payment/verify is implemented as provider-neutral fail-closed
  adapter.
- No legacy payment provider is wired into active canonical creator path.

---

## 10. VERDICT

SPEC-WP-14 = NOT READY FOR PROVIDER SELECTION

Reason:
- Settlement Wallet custody model is PENDING;
- Settlement Wallet address does not exist;
- exact payment network/asset remain RECOMMENDED, NOT production-selected;
- price conversion source/oracle is PENDING;
- verification provider/RPC is PENDING;
- finality thresholds are PENDING;
- evidence formats are PENDING;
- reconciliation/refund policy is PENDING.

All requirements and decision criteria are now explicitly documented in
AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md.

Provider selection MAY proceed only after all PENDING decisions are resolved
and documented in canonical specifications.

---

## 11. FILES CREATED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md

---

## 12. FILES REVIEWED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- docs/canonical/AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_CREATOR_CREDIT_SPEC.md
- docs/canonical/AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
- docs/canonical/AETERNA_COMPLETE_ENGINEERING_MODEL.md
- docs/canonical/AETERNA_COMPLETE_SYSTEM_LOGIC.md
- docs/canonical/AETERNA_COMPLETE_PROJECT_LOGIC.md
- docs/reviews/implementation/AETERNA_SPEC_WP_13_SERVICE_PAYMENT_PROVIDER_SELECTION_REVIEW.md
- docs/reviews/implementation/AETERNA_CODE_MIGRATION_6_CREDIT_RESERVATION_WIRING.md

---

FINAL CONFIRMATION:

"No wallet was created. No wallet address was invented or reused. No
production code, Cloudflare resources, payment integrations, crypto,
storage, Vault, Manifest, Seal, Trusted Time, Heartbeat, or legacy files
were modified."
