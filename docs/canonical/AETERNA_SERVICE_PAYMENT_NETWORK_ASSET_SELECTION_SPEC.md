# AETERNA — Service Payment Network and Asset Selection Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md

---

## 1. SELECTED NETWORK

INITIAL PRODUCTION SELECTION
- Base Mainnet.

Canonical compatibility:
- This selection supersedes the earlier recommendation for Ethereum Mainnet
  as the initial production network.
- Provider-neutral/multi-network architecture is preserved; Ethereum Mainnet
  and other EVM networks remain approved future routes to be activated
  through explicit canonical selection.
- AETERNA is NOT permanently locked to Base Mainnet.

---

## 2. SELECTED ASSET

INITIAL PRODUCTION SELECTION
- native USDC on Base Mainnet.

Canonical compatibility:
- This selection supersedes earlier recommendations for ETH + USDC on
  Ethereum Mainnet as the initial production allowlist.
- Provider-neutral/multi-asset architecture is preserved; additional assets
  remain approved for future activation through explicit canonical selection.
- AETERNA is NOT permanently USDC-only.
- The earlier canonical rule "AETERNA must not become USDC-only" is
  preserved as a requirement that additional assets/networks remain possible;
  it does not prevent USDC from being the initial production asset.

---

## 3. COMMERCIAL PRICE

Fixed commercial denomination:
- serviceFeeUsd = 1.00

This is not a network-native amount.
This is a commercial denomination.

---

## 4. ATOMIC AMOUNT RULE

The quote MUST lock:
- selectedNetwork = Base Mainnet (if canonicalized)
- selectedPaymentAsset = USDC (if canonicalized)
- exactAtomicAmount = server-calculated amount
- recipient = future canonical Settlement Wallet address

The exact atomic amount MUST be derived server-side from canonical USD 1.00.
The conversion result MUST be recorded in the immutable quote.
The frontend MAY display the converted amount; it does NOT determine the
authoritative amount.

Exact USD→USDC conversion/rate source:
PENDING CANONICAL DECISION
- exact price source/oracle for USD 1.00 conversion.

---

## 5. QUOTE BINDING

The immutable quote binds:
- creatorIdentityId;
- serviceFeeUsd = 1.00;
- selectedPaymentAsset = USDC (pending canonicalization);
- selectedNetwork = Base Mainnet (pending canonicalization);
- exactAtomicAmount = server-calculated;
- recipient = future canonical Settlement Wallet address.

Quote is single-use and immutable for these fields.

---

## 6. SETTLEMENT WALLET DEPENDENCY

Settlement Wallet custody:
- SELECTED: 2-of-3 multisig with hardware-backed keys.

Settlement Wallet address:
- PENDING CANONICAL DECISION.

The future Base Mainnet address becomes part of immutable Quotes only after:
1. wallet custody model is selected — RESOLVED
2. wallet created
3. wallet address verified
4. settlement wallet declared canonical
5. future immutable quotes bind that recipient

Until step 4 is complete, NO immutable quote MAY contain a real
Settlement Wallet address.

---

## 7. CREATOR IDENTITY RELATIONSHIP

- Creator Identity is server-authoritative.
- Creator Identity is established by server-issued challenge/nonce +
  wallet signature + server verification.
- The immutable quote is bound to one Creator Identity.
- Payment verification MUST confirm that the independently verified payment
  sender/account is authorized for the Creator Identity associated with the
  immutable quote.
- Creator Identity is separate from Settlement Wallet.
- Creator Identity is separate from Creator Credit.

---

## 8. CREATOR CREDIT RELATIONSHIP

- ONE independently verified eligible payment -> MAXIMUM ONE Creator Credit.
- Creator Credit is bound to Creator Identity, not raw address.
- Payment-to-credit transition is atomic and server-side.
- Creator Credit state machine: AVAILABLE -> CONSUMING -> CONSUMED.
- Creator Credit is separate from Settlement Wallet.

---

## 9. IRYS SEPARATION

AETERNA Service Payment and Irys publication/storage are architecturally
and economically independent layers.

Base Mainnet + USDC selection here does NOT dictate:
- Irys payment asset;
- Irys payment network;
- Irys publication flow.

Irys payment asset/network are independently selected from Irys-supported
assets/networks.

---

## 10. REMAINING PENDING DECISIONS

The following decisions remain PENDING and MUST NOT be treated as selected:

PENDING CANONICAL DECISION
- exact Settlement Wallet address;
- exact price source/oracle for USD 1.00 conversion;
- exact payment provider/RPC/adapter for initial production;
- exact confirmation/finality thresholds per supported network;
- exact payment evidence formats per network/provider;
- exact Cloudflare Pages/Workers route and data-store architecture;
- exact reconciliation/refund policy for misdirected or expired payments;
- exact legal review outcome for service entitlement in selected
  jurisdictions.

---

## 11. LEGACY ISOLATION

The following are NOT valid sources for network/asset selection:

- Paddle;
- old Executor Hot payment role;
- old web3 payment verifier;
- old block pricing;
- historical Base/USDC-only assumptions that predate canonical
  reconciliation in SPEC-WP-18R; current canonical initial production
  selection is documented in this specification.

Any future selection MUST be based solely on current canonical documents
and explicitly documented decisions.

---

## 12. SECURITY MODEL

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
- Settlement Wallet private key MUST be isolated from application runtime;
|- Settlement Wallet compromise MUST NOT compromise Creator Credit
  authority or capsule contents;
|- AETERNA initial production service-payment route is Base Mainnet + native USDC;
|- AETERNA is NOT permanently USDC-only or Solana-only; additional assets/networks may be added through explicit future canonical selection.

---

## 13. DECISION SUMMARY

Exact architectural decisions made:
- AETERNA service payment and Irys publication are separate layers.
- Payment authority chain is: Creator Identity -> immutable quote -> server
  verification -> Creator Credit.
- USD 1.00 is fixed; exact atomic amount is determined server-side.
- Server verifies recipient, asset, network, amount, quote, identity,
  finality, replay, and duplicate credit before granting credit.
- Payment-to-credit transition is atomic and server-side.
- Creator Credit is bound to Creator Identity, not raw address.
- Wallet/account/network/provider switching aborts active lifecycle and
  cannot transfer credit.
- Provider architecture MUST remain provider-neutral.
- Settlement Wallet MUST exist before production payment verification.
- Settlement Wallet custody: 2-of-3 multisig with hardware-backed keys.
- Settlement Wallet private key MUST be isolated from application runtime.
- All failures are fail-closed; no uncertain payment may grant credit.

Pending decisions:
- exact Settlement Wallet address;
- exact price source/oracle;
- exact confirmation/finality thresholds;
- exact payment evidence formats per network;
- exact Cloudflare implementation details;
- exact reconciliation/refund policy;
- legal review completion.

---

## 14. REFERENCES

- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_COMPLETE_ENGINEERING_MODEL.md
- AETERNA_COMPLETE_SYSTEM_LOGIC.md
- AETERNA_COMPLETE_PROJECT_LOGIC.md
- AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
