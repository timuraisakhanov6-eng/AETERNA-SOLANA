# AETERNA — SPEC-WP-21 Settlement Wallet Signer Operations Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review resolves the operational prerequisites that blocked SPEC-WP-20
and verifies that all required operational rules are explicitly defined for
the future AETERNA Settlement Wallet Safe multisig on Base Mainnet.

This review does NOT create a Safe.
This review does NOT generate signer addresses.
This review does NOT import seed phrases or private keys.
This review does NOT modify production code.
This review does NOT modify wrangler.toml.
This review does NOT create Cloudflare resources.
This review does NOT connect a payment provider.

---

## 2. SIGNER CONTROL MODEL

Defined canonical rule:
- three independent signer controls: Signer A, Signer B, Signer C;
- no shared seed phrase;
- no application-runtime custody;
- no single operator unilateral control over 2 or more signers unless an
  explicit operational policy is documented and approved.

Status:
- RESOLVED

---

## 3. ROLE SEPARATION

Defined generic roles:
- Signer;
- Transaction proposer;
- Transaction confirmer;
- Emergency/recovery authority.

Defined combination rules:
- A single operator MAY hold multiple roles ONLY if explicitly documented
  and approved by a separate operational policy;
- In the absence of an approved operational policy, Signer A/B/C are
  independent, transaction proposer and confirmer SHOULD be separated, and
  emergency/recovery authority MUST be separate from normal operational
  signers.

Status:
- RESOLVED at architectural level
- exact role assignments: PENDING
- exact approval workflow for role combinations: PENDING

---

## 4. HARDWARE POLICY

Defined requirements:
- each signer MUST use a hardware wallet or equivalent hardware-backed key
  storage mechanism;
- private key material MUST NEVER leave the hardware device;
- signing MUST occur on the hardware device;
- device MUST support Safe signing on Base Mainnet;
- one device/account per signer;
- devices MUST be physically separate;
- backup/recovery MUST be possible without exposing private keys to AETERNA
  runtime;
- no private key export into software wallets or AETERNA runtime;
- no seed phrase import into AETERNA runtime or connected systems.

Accepted device classes:
- Ledger hardware wallets;
- Trezor hardware wallets;
- other hardware wallets compatible with Safe on EVM networks.

Status:
- RESOLVED at architectural level
- exact hardware wallet models/vendors: PENDING
- exact provisioning procedure: PENDING

---

## 5. PHYSICAL SEPARATION

Defined principle:
- The three signer controls SHOULD be physically separated so that one
  incident does not compromise multiple signers.

Requirements:
- signer devices MUST be stored in separate locations unless explicitly
  documented as an approved operational policy;
- physical separation MUST NOT prevent 2-of-3 threshold operations under
  normal conditions.

Status:
- RESOLVED at architectural level
- exact physical separation policy: PENDING
- exact storage locations: PENDING

---

## 6. LOSS / COMPROMISE

Defined outcomes:

A. one signer lost:
   - Safe remains operable;
   - signer replacement required;
   - remaining 2 signers can execute replacement.

B. one signer device destroyed:
   - Safe remains operable;
   - signer replacement required;
   - recovery of destroyed device not required.

C. one signer compromised:
   - Safe remains operable;
   - compromised signer MUST be removed;
   - new signer added with 2-of-3 confirmation;
   - AETERNA runtime MUST NOT be involved.

D. one signer unavailable:
   - Safe remains operable with 2 signers;
   - if only 1 signer available, Safe NOT operable; recovery required.

E. two signers unavailable:
   - Safe is NOT operable;
   - emergency recovery procedure required.

F. suspected multisig compromise:
   - Safe MUST be treated as compromised;
   - emergency recovery procedure required;
   - AETERNA runtime MUST NOT attempt autonomous resolution.

Status:
- RESOLVED at architectural level
- exact emergency/recovery procedures: PENDING

---

## 7. SIGNER ROTATION

Defined rules:
- signer rotation is permitted for loss, compromise, or operational policy;
- rotation MUST be executed via Safe transaction with 2-of-3 confirmation;
- rotation MUST maintain 2-of-3 threshold;
- Safe address remains stable when signers rotate;
- Safe address changes ONLY if Safe itself is replaced;
- existing immutable Service Quotes remain bound to original Safe address;
- new quotes after rotation bind to same Safe address unless Safe replaced;
- if Safe replaced, new quotes bind to new address; old quotes remain bound
  to old address.

Status:
- RESOLVED at architectural level
- exact rotation procedure: PENDING

---

## 8. WITHDRAWAL POLICY

Defined separation:
- Receiving service payments: automated; no special authority required;
- Monitoring: operational team or automated alerting;
- Proposing withdrawal: restricted role;
- Approving withdrawal: separate restricted role;
- Executing withdrawal: requires 2-of-3 signer confirmations via Safe.

Rules:
- AETERNA application runtime MUST NOT perform automatic withdrawals;
- Withdrawal MUST be an explicit operational action;
- Withdrawal MUST require 2-of-3 signer confirmations;
- Withdrawal MUST follow approved operational procedures.

Status:
- RESOLVED at architectural level
- exact operational roles for withdrawal: PENDING
- exact approval workflow: PENDING

---

## 9. MONITORING

Defined required categories:
- unexpected outgoing transaction from Safe;
- unexpected Safe configuration/owner change;
- Safe threshold change;
- Safe signer replacement;
- abnormal payment receipt pattern;
- suspicious activity related to Safe operations.

Requirements:
- monitoring MUST be configured for the Safe address;
- monitoring MUST detect anomalies in real time or near-real time;
- monitoring MUST alert authorized operators;
- monitoring data MUST be auditable.

Status:
- RESOLVED at architectural level
- exact monitoring service/configuration: PENDING

---

## 10. WALLET CREATION CHECKLIST

Prerequisites before Safe creation:
- [ ] three approved signer controls — PENDING
- [ ] hardware-backed devices available — PENDING
- [ ] signer independence confirmed — PENDING
- [ ] backup/recovery prepared — PENDING
- [ ] operational policy approved — PENDING
- [ ] Base Mainnet selected — RESOLVED
- [ ] Safe 2-of-3 selected — RESOLVED

Status:
- NOT READY — 5 checklist items remain PENDING

---

## 11. VERDICT

SPEC-WP-21 = NOT READY

Reason:
- All required operational rules are explicitly defined at the architectural
  level:
  - signer model;
  - role separation;
  - hardware policy;
  - physical separation;
  - loss/compromise handling;
  - signer rotation;
  - withdrawal authority;
  - monitoring;
  - wallet-creation prerequisites.
- However, exact operational decisions remain PENDING:
  - exact signer identities/entities;
  - exact hardware wallet models/vendors;
  - exact operational roles and separation of duties;
  - exact physical separation policy;
  - exact backup/recovery mechanisms;
  - exact monitoring/alerting configuration;
  - exact Safe deployment procedure;
  - exact Safe address publication mechanism;
  - exact signer rotation/replacement procedure;
  - exact withdrawal approval workflow;
  - exact reconciliation/refund policy;
  - exact legal review outcome.
- Safe creation MUST NOT proceed until all PENDING items are resolved.

---

## 12. FILES CREATED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_SIGNER_OPERATIONS_POLICY.md
- docs/reviews/implementation/AETERNA_SPEC_WP_21_SETTLEMENT_WALLET_SIGNER_OPERATIONS_REVIEW.md

---

FINAL CONFIRMATION:

"No Safe wallet was created. No signer addresses were generated or invented.
No private keys or seed phrases were requested or stored. No production code,
Cloudflare resources, payment integrations, crypto, storage, Vault, Manifest,
Seal, Trusted Time, Heartbeat, or legacy files were modified."
