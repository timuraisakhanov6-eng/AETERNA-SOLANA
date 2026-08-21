# AETERNA — USDC Amount and Finality Policy Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_MULTI_RAIL_SERVICE_PAYMENT_POLICY_SPEC.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md

---

## 1. BUSINESS AMOUNT

Fixed commercial denomination:
- USD 1.00.

Business rule:
- exactly 1 USDC = one capsule creation entitlement.

Network does NOT change the business amount.
Network is a payment-rail policy, not the business price.

Supported rails:
- Base Mainnet / native USDC;
- Solana Mainnet / native USDC.

Additional rails may be added only through explicit canonical selection.

---

## 2. NATIVE USDC IDENTITY

Canonical rule:
- AETERNA service payment MUST use the official native USDC token on the selected supported rail.
- Bridged, wrapped, or non-canonical USDC identifiers MUST NOT be used for the AETERNA service payment.

Base rail:
- asset: official native USDC on Base Mainnet.
- authoritative identifier: PENDING OFFICIAL SOURCE RETRIEVAL.
- exact Base Mainnet contract identifier MUST be obtained from official Circle/USDC documentation before production activation.

Solana rail:
- asset: official native USDC on Solana Mainnet.
- authoritative mint identifier: PENDING OFFICIAL SOURCE RETRIEVAL.
- exact Solana mint identifier MUST be obtained from official sources before production activation.

Do NOT use:
- memory-derived addresses;
- legacy deployment assumptions;
- unofficial sources.

---

## 3. USDC DECIMALS

Standard USDC property:
- 6 decimals on EVM networks.
- Solana USDC uses 6 decimals as defined by the official mint.

Implication for atomic amount:
- 1 USDC = 1,000,000 atomic units.

This document does not assume 1 USD = 1 USDC for conversion.
See Section 6 for conversion policy.

---

## 4. EXACT ATOMIC AMOUNT

Network payment amount:
- exact atomic USDC amount = server-calculated value based on canonical price source.

Quote locking:
- exactAtomicAmount is server-calculated and locked in the immutable quote;
- exactAtomicAmount MUST be recorded in the immutable quote at quote creation time;
- the frontend MUST NOT choose exactAtomicAmount;
- the frontend MAY display the converted amount for informational purposes.

Quote fields locked:
- creatorIdentityId;
- serviceFeeUsd = 1.00;
- selectedPaymentAsset = native USDC;
- selectedNetwork = chosen supported rail;
- exactAtomicAmount = server-calculated;
- recipient = canonical Settlement Wallet for the selected rail.

---

## 5. $1 COMMERCIAL MODEL

The AETERNA service fee is:
- fixed commercial denomination: USD 1.00;
- not dependent on capsule size, Irys cost, network fees, or payment asset.

The USD 1.00 is:
- a commercial label;
- converted to exact atomic USDC amount by server-side logic.

---

## 6. USD → USDC CONVERSION POLICY

Required properties for the canonical price source:
- provides USD/USDC exchange rate for the selected rail;
- snapshot timing is defined server-side;
- quote locking occurs at quote creation;
- rounding rules are defined server-side;
- stale-data behavior is fail-closed;
- fail-closed behavior when source is unavailable.

Current status:
- exact price source/oracle for USD 1.00 conversion is PENDING CANONICAL DECISION.

Canonical rule:
- AETERNA does not currently treat 1 USDC as exactly 1 USD-equivalent by default.
- The conversion requires an explicit canonical price source/oracle.
- In the absence of an approved canonical price source, no production quote may be issued.

---

## 7. FINALITY POLICY

Finality policy is rail-specific.

### 7.1 Base Mainnet

Base Mainnet payment state machine:

OBSERVED:
- payment event detected in a Base Mainnet block.

CONFIRMING:
- payment included in block with confirmations counted.

FINAL:
- payment has reached required confirmation/finality threshold for Base Mainnet.

REORGED:
- payment was in a reorged block;
- payment MUST be re-evaluated.

INVALIDATED:
- payment is no longer valid due to reorg;
- verification MUST be reverted;
- Credit MUST NOT be granted.

Required confirmation/finality threshold for Base Mainnet:
- PENDING NETWORK POLICY.

Base Mainnet characteristics to consider when setting finality:
- OP Stack-based L2;
- finality depends on L1 Ethereum confirmation of batch;
- reorg risk is lower than L1 after sufficient confirmations.

The exact numeric threshold is NOT invented in this document.

### 7.2 Solana Mainnet

Solana Mainnet payment state machine:

OBSERVED:
- payment signature/confirmation detected.

CONFIRMING:
- required Solana confirmation/finality status under evaluation.

FINAL:
- payment has reached required confirmation/finality threshold for Solana Mainnet.

REORGED/INVALIDATED:
- payment is no longer valid;
- verification MUST be reverted;
- Credit MUST NOT be granted.

Required confirmation/finality threshold for Solana Mainnet:
- PENDING IMPLEMENTATION POLICY.

Solana finality considerations:
- exact threshold MUST be defined per Solana network characteristics before production use.

The exact numeric threshold is NOT invented in this document.

---

## 8. PAYMENT VERIFICATION RULE

VERIFIED payment requires ALL of the following:

1. supported rail: payment is on a supported AETERNA payment rail;
2. correct asset: payment uses official native USDC on the selected rail;
3. correct sender/Creator Identity binding: verified payment sender matches server-verified account binding for the Creator Identity associated with the quote;
4. correct Settlement Wallet recipient: verified payment recipient matches canonical Settlement Wallet recipient recorded in immutable quote;
5. exact atomic amount: verified payment amount matches exactAtomicAmount recorded in immutable quote;
6. successful transaction: transaction status is success;
7. required finality: payment has reached required confirmation/finality threshold for the selected rail;
8. correct quote binding: payment is associated with exactly one immutable quote;
9. payment not previously consumed: payment evidence has not previously granted a Creator Credit.

Any uncertainty or missing check:
- NO VERIFIED PAYMENT.
- NO Creator Credit.

---

## 9. REORG HANDLING

Behavior when a payment:
- was observed;
- appeared confirmed;
- later reorged;
- became invalid.

Required outcomes:

REORGED/INVALIDATED:
- verification MUST be reverted;
- Credit MUST NOT be granted;
- state MUST be retained for retry/audit.

If Credit was already granted before a reorg is detected:
- state MUST reflect reverted verification;
- refund/recovery handling is PENDING canonical reconciliation policy.

Refund/reconciliation policy:
- PENDING CANONICAL DECISION.

---

## 10. PROVIDER AGREEMENT

When providers for the same rail return different results:
- provider disagreement => payment is NOT VERIFIED;
- no Credit until authoritative facts converge;
- AETERNA performs authoritative reconciliation;
- operators are alerted.

Provider consensus is NOT a substitute for blockchain authority.

Base rail provider policy:
- PRIMARY: Alchemy;
- SECONDARY: Chainstack.

Solana rail provider policy:
- PENDING IMPLEMENTATION REVIEW.

---

## 11. FAIL-CLOSED CONDITIONS

Any of the following => NO VERIFIED PAYMENT => NO Creator Credit:

- price source/oracle unavailable;
- exact atomic amount cannot be calculated;
- settlement wallet not yet declared canonical for selected rail;
- unsupported rail selected;
- unsupported asset selected;
- asset mismatch;
- recipient mismatch;
- amount mismatch;
- sender mismatch;
- insufficient finality;
- reorg detected;
- provider disagreement;
- payment evidence not found;
- replay detected;
- quote expired;
- quote already consumed;
- any verification stage fails.

---

## 12. QUOTE LOCKING

Immutable quote fields:
- creatorIdentityId;
- serviceFeeUsd = 1.00;
- selectedPaymentAsset = native USDC;
- selectedNetwork = chosen supported rail;
- exactAtomicAmount = server-calculated;
- recipient = canonical Settlement Wallet address for selected rail.

Quote lifecycle:
- createdAt: server timestamp;
- expiresAt: server-defined expiration;
- status: created/used/expired/cancelled.

Quote rules:
- once created, immutable fields MUST NOT change;
- single-use: each quote consumed at most once;
- after successful verification, quote status -> used;
- expired quote MUST NOT grant Creator Credit.

---

## 13. REMAINING PENDING DECISIONS

PENDING CANONICAL DECISION:
- exact official Base Mainnet native USDC token contract identifier;
- exact official Solana Mainnet native USDC mint identifier;
- exact price source/oracle for USD 1.00 conversion;
- exact finality threshold for Base Mainnet;
- exact finality threshold for Solana Mainnet;
- exact reconciliation/refund policy for reorged/misdirected/expired payments;
- exact legal review outcome for service entitlement in selected jurisdictions.

No production payment verification may finalize until these PENDING items are resolved and documented.

---

## 14. VERDICT

SPEC-WP-26 = COMPLETE

Reason:
- exact USDC identity policy is defined; exact contract/mint identifiers are documented as pending official source retrieval;
- atomic amount rule is unambiguous: server-calculated, locked in quote, requires canonical price source;
- finality policy is defined as explicit rail-specific state machines with thresholds documented as PENDING NETWORK POLICY / PENDING IMPLEMENTATION POLICY;
- multi-rail model is explicit: Base + Solana;
- no contradictions with WP-18R..WP-25 or current multi-rail canonical documents;
- no production code was required.

---

FINAL CONFIRMATION:

"No production code, API keys, wallets, Cloudflare resources, payment integrations, Irys implementation, or legacy files were created, modified, or deleted."
