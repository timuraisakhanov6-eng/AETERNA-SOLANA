# AETERNA — Settlement Wallet Signer Operations Policy

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_MULTISIG_MECHANISM_SPEC.md
- AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md

---

## 1. SIGNER MODEL

The AETERNA Settlement Wallet Safe multisig uses exactly 3 independent
signers configured with a 2-of-3 threshold.

Signer labels:
- Signer A
- Signer B
- Signer C

Each signer:
- is an independent account;
- is independently controlled;
- is independently hardware-backed;
- has separate private-key custody;
- has NO access granted to any AETERNA runtime component;
- has NO shared seed phrase with any other signer;
- is NOT controlled by a single operator unless an explicit operational
  policy is documented and approved.

Canonical rule:
- no single operator MAY unilaterally control 2 or more signers unless an
  explicit operational policy is documented, approved, and recorded in
  canonical specifications.

Status:
- number of signers: RESOLVED — 3
- independence: RESOLVED
- hardware-backed: RESOLVED
- separate custody: RESOLVED
- no runtime access: RESOLVED
- no shared seed phrase: RESOLVED
- exact signer identities/entities: PENDING

---

## 2. ROLE SEPARATION

Generic roles:

- Signer: authorized to sign Safe transactions using a hardware-backed
  device;
- Transaction proposer: authorized to propose Safe transactions;
- Transaction confirmer: authorized to confirm Safe transactions;
- Emergency/recovery authority: authorized to execute emergency or recovery
  procedures.

Role combination rules:

- A single operator MAY hold multiple roles ONLY if explicitly documented
  and approved by a separate operational policy;
- In the absence of an approved operational policy, the following
  separations MUST be observed:
  - Signer A, Signer B, and Signer C are independent;
  - Transaction proposer and transaction confirmer SHOULD be separated;
  - Emergency/recovery authority MUST be separate from normal operational
    signers unless explicitly documented and approved.

Status:
- role separation principle: RESOLVED
- exact role assignments to signers: PENDING
- exact approval workflow for role combinations: PENDING

---

## 3. HARDWARE POLICY

Requirements:

- each signer MUST use a hardware wallet or equivalent hardware-backed key
  storage mechanism;
- private key material MUST NEVER leave the hardware device;
- signing MUST occur on the hardware device;
- device MUST support the signing standard required by Safe on Base Mainnet;
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
- device class requirement: RESOLVED — hardware-backed
- exact hardware wallet models/vendors: PENDING
- exact provisioning procedure: PENDING

---

## 4. PHYSICAL SEPARATION

Principle:

- The three signer controls SHOULD be physically separated so that one
  incident does not compromise multiple signers.

Requirements:
- signer devices MUST be stored in separate locations unless explicitly
  documented as an approved operational policy;
- physical separation MUST NOT prevent 2-of-3 threshold operations under
  normal conditions;
- physical separation is an operational decision, not an application
  requirement.

Status:
- physical separation principle: RESOLVED
- exact physical separation policy: PENDING
- exact storage locations: PENDING

---

## 5. LOSS / COMPROMISE

### 5.1 One Signer Lost

Outcome:
- Safe remains operable with 2 remaining signers;
- signer replacement is required to restore 3-of-3 operational capacity;
- remaining 2 signers can execute signer-replacement transaction via Safe.

### 5.2 One Signer Device Destroyed

Outcome:
- Safe remains operable with 2 remaining signers;
- signer replacement is required;
- remaining 2 signers can execute signer-replacement transaction via Safe;
- recovery of the destroyed device is not required for Safe operation.

### 5.3 One Signer Compromised

Outcome:
- Safe remains operable with 2 remaining signers;
- compromised signer MUST be removed from Safe via Safe transaction;
- new signer MUST be added via Safe transaction with 2-of-3 confirmation;
- 2-of-3 threshold MUST be maintained;
- AETERNA runtime MUST NOT be involved in signer removal/addition.

### 5.4 One Signer Unavailable

Outcome:
- Safe remains operable with 2 remaining signers;
- transactions requiring 2-of-3 can still be executed;
- if only 1 signer is available, transactions requiring 2-of-3 cannot be
  executed; operational recovery required.

### 5.5 Two Signers Unavailable

Outcome:
- Safe is NOT operable for new transactions;
- emergency recovery procedure is required;
- exact emergency procedure is PENDING.

### 5.6 Suspected Multisig Compromise

Outcome:
- Safe MUST be treated as compromised;
- emergency recovery procedure is required;
- exact emergency procedure is PENDING;
- AETERNA runtime MUST NOT attempt to resolve compromise autonomously.

Status:
- loss/compromise outcomes: RESOLVED
- exact emergency/recovery procedures: PENDING

---

## 6. SIGNER ROTATION

When permitted:
- signer rotation is permitted when required for loss, compromise, or
  operational policy;
- signer rotation MUST be executed via Safe transaction with 2-of-3
  confirmation;
- signer rotation MUST maintain 2-of-3 threshold.

Address stability:
- Safe address remains stable when signers rotate;
- Safe address changes ONLY if the Safe itself is replaced entirely.

Quote impact:
- existing immutable Service Quotes remain bound to the original Safe
  address;
- new quotes after rotation bind to the same Safe address unless Safe is
  replaced;
- if Safe is replaced, new quotes bind to the new Safe address; old quotes
  remain bound to the old address.

Status:
- signer rotation principle: RESOLVED
- exact rotation procedure: PENDING

---

## 7. WITHDRAWAL POLICY

Separation of operations:

- Receiving service payments: automated; no special authority required;
- Monitoring: operational team or automated alerting;
- Proposing withdrawal: restricted role;
- Approving withdrawal: separate restricted role;
- Executing withdrawal: requires 2-of-3 signer confirmations.

Rules:
- AETERNA application runtime MUST NOT perform automatic withdrawals;
- Withdrawal from the Settlement Wallet MUST be an explicit operational
  action;
- Withdrawal MUST require 2-of-3 signer confirmations via Safe;
- Withdrawal MUST follow approved operational procedures.

Status:
- withdrawal separation principle: RESOLVED
- exact operational roles for withdrawal: PENDING
- exact approval workflow: PENDING

---

## 8. MONITORING

Required monitoring categories:

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
- monitoring data MUST be auditable;
- exact monitoring service and configuration: PENDING.

Status:
- monitoring categories: RESOLVED
- exact monitoring service/configuration: PENDING

---

## 9. WALLET CREATION CHECKLIST

Prerequisites before Safe creation:

- [ ] three approved signer controls — PENDING
- [ ] hardware-backed devices available — PENDING
- [ ] signer independence confirmed — PENDING
- [ ] backup/recovery prepared — PENDING
- [ ] operational policy approved — PENDING
- [ ] Base Mainnet selected — RESOLVED
- [ ] Safe 2-of-3 selected — RESOLVED

No Safe or address MAY be created until all checklist items are resolved.

---

## 10. UNRESOLVED OPERATIONAL / LEGAL DECISIONS

PENDING CANONICAL DECISION
- exact hardware wallet models/vendors for 3 signers;
- exact signer identities/entities;
- exact operational roles and separation of duties;
- exact physical separation policy for signer devices;
- exact backup/recovery mechanism per signer;
- exact monitoring/alerting configuration for Safe transactions;
- exact Safe deployment procedure;
- exact Safe address publication mechanism;
- exact signer rotation/replacement procedure;
- exact withdrawal approval workflow;
- exact reconciliation/refund policy for misdirected or expired payments;
- exact legal review outcome for service entitlement in selected
  jurisdictions.

No implementation MAY create the Safe or select a payment provider until all
PENDING items are resolved and documented in canonical specifications.

---

## 11. SECURITY MODEL

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
- Settlement Wallet private keys MUST be isolated from application runtime;
- Settlement Wallet compromise MUST NOT compromise Creator Credit
  authority or capsule contents;
- Safe multisig enforces 2-of-3 threshold for all withdrawal operations;
- one compromised hardware signer is insufficient for unilateral withdrawal;
- AETERNA runtime MUST NOT hold Safe signer private keys or seed phrases;
- AETERNA runtime MUST NOT sign Safe transactions.

---

## 12. DECISION SUMMARY

Exact operational decisions made:
- three independent hardware-backed signers for Safe multisig;
- 2-of-3 threshold for Safe transactions;
- no shared seed phrase among signers;
- no application-runtime custody of signer keys;
- signer devices must be physically separate;
- one signer loss/compromise/unavailability does not prevent Safe operation;
- two signers unavailable prevents Safe operation;
- signer rotation preserves Safe address;
- withdrawal requires explicit operational action and 2-of-3 confirmation;
- AETERNA runtime MUST NOT perform automatic withdrawals;
- monitoring required for Safe transactions and configuration changes.

Pending operational decisions:
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

---

## 13. REFERENCES

- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_MULTISIG_MECHANISM_SPEC.md
- AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md
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
