# AETERNA — SPEC-WP-20 Safe Creation Readiness Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review documents the exact prerequisites required before creating the
AETERNA Settlement Wallet as a Safe multisig on Base Mainnet.

This review does NOT create a Safe.
This review does NOT generate signer addresses.
This review does NOT import seed phrases or private keys.
This review does NOT modify production code.
This review does NOT modify wrangler.toml.
This review does NOT create Cloudflare resources.
This review does NOT connect a payment provider.

---

## 2. SIGNER REQUIREMENTS

The three Safe multisig signer accounts MUST satisfy:

- exactly 3 independent signer accounts;
- each signer MUST be independently controlled;
- each signer MUST be independently hardware-backed;
- each signer MUST have separate private-key custody;
- no AETERNA runtime component MAY have access to any signer private key;
- no shared seed phrase or shared custody among signers;
- no single operator MAY control 2+ signer keys unilaterally unless an
  explicit operational policy is documented and approved.

Do NOT invent signer names, identities, or addresses.

Status:
- number of signers: RESOLVED — 3
- independence: RESOLVED
- hardware-backed: RESOLVED
- separate custody: RESOLVED
- no runtime access: RESOLVED
- no shared seed phrase: RESOLVED
- exact signer identities/entities: PENDING

---

## 3. HARDWARE REQUIREMENTS

Each signer MUST use a hardware wallet or equivalent hardware-backed key
storage mechanism.

Required properties:
- private key material MUST NEVER leave the hardware device;
- signing MUST occur on the hardware device;
- device MUST support the signing standard required by Safe on Base Mainnet;
- backup/recovery MUST be possible without exposing private keys to AETERNA
  runtime.

Accepted device classes:
- Ledger hardware wallets;
- Trezor hardware wallets;
- other hardware wallets compatible with Safe on EVM networks.

Status:
- device class requirement: RESOLVED — hardware-backed
- exact hardware wallet models/vendors: PENDING
- exact provisioning procedure: PENDING

---

## 4. OPERATIONAL SEPARATION

### 4.1 Hardware Device Separation

- each signer MUST use a distinct hardware device or distinct hardware-backed
  account;
- devices MUST be physically separate;
- devices MUST NOT be stored together in a single location unless explicitly
  documented as an approved operational policy;
- devices MUST be controlled by distinct operational identities where
  possible.

Status:
- physical separation requirement: RESOLVED
- exact device locations: PENDING
- exact operational identities: PENDING

### 4.2 Backup / Recovery

- each signer MUST have a backup/recovery path that does NOT require AETERNA
  runtime involvement;
- recovery MUST preserve the ability to execute Safe transactions with 2-of-3
  threshold after signer loss;
- recovery MUST NOT expose signer private keys to AETERNA runtime or
  unauthorized parties.

Status:
- backup/recovery requirement: RESOLVED
- exact recovery mechanism per signer: PENDING
- exact recovery procedure: PENDING

### 4.3 Physical Separation

- signer devices SHOULD be geographically or institutionally separate;
- physical separation MUST NOT prevent 2-of-3 threshold operations under
  normal conditions;
- physical separation is an operational decision, not an application
  requirement.

Status:
- physical separation principle: RESOLVED
- exact physical separation policy: PENDING

### 4.4 Operational Access

- access to each signer device MUST be restricted to authorized personnel or
  authorized infrastructure;
- operational access MUST be monitored;
- operational access MUST be auditable;
- AETERNA application runtime MUST NOT have operational access to signer
  devices.

Status:
- restricted access requirement: RESOLVED
- exact operational access policy: PENDING
- exact monitoring configuration: PENDING

### 4.5 Compromise Response

- if one signer device is compromised:
  - the compromised signer MUST be removed from Safe via Safe transaction;
  - a new signer MUST be added via Safe transaction;
  - the 2-of-3 threshold MUST be maintained;
  - AETERNA runtime MUST NOT be involved in signer removal/addition;
- if one signer is lost:
  - remaining 2 signers MAY execute signer-replacement transaction;
- compromise response MUST follow an approved operational procedure.

Status:
- compromise response principle: RESOLVED
- exact compromise response procedure: PENDING

### 4.6 Signer Replacement

- signer replacement MUST be executed via Safe transaction with 2-of-3
  confirmation;
- signer replacement MUST maintain 2-of-3 threshold;
- Safe address remains stable after signer replacement unless Safe is
  replaced entirely;
- replacement MUST follow an approved operational procedure.

Status:
- signer replacement principle: RESOLVED
- exact replacement procedure: PENDING

---

## 5. SAFE CREATION PREREQUISITES

Before Safe creation, the following MUST be true:

- network: Base Mainnet — RESOLVED
- threshold: 2 — RESOLVED
- owners: 3 signer addresses — PENDING addresses
- signer devices: provisioned and operational — PENDING
- signer identities: documented and approved — PENDING
- Safe deployment: executed by authorized operators — PENDING
- no AETERNA runtime involvement in creation — RESOLVED
- Safe address publication mechanism: defined — PENDING

The Safe creation itself is an operational action performed by authorized
operators using hardware wallets. AETERNA runtime MUST NOT create, configure,
or control the Safe.

---

## 6. ON-CHAIN VERIFICATION CHECKLIST

After Safe creation, the following checks MUST be performed before the Safe
address can be declared canonical:

- [ ] Safe contract exists on Base Mainnet at the published address
- [ ] Safe contract is the expected Safe multisig implementation
- [ ] Safe owner set contains exactly 3 distinct addresses
- [ ] Safe owner addresses are the intended 3 hardware-backed signer addresses
- [ ] Safe threshold is exactly 2
- [ ] No unexpected owner addresses are present
- [ ] No unexpected module, guard, or configuration is enabled
- [ ] Safe can receive native USDC on Base Mainnet
- [ ] Safe address is the intended Settlement Wallet recipient
- [ ] Safe address is recorded as the pending canonical recipient

These checks are verification steps, not implementation steps.
They MUST be performed after Safe creation and before canonical declaration.

Status:
- verification checklist: defined above
- verification execution: PENDING until Safe is created

---

## 7. ADDRESS LIFECYCLE

Canonical lifecycle for the Settlement Wallet address:

1. Safe multisig mechanism selected — RESOLVED
2. Safe created on Base Mainnet by authorized operators — PENDING
3. Safe address verified against checklist — PENDING
4. Safe declared canonical Settlement Wallet — PENDING
5. future immutable Service Quotes bind Safe address as recipient — PENDING
6. operational monitoring and control maintained — PENDING
7. rotation/replacement if required — PENDING

Rules:
- Until step 4 is complete, NO immutable quote MAY contain a real Safe
  address.
- Until step 4 is complete, NO production payment verification MAY be
  finalized.
- Address changes after step 4 MUST NOT retroactively alter already-issued
  quotes.
- New quotes after rotation MUST bind to the new canonical Settlement Wallet
  address.

---

## 8. NO APPLICATION SIGNING

The following MUST NEVER contain Safe signer private keys or seed phrases:

- Cloudflare Pages;
- Pages Functions;
- Workers;
- Durable Objects;
- KV;
- environment variables;
- source code;
- CI/CD systems;
- GitHub repositories;
- any other AETERNA runtime or development artifact.

The AETERNA application:
- does NOT hold Safe signer private keys;
- does NOT hold hardware wallet seed phrases;
- does NOT sign Safe transactions;
- does NOT configure Safe owners or threshold;
- only verifies incoming payments to the Safe address.

This separation is mandatory and non-negotiable.

---

## 9. UNRESOLVED OPERATIONAL DECISIONS

The following remain PENDING and MUST be resolved before Safe creation:

- exact hardware wallet models/vendors for 3 signers;
- exact signer identities/entities;
- exact operational roles and separation of duties for signers;
- exact physical separation policy for signer devices;
- exact backup/recovery mechanism per signer;
- exact monitoring/alerting configuration for Safe transactions;
- exact Safe deployment procedure;
- exact Safe address publication mechanism;
- exact signer rotation/replacement procedure;
- exact reconciliation/refund policy for misdirected or expired payments;
- exact legal review outcome for service entitlement in selected
  jurisdictions.

No Safe or address MAY be created until all PENDING items are resolved.

---

## 10. EXACT USER ACTIONS REQUIRED BEFORE SAFE CREATION

The following actions MUST be completed by authorized operators before Safe
creation:

1. Select and procure 3 hardware wallets of approved models.
2. Initialize each hardware wallet following vendor instructions.
3. Securely backup each hardware wallet recovery phrase/seed outside
   AETERNA runtime.
4. Document 3 signer identities/entities approved by AETERNA governance.
5. Define operational roles and separation of duties for signers.
6. Define physical separation policy for signer devices.
7. Define monitoring/alerting configuration for Safe transactions.
8. Define Safe deployment procedure.
9. Define Safe address publication mechanism.
10. Define signer rotation/replacement procedure.
11. Complete legal review for selected jurisdictions.
12. Complete reconciliation/refund policy for misdirected or expired
    payments.
13. Obtain explicit approval for Safe creation from authorized AETERNA
    governance.

These are operational actions, not application actions.
AETERNA runtime MUST NOT perform any of these actions.

---

## 11. VERDICT

SPEC-WP-20 = NOT READY

Reason:
- Safe multisig mechanism is selected — RESOLVED
- Base Mainnet is selected — RESOLVED
- 2-of-3 threshold is selected — RESOLVED
- hardware-backed signers are required — RESOLVED
- runtime separation is defined — RESOLVED
- address lifecycle is defined — RESOLVED
- verification checklist is defined — RESOLVED

However, the following remain PENDING:
- exact hardware wallet models/vendors;
- exact signer identities/entities;
- exact operational roles and separation of duties;
- exact physical separation policy;
- exact backup/recovery mechanism;
- exact monitoring/alerting configuration;
- exact Safe deployment procedure;
- exact Safe address publication mechanism;
- exact signer rotation/replacement procedure;
- exact reconciliation/refund policy;
- exact legal review outcome.

Because these operational prerequisites are unresolved, Safe creation MUST
NOT proceed.

---

## 12. FILES CREATED

- docs/reviews/implementation/AETERNA_SPEC_WP_20_SAFE_CREATION_READINESS.md

---

FINAL CONFIRMATION:

"No Safe wallet was created. No signer addresses were generated or invented.
No private keys or seed phrases were requested or stored. No production code,
Cloudflare resources, payment integrations, crypto, storage, Vault, Manifest,
Seal, Trusted Time, Heartbeat, or legacy files were modified."
