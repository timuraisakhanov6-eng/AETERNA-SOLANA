# AETERNA — Multi-Rail Service Payment Policy Specification

Status: Canonical
Authority: Business Layer
Version: 1.0
Reference:
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_BASE_USDC_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_USDC_AMOUNT_AND_FINALITY_POLICY_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md

---

## 1. PURPOSE

This document defines the canonical multi-rail business model for AETERNA service payments.

It defines:
- the fixed business amount;
- the entitlement rule;
- supported payment rails;
- the separation between Business Authority and payment-rail policy;
- the canonical creator entry flow;
- /create business semantics;
- Irys business boundary;
- Base rail policy;
- Solana rail target status;
- fail-closed verification principle;
- Creator Credit relationship.

This document does NOT implement payment verification, wallet adapters, Irys publication, protocol core, or storage semantics.

---

## 2. BUSINESS MODEL

AETERNA Service Payment:
- amount: exactly 1 USDC;
- purpose: one capsule creation entitlement.

Canonical business rule:
- one verified payment of exactly 1 USDC
- = one capsule creation entitlement.

Network is a payment-rail policy, not the business price.

---

## 3. EXACT 1 USDC

The AETERNA service fee is:
- fixed commercial denomination: USD 1.00;
- not dependent on capsule size, Irys cost, network fees, or payment asset.

The USD 1.00 is:
- a commercial label;
- converted to exact atomic token amount by server-side logic per rail.

Frontend MUST NOT choose the authoritative amount.
Frontend MAY display the amount for informational purposes.

---

## 4. ONE PAYMENT → ONE CAPSULE ENTITLEMENT

Verified payment rules:
- ONE independently verified eligible payment -> MAXIMUM ONE Creator Credit;
- Creator Credit grants entitlement to attempt one capsule creation;
- capsule size, storage volume, Irys cost, and network fees do NOT affect entitlement count.

---

## 5. BUSINESS AUTHORITY vs PAYMENT RAIL

Business Authority:
- AETERNA verifies exactly 1 USDC;
- AETERNA grants one capsule entitlement.

Payment Rail:
- Base Mainnet / native USDC;
- Solana Mainnet / native USDC.

Each rail has its own parameters:
- asset identity / mint;
- transaction semantics;
- transfer evidence format;
- finality policy;
- provider/RPC architecture;
- Settlement Wallet recipient policy.

Verification implementations MUST NOT mix rail-specific parameters.
Business Authority remains constant across rails.

---

## 6. SUPPORTED RAILS

Canonical supported rails:
1. Solana Mainnet / native USDC.

Base rail status:
- FROZEN / RESERVED FOR FUTURE ACTIVATION.
- Base is retained in repository and may be reactivated through explicit canonical selection.
- No new Base creation path or Base storage path is active in the current canonical model.

Additional rails may be added only through explicit canonical selection.

---

## 7. CREATOR ENTRY FLOW

Canonical creator flow:

Landing
↓
CREATE CAPSULE
↓
Service Payment Modal
↓
choose supported payment rail
↓
connect supported Solana-compatible wallet
↓
automatic amount:
$1.00 USDC
↓
user confirms
↓
AETERNA server verifies
↓
Verified Payment
↓
Creator Credit
↓
one capsule creation entitlement

Requirements:
- CREATE CAPSULE MUST open the service-payment gate;
- first explicit creation action starts service payment if no valid Creator Credit is available for final creation;
- /create MUST NOT auto-trigger wallet/signature/payment on mount;
- there is NO second AETERNA Service Payment before final CREATE CAPSULE.

---

## 8. /CREATE BUSINESS SEMANTICS

/create is the capsule preparation workspace.

Inside /create the user:
- adds text;
- adds files/media;
- chooses opening date;
- prepares capsule content.

Display requirement:

TOTAL CONTENT
<aggregated content size>

Content size is INFORMATIONAL ONLY.

Content size MUST NOT determine:
- AETERNA Service Payment;
- entitlement count;
- blocks;
- progressive pricing;
- next-block price;
- per-MB AETERNA fee.

Active canonical documents MUST NOT retain block-based commercial pricing language.

Current canonical creator rail:
- supported Solana-compatible wallet.

Base rail:
- frozen/reserved; not active in canonical creator flow.

---

## 9. IRYS BUSINESS BOUNDARY

AETERNA Service Payment and Irys publication/storage are architecturally and economically independent layers.

AETERNA payment:
- $1 USDC;
- paid to AETERNA;
- grants one capsule creation entitlement.

Irys:
- separate publication/storage economics;
- NOT included in the AETERNA Service Payment;
- NOT paid by AETERNA as part of the service fee.

Canonical rule:
- DO NOT claim that $1 includes Irys;
- DO NOT claim that AETERNA service payment pays for storage.

Current implementation disclosure:
- CURRENT IMPLEMENTATION uses server-side Executor Hot-funded Irys publication.
- TARGET BUSINESS BOUNDARY is separate Irys economics from the AETERNA Service Payment.
- Base rail is frozen and reserved for future activation; active canonical creator rail is a supported Solana-compatible wallet.
- This document does NOT redesign Irys implementation.

---

## 10. BASE RAIL POLICY

Base rail status:
- FROZEN / RESERVED FOR FUTURE ACTIVATION.
- Base rail is retained for future reactivation.
- Base rail is NOT the active canonical creator rail.
- No new Base creation path is active.
- No new Base storage path is active.

Base rail parameters remain documented for future activation:
- network: Base Mainnet;
- asset: official native USDC on Base Mainnet;
- transaction semantics: EVM transfer evidence;
- atomic unit precision: 6 decimals for USDC;
- finality policy: documented in AETERNA_USDC_AMOUNT_AND_FINALITY_POLICY_SPEC.md;
- provider/RPC policy: documented in AETERNA_BASE_USDC_PAYMENT_PROVIDER_SELECTION_SPEC.md;
- settlement recipient policy: documented in AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md.

Base rail does NOT define the universal business rule.
Base rail is one supported payment rail, currently frozen.

---

## 11. SOLANA RAIL TARGET

Solana rail status:
- ACTIVE CANONICAL CREATOR RAIL.

Solana rail parameters:
- network: Solana Mainnet;
- asset: native USDC mint on Solana;
- transaction semantics: SPL Token transfer evidence;
- finality policy: PENDING IMPLEMENTATION POLICY;
- provider/RPC policy: PENDING IMPLEMENTATION REVIEW;
- settlement recipient: AETERNA_SOLANA_SERVICE_SETTLEMENT_ADDRESS = `6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu`;
- token mint: documented as CANONICAL / VERIFIED in AETERNA_USDC_AMOUNT_AND_FINALITY_POLICY_SPEC.md.

Until Solana rail policy is fully documented and operational:
- no production quote MAY be issued for other rails;
- no verification MAY be finalized for other rails as the active creator flow.

---

## 12. FAIL-CLOSED VERIFICATION

All payment verification is fail-closed.

Any uncertainty or missing check:
- NO VERIFIED PAYMENT;
- NO Creator Credit.

Provider disagreement:
- payment is NOT VERIFIED;
- no Credit until authoritative facts converge.

---

## 13. CREATOR CREDIT RELATIONSHIP

Creator Credit:
- bound to Creator Identity, not raw address;
- atomic and server-side;
- AVAILABLE -> CONSUMING -> CONSUMED;
- separate from Settlement Wallet;
- separate from Irys publication state.

One verified payment may grant at most one Creator Credit.
Payment replay or duplicate evidence MUST NOT grant additional Credit.

---

## 14. PAYMENT AUTHORITY BOUNDARIES

Frontend state is NEVER authority for:
- payment amount;
- payment existence;
- payment finality;
- payment replay status;
- Creator Credit grant.

Server-side verification is ALWAYS authority for:
- payment facts;
- quote validity;
- entitlement;
- Credit grant.

---

## 15. NON-CUSTODIAL BOUNDARIES

AETERNA:
- never holds user wallet credentials;
- never holds user signing keys;
- never acts as wallet custodian;
- never chooses payment amount on behalf of the user beyond the canonical fixed business amount display.

Wallet signing remains in the user-controlled environment.

---

## 16. REMAINING PENDING DECISIONS

PENDING CANONICAL DECISION:
- exact Settlement Wallet addresses per rail;
- exact price source/oracle for USD 1.00 conversion;
- exact confirmation/finality thresholds per supported rail;
- exact payment evidence formats per rail/provider;
- exact Cloudflare Pages/Workers route and data-store architecture;
- exact reconciliation/refund policy;
- exact legal review outcome.

No production payment verification may finalize until required pending items are resolved and documented.

---

## 17. DOCUMENT AUTHORITY

This document is subordinate to:
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md

If this document conflicts with the above, the above is authoritative.

---

FINAL CONFIRMATION:

"No production code, API keys, wallets, Cloudflare resources, payment integrations, Irys implementation, protocol core, storage, Seal, or frontend were created, modified, or deleted."
