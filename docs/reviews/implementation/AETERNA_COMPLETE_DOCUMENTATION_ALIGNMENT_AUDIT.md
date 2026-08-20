# AETERNA Complete Documentation Alignment Audit

Status: APPLIED ALIGNMENT

---

## A. DOC-ALIGN-1 Audit Result

DOC-ALIGN-1 completed a read-only documentation audit across canonical, implementation, review, RFC, human-readable, and AI documentation. Primary old-model conflicts were identified in:

- `docs/canonical/AETERNA_INFRASTRUCTURE.md`
- `docs/canonical/AETERNA_COMPLETE_SYSTEM_LOGIC.md`
- `docs/canonical/AETERNA_COMPLETE_PROJECT_LOGIC.md`

No production code or protocol invariant changes were made during DOC-ALIGN-1.

---

## B. Documents Modified in DOC-ALIGN-2

- `docs/canonical/AETERNA_INFRASTRUCTURE.md`
- `docs/canonical/AETERNA_COMPLETE_SYSTEM_LOGIC.md`
- `docs/canonical/AETERNA_COMPLETE_PROJECT_LOGIC.md`
- `README.md`

---

## C. Exact Sections Modified

### `docs/canonical/AETERNA_INFRASTRUCTURE.md`

- Replaced current canonical payment/infrastructure descriptions:
  - Removed Paddle/bank-card as current canonical service-payment path.
  - Removed Executor Hot as canonical AETERNA service-payment receiver.
  - Removed Executor Hot as the entity that pays Irys from client service payments.
- Added current canonical entities:
  - `AETERNA_SETTLEMENT_WALLET`
  - `CREATOR_IDENTITY`
  - `CREATOR_CREDIT`
- Added explicit AETERNA Service Payment vs Irys separation.
- Updated Business Layer and Storage Layer descriptions to use `Creator Service Quote` instead of `Business Quote`.
- Added a current-model summary section for creator identity/credit flow.

### `docs/canonical/AETERNA_COMPLETE_SYSTEM_LOGIC.md`

- Replaced legacy payment milestone terminology with current canonical terminology:
  - `PAID` → `PAYMENT VERIFIED`
- Aligned Business Authority language to current canonical creator model:
  - Added `AETERNA service payment`, `Creator Service Quote`, and `Creator Credit authority`.
  - Explicitly excluded `Irys publication/storage payment` from Business Authority governance.
- Preserved all protocol/crypto/storage/Trusted Time/Heartbeat/Emergency Runtime rules.

### `docs/canonical/AETERNA_COMPLETE_PROJECT_LOGIC.md`

- Separated AETERNA service payment from Irys publication payment in human-readable product language.
- Clarified that internal operational calculations must not affect:
  - $1 AETERNA service fee
  - Creator Credit amount
  - payment entitlement
  - eligibility
- Confirmed capsule size and storage blocks are not service pricing inputs.

### `README.md`

- Updated Business Authority description to current canonical terminology:
  - `Creator Service Quote + service-payment validation + Creator Credit authority`

---

## D. Old-Model Conflicts Corrected

| Document | Old Meaning | Corrected Meaning |
|---|---|---|
| `AETERNA_INFRASTRUCTURE.md` | Paddle/bank-card presented as current canonical payment path | Legacy path preserved only for backward compatibility; not current canonical authority |
| `AETERNA_INFRASTRUCTURE.md` | Executor Hot described as AETERNA service-payment receiver and Irys funder | Settlement Wallet is the AETERNA service-payment recipient; Irys is a separate publication/storage payment layer |
| `AETERNA_COMPLETE_SYSTEM_LOGIC.md` | `PAID` used as canonical business milestone | `PAYMENT VERIFIED` is the canonical payment milestone |
| `AETERNA_COMPLETE_SYSTEM_LOGIC.md` | `Business Quote` used for current commercial object | `Creator Service Quote` is the current canonical commercial object |
| `AETERNA_COMPLETE_PROJECT_LOGIC.md` | AETERNA service payment tied to Irys payment asset flow | AETERNA service payment and Irys publication payment are independent layers |

---

## E. Historical Documents Preserved

The following historical review reports were preserved unchanged:

- `docs/reviews/implementation/AETERNA_CODEBASE_CANONICAL_ALIGNMENT_AUDIT.md`
- `docs/reviews/implementation/AETERNA_CODE_MIGRATION_1_CREATOR_IDENTITY_PAYMENT_AUTHORITY.md`
- `docs/reviews/implementation/AETERNA_CODE_MIGRATION_2_ACTIVE_RUNTIME_AUTHORIZATION.md`
- `docs/reviews/implementation/AETERNA_CODE_MIGRATION_3_FRONTEND_CANONICAL_RUNTIME.md`

These documents retain historical findings, including legacy Paddle/web3 references. They are historical evidence and were not rewritten.

---

## F. Remaining Legacy Terminology

| Term | Classification | Notes |
|---|---|---|
| `Business Quote` in historical review docs | HISTORICAL | Preserved as implementation record |
| `PAID` in historical revision notes | HISTORICAL | Preserved in revision history |
| `Paddle` in historical review docs | HISTORICAL | Preserved as implementation record |
| `block pricing` in historical review docs | HISTORICAL | Preserved as implementation record |
| `Executor Hot` in historical contexts | HISTORICAL / PENDING | Retained as technical component where present, not current canonical service-payment authority |
| `storage blocks` in canonical specs | VALID | Used to define what is not pricing-relevant |
| `Irys flow` wording in selection docs | VALID | Refers to Irys publication flow, not AETERNA service payment |

No active current-document occurrences of `Business Quote Authority` or `PAID description` remain as canonical model terminology.

---

## G. Remaining Genuine PENDING Decisions

- Final custody/key-management architecture for AETERNA Settlement Wallet.
- Final approved asset/network list for initial AETERNA service payment.
- Exact canonical recovery mechanism details for interrupted/stale lifecycles beyond current specification.
- Exact Cloudflare KV binding names for `CREATOR_IDENTITIES` and `CREATOR_CREDITS`.
- Exact canonical replacement for Emergency Runtime Manifest resolution path when AETERNA server is unavailable.

---

## H. Cross-Document Consistency Result

Current canonical documentation consistently describes:

1. Creator Identity: server-verifiable creator principal bound to verified wallet/account control.
2. $1 USD = 1 Creator Credit.
3. Creator Credit: persistent entitlement, not storage pricing, not Irys payment, not gas.
4. Creator Service Quote: server-created, server-persisted, immutable, bound to Creator Identity.
5. AETERNA service payment receiver: AETERNA Settlement Wallet.
6. AETERNA service payment ≠ Irys payment.
7. Irys cost is determined by Irys.
8. AETERNA service payment and Irys payment may use different networks/assets.
9. Credit becomes AVAILABLE after verified AETERNA service payment.
10. Credit becomes CONSUMING at capsule lifecycle start.
11. Credit becomes CONSUMED only after authoritative publication AND authoritative Seal.
12. One Credit cannot authorize two active capsule lifecycles.
13. Authoritative sources: server-created Quote, server-verified payment, authoritative publication proof, authoritative Seal proof.
14. Frontend is never authority.
15. Capsule size does not affect AETERNA service fee.
16. Payment does not have to be consumed immediately.
17. Failed lifecycle before final success preserves/restores Credit.
18. Publication proof must come from authoritative server-validated source.
19. Seal proof requires authoritative publication success plus Seal success plus correct lifecycle binding.

---

## I. Security Ambiguity Result

Post-alignment documentation was reviewed for wording that could lead implementers to:

- trust client payment state
- treat raw address as identity
- grant Credit from frontend
- consume Credit before publication + Seal
- treat Irys payment as AETERNA service payment
- authorize upload from transactionId alone
- treat provider session as authority

Current applicable documentation does not contain active wording that would cause these implementation errors. Historical documents remain explicitly historical.

---

## J. Production Code / Configuration Touched

None.

DOCUMENTATION ALIGNMENT VERIFIED. Production code, configuration, crypto, storage, Seal implementation, wallets, and payment integrations were not modified in DOC-ALIGN-2.
