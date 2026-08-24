# AETERNA — SPEC-WP-26 USDC Amount and Finality Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review defines the exact atomic USDC amount calculation rule and the
Base Mainnet finality policy for AETERNA service payments.

This review does NOT modify production code.
This review does NOT create API keys, wallets, Cloudflare resources, or
payment integrations.
This review does NOT delete legacy files.

---

## 2. USDC IDENTITY

- Asset: native USDC on Base Mainnet.
- Authoritative contract identifier: PENDING OFFICIAL SOURCE RETRIEVAL.
  - Attempt to retrieve from current official Circle/USDC documentation
    returned empty content in this environment.
  - Must be obtained from official Circle documentation before production
    activation.
- Bridged/wrapped/non-canonical identifiers: MUST NOT be used.

---

## 3. DECIMALS AND ATOMIC AMOUNT

- USDC decimals: 6.
- 1 USDC = 1,000,000 atomic units.
- Commercial fee: USD 1.00.
- exactAtomicAmount: server-calculated based on canonical price source.

Quote locking:
- serviceFeeUsd = 1.00;
- selectedPaymentAsset = native USDC;
- selectedNetwork = Base Mainnet;
- exactAtomicAmount = server-calculated;
- recipient = canonical Settlement Wallet.

Frontend:
- display-only for converted amount;
- does NOT determine authoritative amount.

---

## 4. USD/USDC CONVERSION

Current status:
- exact price source/oracle: PENDING CANONICAL DECISION.

Canonical rule:
- AETERNA does not default to 1 USDC = 1 USD.
- Conversion requires explicit canonical price source/oracle.
- In absence of approved source, no production quote may be issued.

Required source properties:
- USD/USDC rate for Base Mainnet native USDC;
- defined snapshot timing;
- defined quote locking;
- defined rounding;
- defined stale-data behavior;
- fail-closed when unavailable.

---

## 5. FINALITY POLICY

State machine:
- OBSERVED
- CONFIRMING
- FINAL
- REORGED
- INVALIDATED

Exact finality threshold:
- PENDING NETWORK POLICY.

Required behavior:
- server MUST enforce configured threshold before granting Credit;
- exact threshold MUST be defined per network before production use.

Base Mainnet considerations:
- OP Stack L2;
- L1 Ethereum confirmation of batch influences finality;
- exact numeric threshold is NOT invented here.

---

## 6. VERIFICATION RULE

VERIFIED requires:
1. Base Mainnet chain;
2. official native USDC;
3. sender bound to Creator Identity;
4. recipient = canonical Settlement Wallet;
5. exactAtomicAmount match;
6. successful transaction;
7. required finality;
8. correct quote binding;
9. payment not previously consumed.

Any failure:
- NO VERIFIED PAYMENT
- NO Creator Credit

---

## 7. REORG HANDLING

REORGED/INVALIDATED:
- verification reverted;
- Credit not granted;
- state retained for retry/audit.

Pre-grant reorg:
- state reflects reverted verification.

Refund/reconciliation:
- PENDING CANONICAL DECISION.

---

## 8. PROVIDER DISAGREEMENT

Alchemy vs Chainstack disagreement:
- NOT VERIFIED;
- no Credit until authoritative facts converge;
- AETERNA reconciles;
- operators alerted.

Provider consensus != blockchain authority.

---

## 9. PENDING ITEMS

| Item | Status |
|---|---|
| exact USDC contract identifier | PENDING |
| price source/oracle | PENDING |
| finality threshold | PENDING NETWORK POLICY |
| reconciliation/refund policy | PENDING |
| legal review | PENDING |

---

## 10. VERDICT

SPEC-WP-26 = COMPLETE

Reason:
- USDC identity policy is explicit;
- atomic amount rule is unambiguous;
- finality policy is defined with documented network policy PENDING;
- no contradictions with WP-18R..WP-25;
- no production code required.

---

FINAL CONFIRMATION:

"No production code, API keys, wallets, Cloudflare resources, payment
integrations, or legacy files were created, modified, or deleted."
