# AETERNA — Service Payment Network and Asset Selection Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_MULTI_RAIL_SERVICE_PAYMENT_POLICY_SPEC.md
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

## 1. BUSINESS AUTHORITY

AETERNA Service Payment Business Authority:
- amount: exactly 1 USDC;
- entitlement: one verified payment = one capsule creation entitlement.

Business Authority is independent of payment rail.

Network selection determines payment-rail parameters only.
Network selection does NOT change the business amount or entitlement rule.

---

## 2. SUPPORTED PAYMENT RAILS

Canonical supported payment rails:
1. Base Mainnet / native USDC.
2. Solana Mainnet / native USDC.

Additional rails may be added only through explicit canonical selection.

---

## 3. INITIAL PRODUCTION RAIL SELECTION

INITIAL PRODUCTION SELECTION
- Base Mainnet + native USDC.

Canonical compatibility:
- This selection supersedes the earlier recommendation for Ethereum Mainnet as the initial production network.
- Provider-neutral/multi-rail architecture is preserved; additional supported rails remain approved for future activation through explicit canonical selection.
- AETERNA is NOT permanently locked to Base Mainnet.

---

## 4. SOLANA RAIL TARGET

Solana rail status:
- CANONICAL TARGET rail.

Solana rail parameters:
- network: Solana Mainnet;
- asset: official native USDC mint on Solana;
- transaction semantics: SPL Token transfer evidence;
- finality policy: PENDING IMPLEMENTATION POLICY;
- provider/RPC policy: PENDING IMPLEMENTATION REVIEW;
- settlement recipient policy: PENDING.

Solana rail does NOT imply:
- shared EVM provider policy;
- shared Base settlement recipient;
- shared finality threshold;
- shared evidence format.

Until Solana rail policy is explicitly documented and operational:
- no production quote MAY be issued for Solana;
- no verification MAY be finalized for Solana.

---

## 5. COMMERCIAL PRICE

Fixed commercial denomination:
- serviceFeeUsd = 1.00

This is not a network-native amount.
This is a commercial denomination.

---

## 6. ATOMIC AMOUNT RULE

The quote MUST lock:
- selectedPaymentAsset = native USDC;
- selectedNetwork = chosen supported rail;
- exactAtomicAmount = server-calculated amount;
- recipient = canonical Settlement Wallet address for selected rail.

The exact atomic amount MUST be derived server-side from canonical USD 1.00.
The conversion result MUST be recorded in the immutable quote.
The frontend MAY display the converted amount; it does NOT determine the authoritative amount.

Exact USD→USDC conversion/rate source:
PENDING CANONICAL DECISION
- exact price source/oracle for USD 1.00 conversion.

---

## 7. QUOTE BINDING

The immutable quote binds:
- creatorIdentityId;
- serviceFeeUsd = 1.00;
- selectedPaymentAsset = native USDC;
- selectedNetwork = chosen supported rail;
- exactAtomicAmount = server-calculated;
- recipient = canonical Settlement Wallet address for selected rail.

Quote is single-use and immutable for these fields.

---

## 8. SETTLEMENT WALLET DEPENDENCY

Settlement Wallet custody:
- SELECTED: 2-of-3 multisig with hardware-backed keys.

Settlement Wallet addresses:
- Base Mainnet: PENDING CANONICAL DECISION.
- Solana Mainnet: PENDING.

The canonical Settlement Wallet address for a rail becomes part of immutable Quotes only after:
1. wallet custody model is selected — RESOLVED
2. wallet created
3. wallet address verified
4. settlement wallet declared canonical for the rail
5. future immutable quotes bind that recipient for the rail

Until step 4 is complete for a rail, NO immutable quote MAY contain a real Settlement Wallet address for that rail.

---

## 9. CREATOR IDENTITY RELATIONSHIP

- Creator Identity is server-authoritative.
- Creator Identity is established by server-issued challenge/nonce + wallet signature + server verification.
- The immutable quote is bound to one Creator Identity.
- Payment verification MUST confirm that the independently verified payment sender/account is authorized for the Creator Identity associated with the immutable quote.
- Creator Identity is separate from Settlement Wallet.
- Creator Identity is separate from Creator Credit.

---

## 10. CREATOR CREDIT RELATIONSHIP

- ONE independently verified eligible payment -> MAXIMUM ONE Creator Credit.
- Creator Credit is bound to Creator Identity, not raw address.
- Payment-to-credit transition is atomic and server-side.
- Creator Credit state machine: AVAILABLE -> CONSUMING -> CONSUMED.
- Creator Credit is separate from Settlement Wallet.

---

## 11. IRYS SEPARATION

AETERNA Service Payment and Irys publication/storage are architecturally and economically independent layers.

Payment rail selection does NOT dictate:
- Irys payment asset;
- Irys payment network;
- Irys publication flow.

Irys payment asset/network are independently selected from Irys-supported assets/networks.

Current implementation disclosure:
- CURRENT IMPLEMENTATION uses server-side Executor Hot-funded Irys publication.
- TARGET BUSINESS BOUNDARY is separate Irys economics from the AETERNA Service Payment.
- This document does NOT redesign Irys implementation.

---

## 12. REMAINING PENDING DECISIONS

The following decisions remain PENDING and MUST NOT be treated as selected:

PENDING CANONICAL DECISION
- exact Settlement Wallet addresses per supported rail;
- exact price source/oracle for USD 1.00 conversion;
- exact payment provider/RPC/adapter for initial production rail;
- exact confirmation/finality thresholds per supported rail;
- exact payment evidence formats per rail/provider;
- exact Cloudflare Pages/Workers route and data-store architecture;
- exact reconciliation/refund policy for misdirected or expired payments;
- exact legal review outcome for service entitlement in selected jurisdictions.

---

## 13. LEGACY ISOLATION

The following are NOT valid sources for network/asset selection:

- Paddle;
- old Executor Hot payment role;
- old web3 payment verifier;
- old block pricing;
- historical Base/USDC-only assumptions that predate canonical reconciliation in SPEC-WP-18R; current canonical multi-rail selection is documented in this specification.

Any future selection MUST be based solely on current canonical documents and explicitly documented decisions.

---

## 14. SECURITY MODEL

Mandatory security invariants:
- server-side authority for all payment decisions;
- immutable quote locks asset, network, amount, recipient, and Creator Identity;
- single-use quote and payment evidence;
- server MUST independently establish payment facts from a trusted network source rather than accepting client-supplied evidence as authoritative;
- replay-resistant verification;
- frontend non-authority;
- Creator Credit bound to Creator Identity, not raw address;
- concurrent verification/credit grant serialized server-side;
- Settlement Wallet operational separation;
- wallet/account switching cannot transfer credit between identities;
- one Creator Credit is permitted at most one downstream consumption attempt;
- Settlement Wallet private key MUST be isolated from application runtime;
- Settlement Wallet compromise MUST NOT compromise Creator Credit authority or capsule contents;
- AETERNA initial production service-payment route is Base Mainnet + native USDC;
- AETERNA is NOT permanently single-rail; additional assets/networks may be added through explicit future canonical selection.

---

## 15. DECISION SUMMARY

Exact architectural decisions made:
- AETERNA service payment and Irys publication are separate layers.
- Payment authority chain is: Creator Identity -> immutable quote -> server verification -> Creator Credit.
- USD 1.00 is fixed; exact atomic amount is determined server-side.
- Server verifies recipient, asset, network, amount, quote, identity, finality, replay, and duplicate credit before granting credit.
- Payment-to-credit transition is atomic and server-side.
- Creator Credit is bound to Creator Identity, not raw address.
- Wallet/account/network/provider switching aborts active lifecycle and cannot transfer credit.
- Provider architecture MUST remain provider-neutral.
- Settlement Wallet MUST exist before production payment verification.
- Settlement Wallet custody: 2-of-3 multisig with hardware-backed keys.
- Settlement Wallet private key MUST be isolated from application runtime.
- All failures are fail-closed; no uncertain payment may grant credit.
- Supported rails: Base Mainnet + native USDC, Solana Mainnet + native USDC.
- Base is initial production rail; Solana is canonical target rail.

Pending decisions:
- exact Settlement Wallet addresses per rail;
- exact price source/oracle;
- exact confirmation/finality thresholds per rail;
- exact payment evidence formats per rail/provider;
- exact Cloudflare implementation details;
- exact reconciliation/refund policy;
- legal review completion.

---

## 16. REFERENCES

- AETERNA_MULTI_RAIL_SERVICE_PAYMENT_POLICY_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_COMPLETE_ENGINEERING_MODEL.md
- AETERNA_COMPLETE_SYSTEM_LOGIC.md
- AETERNA_COMPLETE_PROJECT_LOGIC.md
- AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
