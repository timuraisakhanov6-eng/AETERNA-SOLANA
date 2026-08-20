# AETERNA — SPEC-WP-18 Service Payment Network/Asset Selection Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review evaluates whether Base Mainnet + USDC can be canonically
selected as the AETERNA service payment network and asset without
contradicting current canonical documents.

This review does NOT create a wallet.
This review does NOT generate an address.
This review does NOT connect a payment provider.
This review does NOT modify production code.
This review does NOT create Cloudflare resources.

---

## 2. PROPOSED SELECTION

Proposed for canonicalization:
- Network: Base Mainnet
- Asset: native USDC on Base
- Commercial service fee: USD 1.00
- Settlement Wallet custody: 2-of-3 multisig + hardware-backed keys
- Application runtime: NO private-key access, NO signing authority

---

## 3. CANONICAL COMPATIBILITY CHECK

### 3.1 Provider-Neutral Architecture
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md requires a provider-neutral
  multi-provider architecture.
- Selecting one network/asset is compatible IF the architecture remains
  provider-neutral and extensible to additional assets/networks later.
- Compatibility: CONDITIONAL — provided future expansion remains possible.

### 3.2 Creator Identity Binding
- Creator Identity is server-authoritative and network-agnostic.
- Base Mainnet + USDC does not conflict with Creator Identity binding.
- Compatibility: PASS.

### 3.3 Immutable Service Quote
- Immutable quote locks selectedNetwork, selectedPaymentAsset, exactAtomicAmount, recipient.
- Base Mainnet + USDC can be locked in immutable quotes.
- Compatibility: PASS.

### 3.4 Creator Credit
- Creator Credit is bound to Creator Identity, not network/asset.
- Base Mainnet + USDC does not conflict with Creator Credit rules.
- Compatibility: PASS.

### 3.5 AETERNA/Irys Payment Separation
- AETERNA service payment and Irys publication/storage are separate layers.
- Base/USDC selection here does not dictate Irys payment asset/network.
- Compatibility: PASS.

### 3.6 Multi-Network Identity Architecture
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md supports multi-network
  account binding to one Creator Identity.
- Selecting Base Mainnet as the AETERNA service payment network is
  compatible with multi-network identity architecture.
- Compatibility: PASS.

### 3.7 Settlement Wallet Model
- Settlement Wallet custody: 2-of-3 multisig + hardware-backed keys.
- This model is network-agnostic and compatible with Base Mainnet.
- Compatibility: PASS.

---

## 4. CONTRADICTIONS FOUND

### 4.1 "AETERNA must not become USDC-only"

AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md explicitly states:
- "AETERNA must not become Solana-only."
- "AETERNA must not become USDC-only."

Selecting ONLY USDC on Base Mainnet as the sole production asset directly
contradicts "must not become USDC-only."

This is a direct canonical contradiction.

### 4.2 Recommended Initial Assets

AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md and
AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md recommend:
- ETH on Ethereum Mainnet
- USDC on Ethereum Mainnet

The proposed selection is:
- USDC on Base Mainnet only

This contradicts the recommended network (Ethereum Mainnet vs Base Mainnet)
and contradicts the recommended limited set of assets (ETH + USDC vs USDC only).

### 4.3 Explicit Exclusion of Base/USDC-Only Assumptions

AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md explicitly excludes:
- "old Base/USDC-only assumptions unless explicitly reselected by current
  canonical documents after this specification is published."

Selecting Base/USDC-only without explicit canonical reselection
contradicts this exclusion.

---

## 5. USDC AMOUNT MODEL

If Base/USDC were canonicalized, the canonical commercial rule would be:

serviceFeeUsd = 1.00

The quote MUST lock:
- selectedNetwork = Base Mainnet
- selectedPaymentAsset = USDC
- exactAtomicAmount = server-calculated amount
- recipient = future canonical Settlement Wallet address

Do NOT invent the wallet address.
Do NOT invent an oracle.

Exact USD→USDC conversion/rate source:
PENDING CANONICAL DECISION
- exact price source/oracle for USD 1.00 conversion.

---

## 6. USER PAYMENT MODEL

If Base/USDC were canonicalized, the creator would pay:
- $1.00 USD-equivalent in USDC on Base Mainnet.

The frontend may display the amount.
The frontend MUST NOT determine the canonical atomic amount.

---

## 7. SETTLEMENT WALLET

Preserved:
- 2-of-3 multisig;
- hardware-backed keys;
- no application-runtime private-key access.

The wallet itself remains uncreated.
Its future Base Mainnet address becomes part of immutable Quotes only
after wallet creation and canonical declaration.

---

## 8. IRYS SEPARATION

Base/USDC selection here does NOT dictate Irys payment asset/network.
AETERNA Service Payment and Irys Publication/Storage Payment remain
separate layers.

---

## 9. VERDICT

SPEC-WP-18 = NOT READY

Reason:
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md explicitly states "AETERNA
  must not become USDC-only"; selecting only USDC contradicts this.
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md and
  AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md recommend ETH + USDC on
  Ethereum Mainnet, not USDC-only on Base Mainnet.
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md explicitly excludes
  "old Base/USDC-only assumptions."
- These contradictions cannot be silently rewritten.

Provider selection remains blocked by:
- exact payment network for initial production — CONTRADICTED / PENDING
- exact payment asset allowlist for initial production — CONTRADICTED / PENDING
- exact Settlement Wallet address — PENDING
- exact price source/oracle — PENDING
- exact payment provider/RPC — PENDING
- exact confirmation/finality thresholds — PENDING
- exact payment evidence formats — PENDING
- exact reconciliation/refund policy — PENDING
- legal review — PENDING

---

## 10. FILES CREATED

- docs/canonical/AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md

---

## 11. FILES REVIEWED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- docs/canonical/AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- docs/canonical/AETERNA_CREATOR_CREDIT_SPEC.md
- docs/canonical/AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- docs/reviews/implementation/AETERNA_SPEC_WP_17_SETTLEMENT_WALLET_CUSTODY_CANONICALIZATION_REVIEW.md

---

FINAL CONFIRMATION:

"No wallet was created. No wallet address was generated, invented, or
reused. No payment provider was connected. No production code, Cloudflare
resources, crypto, storage, Vault, Manifest, Seal, Trusted Time, Heartbeat,
or legacy files were modified."
