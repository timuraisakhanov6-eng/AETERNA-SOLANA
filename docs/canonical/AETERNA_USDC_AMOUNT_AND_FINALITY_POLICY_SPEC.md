# AETERNA — USDC Amount and Finality Policy Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_BASE_USDC_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_HIGH_VOLUME_SERVICE_PAYMENT_VERIFICATION_SPEC.md
- AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_MVP_SETTLEMENT_WALLET_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md

---

## 1. NATIVE USDC IDENTITY

Selected asset:
- native USDC on Base Mainnet.

Authoritative identifier:
- PENDING OFFICIAL SOURCE RETRIEVAL.

Current official source status:
- attempt to retrieve authoritative contract address from current official
  Circle/USDC documentation did not return usable content in this environment;
- the authoritative token contract identifier MUST be obtained from official
  Circle/USDC documentation and recorded here before production activation.

Canonical rule:
- AETERNA service payment MUST use the official native USDC token on Base
  Mainnet as documented by Circle.
- Bridged, wrapped, or non-canonical USDC identifiers MUST NOT be used for
  the AETERNA service payment.
- The exact contract identifier is a required canonical fact.

Do NOT use:
- memory-derived addresses;
- legacy deployment assumptions;
- unofficial sources.

---

## 2. USDC DECIMALS

Standard USDC property on EVM networks:
- 6 decimals.

This is the standard decimal precision for native USDC on supported EVM chains.

Implication for atomic amount:
- 1 USDC = 1,000,000 atomic units.

This document does not assume 1 USD = 1 USDC for conversion.
See Section 5 for conversion policy.

---

## 3. EXACT ATOMIC AMOUNT

Commercial denomination:
- USD 1.00.

Network payment amount:
- exact atomic USDC amount = server-calculated value based on canonical price
  source.

Quote locking:
- exactAtomicAmount is server-calculated and locked in the immutable quote.
- exactAtomicAmount MUST be recorded in the immutable quote at quote creation
  time.
- The frontend MUST NOT choose exactAtomicAmount.
- The frontend MAY display the converted amount for informational purposes.

Quote fields locked:
- creatorIdentityId;
- serviceFeeUsd = 1.00;
- selectedPaymentAsset = native USDC;
- selectedNetwork = Base Mainnet;
- exactAtomicAmount = server-calculated;
- recipient = canonical Settlement Wallet.

---

## 4. $1 COMMERCIAL MODEL

The AETERNA service fee is:
- fixed commercial denomination: USD 1.00;
- not dependent on capsule size, Irys cost, network fees, or payment asset.

The USD 1.00 is:
- a commercial label;
- converted to exact atomic USDC amount by server-side logic.

---

## 5. USD → USDC CONVERSION POLICY

Required properties for the canonical price source:
- provides USD/USDC exchange rate for Base Mainnet native USDC;
- snapshot timing is defined server-side;
- quote locking occurs at quote creation;
- rounding rules are defined server-side;
- stale-data behavior is fail-closed;
- fail-closed behavior when source is unavailable.

Current status:
- exact price source/oracle for USD 1.00 conversion is PENDING CANONICAL
  DECISION.

Canonical rule:
- AETERNA does not currently treat 1 USDC as exactly 1 USD-equivalent by
  default.
- The conversion requires an explicit canonical price source/oracle.
- In the absence of an approved canonical price source, no production quote
  may be issued.

---

## 6. FINALITY POLICY

### 6.1 State Machine

Base Mainnet payment state machine:

OBSERVED:
- payment event detected in a Base Mainnet block.

CONFIRMING:
- payment included in block with confirmations counted.

FINAL:
- payment has reached required confirmation/finality threshold for Base
  Mainnet.

REORGED:
- payment was in a reorged block;
- payment MUST be re-evaluated.

INVALIDATED:
- payment is no longer valid due to reorg;
- verification MUST be reverted;
- Credit MUST NOT be granted.

### 6.2 Finality Threshold

Required confirmation/finality threshold for Base Mainnet:
- PENDING NETWORK POLICY.

The server MUST enforce the configured threshold before granting Credit.
The exact threshold MUST be defined per network before production use.

### 6.3 Base Mainnet Considerations

Base Mainnet characteristics to consider when setting finality:
- OP Stack-based L2;
- finality depends on L1 Ethereum confirmation of batch;
- reorg risk is lower than L1 after sufficient confirmations.

The exact numeric threshold is NOT invented in this document.

---

## 7. PAYMENT VERIFICATION RULE

VERIFIED payment requires ALL of the following:

1. correct chain: payment is on Base Mainnet;
2. correct USDC token: payment uses official native USDC on Base Mainnet;
3. correct sender/Creator Identity binding: verified payment sender matches
   server-verified account binding for the Creator Identity associated with
   the quote;
4. correct Settlement Wallet recipient: verified payment recipient matches
   canonical Settlement Wallet recipient recorded in immutable quote;
5. exact atomic amount: verified payment amount matches exactAtomicAmount
   recorded in immutable quote;
6. successful transaction: transaction status is success;
7. required finality: payment has reached required confirmation/finality
   threshold for Base Mainnet;
8. correct quote binding: payment is associated with exactly one immutable
   quote;
9. payment not previously consumed: payment evidence has not previously
   granted a Creator Credit.

Any uncertainty or missing check:
- NO VERIFIED PAYMENT.
- NO Creator Credit.

---

## 8. REORG HANDLING

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

## 9. PROVIDER AGREEMENT

When Alchemy and Chainstack return different results:
- provider disagreement => payment is NOT VERIFIED;
- no Credit until authoritative facts converge;
- AETERNA performs authoritative reconciliation;
- operators are alerted.

Provider consensus is NOT a substitute for blockchain authority.

---

## 10. FAIL-CLOSED CONDITIONS

Any of the following => NO VERIFIED PAYMENT => NO Creator Credit:

- price source/oracle unavailable;
- exact atomic amount cannot be calculated;
- settlement wallet not yet declared canonical;
- network mismatch;
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

## 11. QUOTE LOCKING

Immutable quote fields:
- creatorIdentityId;
- serviceFeeUsd = 1.00;
- selectedPaymentAsset = native USDC;
- selectedNetwork = Base Mainnet;
- exactAtomicAmount = server-calculated;
- recipient = canonical Settlement Wallet address.

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

## 12. REMAINING PENDING DECISIONS

PENDING CANONICAL DECISION:
- exact official Base Mainnet native USDC token contract identifier;
- exact price source/oracle for USD 1.00 conversion;
- exact finality threshold for Base Mainnet;
- exact reconciliation/refund policy for reorged/misdirected/expired payments;
- exact legal review outcome for service entitlement in selected jurisdictions.

No production payment verification may finalize until these PENDING items
are resolved and documented.

---

## 13. VERDICT

SPEC-WP-26 = COMPLETE

Reason:
- exact USDC identity policy is defined; exact contract identifier is
  documented as pending official source retrieval;
- atomic amount rule is unambiguous: server-calculated, locked in quote,
  requires canonical price source;
- finality policy is defined as explicit state machine with threshold
  documented as PENDING NETWORK POLICY;
- no contradictions with WP-18R..WP-25;
- no production code was required.

---

FINAL CONFIRMATION:

"No production code, API keys, wallets, Cloudflare resources, payment
integrations, or legacy files were created, modified, or deleted."
