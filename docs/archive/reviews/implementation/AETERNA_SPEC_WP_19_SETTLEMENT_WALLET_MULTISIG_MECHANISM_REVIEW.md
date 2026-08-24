# AETERNA — SPEC-WP-19 Settlement Wallet Multisig Mechanism Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review selects the concrete multisig mechanism for the future AETERNA
Settlement Wallet on Base Mainnet and verifies it satisfies the canonical
2-of-3 + hardware-backed + runtime-separation requirements.

This review does NOT create a wallet.
This review does NOT generate an address.
This review does NOT deploy a multisig.
This review does NOT connect hardware wallets.
This review does NOT connect a payment provider.
This review does NOT modify production code.
This review does NOT create Cloudflare resources.

---

## 2. SELECTED MECHANISM

Selected mechanism:
- Safe multisig on Base Mainnet.

Configuration:
- threshold: 2-of-3;
- signers: 3 independent hardware-backed signers;
- application runtime: NO private-key access, NO signing authority.

---

## 3. CANDIDATE EVALUATION

### 3.1 Safe Multisig

A. Base Mainnet support
- PASS: Safe is a widely deployed EVM multisig contract; Base Mainnet is
  EVM-compatible and Safe contracts are supported on Base.

B. 2-of-3 threshold support
- PASS: Safe natively supports configurable threshold; 2-of-3 is a standard
  and well-documented configuration.

C. Hardware-wallet signer support
- PASS: Safe owners can be accounts secured by Ledger, Trezor, or compatible
  hardware wallets; signing occurs on the hardware device.

D. Independent signer control
- PASS: each signer is an independent account; no single signer has
  unilateral control; threshold enforces multiple signer confirmation.

E. No private-key access from AETERNA runtime
- PASS: Safe contract is deployed on-chain; AETERNA runtime never holds
  signer private keys or executes Safe transactions.

F. Transaction proposal/confirmation workflow
- PASS: Safe provides standard proposal/confirmation/execution workflow;
  transaction requires 2-of-3 confirmations before execution.

G. Recovery/replacement of one signer
- PASS: Safe supports adding/removing signers via Safe transaction;
  remaining 2 signers can execute signer-replacement transaction.

H. Signer rotation
- PASS: Safe supports signer rotation through Safe transaction with threshold
  confirmation; rotation does not require application runtime changes.

I. Transaction auditability
- PASS: Safe transactions are on-chain and publicly auditable; Safe
  interface provides transaction history and confirmation tracking.

J. Recipient/address stability
- PASS: Safe address is stable once deployed; suitable as immutable Service
  Quote recipient after canonical declaration.

K. Compatibility with Base-native USDC
- PASS: Safe multisig is compatible with standard ERC-20 tokens including
  USDC on Base Mainnet; Safe can receive and hold USDC.

L. Operational complexity
- PASS/ACCEPTED: Safe is operationally complex but well-understood;
  complexity is accepted tradeoff for required security properties.

M. Suitability for small protocol receiving $1 payments
- PASS: Safe is suitable; operational overhead is justified by required
  security properties even for small-value recipient.

N. Security implications
- PASS: Safe provides strong security guarantees:
  - threshold enforcement on-chain;
  - no single point of failure;
  - hardware-backed signers;
  - runtime separation.

O. Future expansion
- PASS: Safe multisig can be replaced or upgraded through canonical decision
  if required; new Safe deployment requires explicit canonical selection.

Result:
- Safe multisig satisfies all canonical requirements for the Settlement
  Wallet mechanism.

---

## 4. APPLICATION RUNTIME SEPARATION

Confirmed:

AETERNA runtime
≠
Safe multisig signer keys

No private key may enter:
- Cloudflare Pages;
- Pages Functions;
- Workers;
- Durable Objects;
- KV;
- `.env`;
- source code.

The application only verifies incoming payments to the Safe address.

This separation is mandatory and preserved.

---

## 5. SETTLEMENT WALLET ADDRESS

Safe multisig provides a stable public address that can become:
- immutable Service Quote recipient
after wallet creation and canonical declaration.

Do NOT create the wallet or address now.

The Safe address becomes canonical only after:
1. Safe multisig mechanism selected — RESOLVED
2. Safe deployed on Base Mainnet
3. Safe address verified
4. Safe declared canonical Settlement Wallet
5. future immutable quotes bind Safe address as recipient

Until step 4 is complete, NO immutable quote MAY contain a real Safe address.

---

## 6. FAILURE / RECOVERY

### 6.1 One Signer Lost
- Remaining 2 signers can execute signer-replacement transaction via Safe.
- Payment receipt is unaffected; Safe address remains stable.
- Recovery requires canonical operational procedure, PENDING.

### 6.2 One Signer Compromised
- Remaining 2 signers can execute signer-removal transaction via Safe.
- New signer added with 2-of-3 confirmation.
- Safe address remains stable after rotation.
- Canonical rotation/replacement procedure remains PENDING.

### 6.3 One Signer Unavailable
- Remaining 2 signers can execute transactions requiring 2-of-3.
- If only 1 signer is available, transactions requiring 2-of-3 cannot be
  executed; operational recovery required.

### 6.4 Signer Rotation
- Safe supports signer rotation via Safe transaction.
- Rotation maintains 2-of-3 threshold.
- Safe address remains stable unless Safe is replaced entirely.

### 6.5 Multisig Recovery
- Safe provides on-chain governance for recovery.
- No single signer can recover alone.
- Exact recovery procedure is operational, PENDING.

### 6.6 Accidental Transaction
- 2-of-3 threshold provides defense against accidental single-signer
  transactions.
- If 2 signers confirm an incorrect transaction, it is valid on-chain;
  operational reconciliation required outside Creator Credit semantics.

### 6.7 Emergency Access
- Requires 2-of-3 signers; no single signer emergency override.
- Emergency response requires separate restricted role, PENDING.

---

## 7. PROVIDER SEPARATION

Safe multisig selection does NOT select:
- payment RPC/provider;
- price oracle;
- finality threshold;
- payment evidence format.

Those remain separate pending decisions.

---

## 8. VERDICT

SPEC-WP-19 = COMPLETE

Reason:
- One concrete mechanism is explicitly selected: Safe multisig on Base
  Mainnet.
- Safe multisig satisfies all canonical requirements:
  - 2-of-3 authorization;
  - hardware-backed signer support;
  - independent signer control;
  - no application-runtime signing authority;
  - Base Mainnet compatibility;
  - stable address for immutable quote recipient;
  - signer rotation/recovery supported;
  - auditability on-chain.
- Wallet creation remains pending.
- Provider/RPC/oracle/finality/evidence/reconciliation/legal decisions
  remain explicitly PENDING where unresolved.

---

## 9. FILES CREATED

- docs/canonical/AETERNA_SETTLEMENT_WALLET_MULTISIG_MECHANISM_SPEC.md

---

FINAL CONFIRMATION:

"No wallet was created. No multisig address was generated. No hardware
signer was connected. No payment provider was connected. No production code,
Cloudflare resources, crypto, storage, Vault, Manifest, Seal, Trusted Time,
Heartbeat, or legacy files were modified."
