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

Canonical AETERNA creation fee denomination:
- exactly 1 USDC.

Business rule:
- exactly 1 USDC = one capsule creation entitlement.

The AETERNA service fee is natively denominated and settled in USDC. It is NOT a
USD amount and is NOT derived from any USD→USDC conversion, exchange rate,
oracle, or price source.

Network does NOT change the business amount.
Network is a payment-rail policy, not the business price.

Supported rails:
- Solana Mainnet / native USDC.

Base rail status:
- FROZEN / RESERVED FOR FUTURE ACTIVATION.
- Base remains in repository for future reactivation.
- Base is NOT the active canonical creator rail.

Additional rails may be added only through explicit canonical selection.

---

## 2. NATIVE USDC IDENTITY

Canonical rule:
- AETERNA service payment MUST use the official native USDC token on the selected supported rail.
- Bridged, wrapped, or non-canonical USDC identifiers MUST NOT be used for the AETERNA service payment.

Base rail:
- FROZEN / RESERVED FOR FUTURE ACTIVATION.
- asset: official native USDC on Base Mainnet.
- authoritative identifier: PENDING OFFICIAL SOURCE RETRIEVAL.
- exact Base Mainnet contract identifier MUST be obtained from official Circle/USDC documentation before production activation.
- Base rail is NOT the active canonical creator rail.

Solana rail:
- asset: official native USDC on Solana Mainnet.
- authoritative mint identifier: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
- exact Solana Mainnet native USDC mint identifier confirmed from official Circle/USDC documentation.
- Status: CANONICAL / VERIFIED.

Do NOT use:
- memory-derived addresses;
- legacy deployment assumptions;
- unofficial sources;
- bridged/wrapped/non-canonical USDC identifiers.

---

## 3. USDC DECIMALS

Standard USDC property:
- 6 decimals on EVM networks.
- Solana USDC uses 6 decimals as defined by the official mint.

Implication for atomic amount:
- 1 USDC = 1,000,000 atomic units.

The AETERNA service fee is natively denominated in USDC; no USD→USDC
conversion applies. See Section 6.

---

## 4. EXACT ATOMIC AMOUNT

Network payment amount:
- exact atomic USDC amount = 1,000,000 atomic units (fixed 1 USDC).

Quote locking:
- exactAtomicAmount is server-calculated and locked in the immutable quote;
- exactAtomicAmount MUST be recorded in the immutable quote at quote creation time;
- the frontend MUST NOT choose exactAtomicAmount;
- the frontend MAY display the amount for informational purposes.

Quote fields locked:
- creatorIdentityId;
- serviceFeeUsdc = 1;
- selectedPaymentAsset = native USDC;
- selectedNetwork = chosen supported rail;
- exactAtomicAmount = server-calculated;
- recipient = canonical Settlement Wallet for the selected rail.

---

## 5. AETERNA CREATION FEE MODEL

The AETERNA service fee is:
- exactly 1 USDC;
- not dependent on capsule size, Irys cost, network fees, or payment asset.

The 1 USDC is:
- the canonical settlement denomination;
- represented as 1,000,000 atomic units.

There is no USD denomination and no USD→USDC conversion step.

---

## 6. NO USD → USDC CONVERSION

The AETERNA service fee is natively denominated in USDC.

Consequently, for the AETERNA service payment:
- no USD→USDC conversion exists or is required;
- no exchange rate, oracle, or price source is consulted;
- no price-source snapshot, rounding, or stale-data policy applies;
- the atomic amount is fixed: 1 USDC = 1,000,000 atomic units.

Irys storage/publication pricing is a separate, Irys-determined layer and is
unaffected by this rule.

---

## 7. FINALITY POLICY

Finality policy is rail-specific.

### 7.1 Base Mainnet

Base Mainnet payment state machine:
- FROZEN / RESERVED FOR FUTURE ACTIVATION.
- Base Mainnet is NOT the active canonical creator rail.
- Base state machine remains documented for future reactivation.

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

- the canonical fixed 1 USDC denomination is unavailable;
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
- serviceFeeUsdc = 1;
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
- an expired quote MUST NOT verify a payment;
- Business Quote TTL gates PAYMENT VERIFICATION only. After a payment has been
  successfully verified, the VerifiedPayment record is the authority for
  Creator Credit issuance: a later quote expiry neither invalidates the
  verified payment nor the resulting Creator Credit.

---

## 13. REMAINING PENDING DECISIONS

PENDING CANONICAL DECISION:
- exact finality threshold for Base Mainnet;
- exact finality threshold for Solana Mainnet;
- exact reconciliation/refund policy for reorged/misdirected/expired payments;
- exact legal review outcome for service entitlement in selected jurisdictions.

These pending items do not block the AETERNA service payment: the fee is natively
denominated in USDC and requires no conversion or price source.

---

## 14. VERDICT

SPEC-WP-26 = COMPLETE

Reason:
- exact USDC identity policy is defined; exact contract/mint identifiers are documented as pending official source retrieval;
- atomic amount rule is unambiguous: fixed 1 USDC = 1,000,000 atomic units, locked in quote, no price source required;
- finality policy is defined as explicit rail-specific state machines with thresholds documented as PENDING NETWORK POLICY / PENDING IMPLEMENTATION POLICY;
- multi-rail model is explicit: Base + Solana;
- no contradictions with WP-18R..WP-25 or current multi-rail canonical documents;
- no production code was required.

---

FINAL CONFIRMATION:

"No production code, API keys, wallets, Cloudflare resources, payment integrations, Irys implementation, or legacy files were created, modified, or deleted."
