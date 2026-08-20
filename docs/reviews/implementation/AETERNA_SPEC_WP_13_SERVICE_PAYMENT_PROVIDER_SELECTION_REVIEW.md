# AETERNA — SPEC-WP-13 Service Payment Provider Selection Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review evaluates whether current canonical documentation provides
sufficient requirements and decision criteria to select an AETERNA service
payment provider, network, asset, and verification adapter for production.

This review does NOT select a provider.
This review does NOT modify production code.
This review does NOT create wallets or Cloudflare resources.

---

## 2. CANONICAL SOURCES REVIEWED

- docs/canonical/AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_CREATOR_CREDIT_SPEC.md
- docs/canonical/AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- docs/canonical/AETERNA_COMPLETE_ENGINEERING_MODEL.md
- docs/canonical/AETERNA_COMPLETE_SYSTEM_LOGIC.md
- docs/canonical/AETERNA_COMPLETE_PROJECT_LOGIC.md
- docs/reviews/implementation/AETERNA_CODE_MIGRATION_5_CANONICAL_SERVICE_PAYMENT.md
- docs/reviews/implementation/AETERNA_CODE_MIGRATION_6_CREDIT_RESERVATION_WIRING.md

---

## 3. RECONCILIATION: CURRENT CANONICAL STATE

### 3.1 Selected Items
The following are explicitly selected or defined in canonical documents:

- service fee is fixed at USD 1.00 equivalent;
- payment layer is separate from Irys publication/storage payment layer;
- provider architecture is provider-neutral multi-provider architecture;
- recommended initial launch architecture: EVM injected wallet/provider
  path encapsulated in provider-neutral architecture;
- recommended initial assets: ETH on Ethereum Mainnet, USDC on Ethereum
  Mainnet;
- server-side authority is required for all payment decisions;
- immutable quote locks asset, network, amount, recipient, Creator Identity;
- payment-to-credit transition is atomic and server-side.

### 3.2 Unresolved / Pending Items
The following remain EXPRESSLY PENDING in canonical documents:

PENDING CANONICAL DECISION
- exact AETERNA payment network for initial production;
- exact AETERNA payment asset allowlist for initial production;
- exact payment provider/RPC/adapter for initial production;
- exact Settlement Wallet address;
- exact Settlement Wallet custody and key-management architecture;
- exact price source/oracle for USD 1.00 conversion;
- exact confirmation/finality thresholds per supported network;
- exact payment evidence formats per network/provider;
- exact Cloudflare Pages/Workers route and data-store architecture;
- exact reconciliation/refund policy;
- exact legal review outcome for selected jurisdictions.

### 3.3 Contradictions
No direct contradictions were found among the reviewed canonical documents.

Important distinction:
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md recommends an initial
  provider/assets for architectural planning purposes.
- This recommendation has NOT been promoted to canonical production
  authority because required infrastructure dependencies remain unresolved,
  specifically the Settlement Wallet.

No document was silently reconciled.

---

## 4. PAYMENT MODEL INVARIANTS

Current invariants are satisfied by canonical architecture:

- AETERNA Service Payment is separate from Irys publication/storage payment.
  PASS — explicitly defined in all reviewed documents.
- Service payment is exactly $1.00 USD-equivalent.
  PASS — fixed in AETERNA_CREATOR_CREDIT_SPEC.md and
  AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md.
- Creator Service Quote is immutable and single-use.
  PASS — defined in settlement/payment specs.
- Creator Identity is server-authoritative.
  PASS — defined in identity spec.
- payment sender/account must match Creator Identity binding.
  PASS — defined in endpoint and settlement specs.
- recipient must match immutable quote.
  PASS — defined in endpoint and settlement specs.
- asset/network must match immutable quote.
  PASS — defined in endpoint and settlement specs.
- amount must match immutable quote.
  PASS — defined in settlement and endpoint specs.
- provider session is never authority.
  PASS — defined in identity and payment specs.
- frontend payment state is never authority.
  PASS — defined in all payment specs.
- no payment verification -> no Credit.
  PASS — fail-closed behavior explicit.
- replayed/consumed payment cannot grant second Credit.
  PASS — idempotency and replay protection defined.
- fail-closed on uncertainty.
  PASS — mandatory in endpoint and settlement specs.

---

## 5. PROVIDER SELECTION CRITERIA

The canonical provider-selection criteria are defined in the new
AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md and include:

- trusted transaction lookup;
- sender verification;
- recipient verification;
- asset verification;
- exact amount verification;
- network verification;
- confirmation/finality verification;
- replay detection;
- stable transaction/evidence identifier;
- server-side verification;
- acceptable availability/latency;
- Cloudflare Workers compatibility;
- auditable failure modes;
- Settlement Wallet operational readiness;
- Irys compatibility;
- AETERNA allowlist approval;
- legal review completion.

No candidate can be declared production-ready without satisfying all
REQUIRED gates.

---

## 6. SETTLEMENT WALLET DEPENDENCY

Current state:
- The AETERNA Settlement Wallet does NOT yet exist.
- Canonical documents define the Settlement Wallet role and restrictions,
  but do NOT define custody solution, key-management architecture, or actual
  address.

Required before provider verification can become production-ready:
- wallet custody selection model is decided;
- wallet creation is completed;
- wallet address is published;
- quote recipient binding is configured with actual address.

These steps are sequential and blocking:
- no wallet creation -> no address -> no quote recipient binding ->
  no production payment verification.

---

## 7. LEGACY ISOLATION CONFIRMATION

The following are NOT valid sources for provider selection:

- Paddle;
- old Executor Hot payment role;
- old web3 payment verifier;
- old block pricing;
- old Base/USDC assumptions unless explicitly reselected by current
  canonical documents.

Confirmed by implementation review:
- Active runtime dependencies on legacy payment paths have been removed.
- /api/service-payment/verify is implemented as provider-neutral fail-closed
  adapter.
- No legacy payment provider is wired into active canonical creator path.

---

## 8. IMPLEMENTATION STATE

Current `/api/service-payment/verify` implementation:
- provider-neutral fail-closed adapter;
- resolves immutable quote server-side;
- requires verified payment state bound to quote and Creator Identity;
- idempotent;
- returns PAYMENT_VERIFICATION_FAILED when provider/finality are pending.

This implementation is consistent with canonical requirements and does NOT
select a production provider.

---

## 9. VERDICT

SPEC-WP-13 = NOT READY FOR PROVIDER SELECTION

Reason:
- exact payment network/asset/provider/finality are PENDING;
- Settlement Wallet does not exist;
- price source/oracle is PENDING;
- payment evidence formats per network are PENDING;
- Cloudflare route/data-store architecture for payment state is PENDING;
- legal review is PENDING.

The requirements and decision criteria are now explicitly defined in
AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md.

Provider selection MAY proceed only after all PENDING decisions are resolved
and documented in canonical specifications.

---

## 10. FILES CREATED

- docs/canonical/AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md

---

## 11. FILES REVIEWED

- docs/canonical/AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_CREATOR_CREDIT_SPEC.md
- docs/canonical/AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- docs/canonical/AETERNA_COMPLETE_ENGINEERING_MODEL.md
- docs/canonical/AETERNA_COMPLETE_SYSTEM_LOGIC.md
- docs/canonical/AETERNA_COMPLETE_PROJECT_LOGIC.md
- docs/reviews/implementation/AETERNA_CODE_MIGRATION_5_CANONICAL_SERVICE_PAYMENT.md
- docs/reviews/implementation/AETERNA_CODE_MIGRATION_6_CREDIT_RESERVATION_WIRING.md

---

FINAL CONFIRMATION:

"No production code, wallets, Cloudflare resources, payment integrations,
crypto, storage, Vault, Manifest, Seal, Trusted Time, Heartbeat, or legacy
files were modified."
