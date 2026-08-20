# AETERNA — Settlement Wallet Multisig Mechanism Selection Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md

---

## 1. SELECTED MECHANISM

SELECTED CANONICAL MECHANISM
- Safe multisig on Base Mainnet.

This mechanism implements:
- 2-of-3 authorization threshold;
- hardware-backed signer keys;
- no application-runtime signing authority.

---

## 2. WHY IT SATISFIES 2-OF-3

Safe multisig natively implements:
- configurable threshold signatures;
- 2-of-3 is a standard Safe configuration;
- transaction requires confirmation by at least 2 of 3 authorized signers;
- no single signer can unilaterally move funds or change configuration;
- transaction submission and confirmation are explicit operational actions.

This satisfies the canonical requirement:
- no unilateral creator control;
- no unilateral contractor/third-party signing;
- withdrawal separation of duties.

---

## 3. HARDWARE SIGNER COMPATIBIBILITY

Safe multisig supports:
- hardware-backed signer keys via Ledger, Trezor, or compatible hardware
  wallets;
- each signer can be a distinct hardware wallet or an account secured by a
  hardware wallet;
- hardware-backed keys remain outside AETERNA runtime;
- signing operations occur on the hardware wallet devices, not in application
  code.

This satisfies:
- private-key isolation from application runtime;
- restricted operational access;
- compromise containment.

---

## 4. BASE COMPATIBILITY

Safe multisig is:
- deployed as a smart contract on EVM networks including Base Mainnet;
- Base Mainnet is the selected initial production network for AETERNA
  Service Payment;
- Safe multisig contract is compatible with native USDC and standard ERC-20
  tokens on Base Mainnet;
- Safe multisig address is a standard EVM address that can serve as the
  immutable Service Quote recipient.

This satisfies:
- Base Mainnet support;
- recipient/address stability;
- compatibility with Base-native USDC.

---

## 5. RUNTIME SEPARATION

AETERNA runtime
≠
Safe multisig signer keys

The AETERNA application:
- does NOT hold Safe multisig signer keys;
- does NOT hold hardware wallet private keys;
- does NOT sign Safe transactions;
- does NOT configure Safe owners/thresholds;
- only verifies incoming payments to the Safe address.

Safe multisig signer keys must NOT be placed in:
- Cloudflare Pages;
- Pages Functions;
- Workers;
- Durable Objects;
- KV;
- `.env`;
- source code.

Signing authority is exercised only by authorized operational infrastructure
through hardware wallets outside the AETERNA runtime.

---

## 6. ADDRESS LIFECYCLE

Canonical lifecycle:
1. Safe multisig mechanism selected
2. Safe multisig deployed on Base Mainnet
3. Safe address verified
4. Safe declared canonical Settlement Wallet
5. future immutable Service Quotes bind Safe address as recipient
6. operational monitoring and control maintained
7. rotation/replacement if required

Rules:
- Until step 4 is complete, NO immutable quote MAY contain a real
  Settlement Wallet address.
- Until step 4 is complete, NO production payment verification MAY be
  finalized.
- Address changes after step 4 MUST NOT retroactively alter already-issued
  quotes.
- New quotes after rotation MUST bind to the new canonical Settlement Wallet
  address.

The Safe address is network-specific:
- one Safe address on Base Mainnet for the initial production route;
- future Safe addresses on other networks require separate canonical
  selection.

---

## 7. SIGNER LIFECYCLE

Canonical signer lifecycle:
1. 3 signer identities established with hardware-backed keys
2. 2-of-3 threshold configured in Safe multisig
3. Safe deployed with signers and threshold
4. signers maintained under operational control
5. signer rotation if required

Rules:
- Exactly 3 authorized signers at minimum for 2-of-3 operation.
- At least 2 signers must remain operational for withdrawals.
- One lost or unavailable signer does not block receipt of payments.
- One compromised signer must be rotated; remaining 2 signers can approve
  rotation transaction.
- Signer replacement MUST maintain 2-of-3 threshold.
- AETERNA runtime has NO visibility into signer identities or keys.

---

## 8. RECOVERY / ROTATION

Safe multisig supports:
- adding/removing signers via Safe transaction with threshold confirmation;
- rotating one signer while maintaining 2-of-3 threshold;
- emergency signer replacement if one signer is lost or compromised;
- transaction execution via Safe transaction interface requiring 2-of-3
  confirmations.

Recovery rules:
- one signer lost: remaining 2 signers can execute signer-replacement
  transaction;
- one signer compromised: remaining 2 signers can execute signer-removal
  transaction; new signer added with 2-of-3 confirmation;
- accidental transaction: 2-of-3 threshold provides defense; if 2 signers
  confirm, transaction is valid; operational reconciliation outside Creator
  Credit semantics;
- emergency access: requires 2-of-3 signers; no single signer emergency
  override.

These are architectural capabilities, not operational procedures.
Exact operational procedures remain PENDING.

---

## 9. OPERATIONAL CONSTRAINTS

Mandatory constraints:
- Safe contract must be deployed on Base Mainnet;
- Safe owners must be controlled by hardware-backed keys outside AETERNA
  runtime;
- Safe threshold must remain 2-of-3;
- Safe transaction confirmations must be executed by authorized signers only;
- AETERNA runtime must never hold signer keys or execute Safe transactions;
- Safe address must be verified before becoming immutable Quote recipient;
- Safe address must be declared canonical before production payment
  verification is finalized.

Operational constraints:
- Safe deployment and configuration are operational actions, not application
  actions;
- signer key provisioning is operational action;
- Safe address publication is operational action;
- monitoring of Safe transactions is operational responsibility.

---

## 10. REMAINING PENDING DECISIONS BEFORE WALLET CREATION

The following MUST be resolved before Safe multisig deployment:

- exact hardware wallet models/vendors for 3 signers;
- exact signer identities/entities;
- exact operational roles and separation of duties for signers;
- exact monitoring/alerting configuration for Safe transactions;
- exact Safe deployment procedure;
- exact Safe address publication mechanism;
- exact rotation/replacement procedure for signers;
- exact reconciliation/refund policy;
- exact legal review outcome.

No wallet or address may be created until these are resolved.

---

## 11. PAYMENT-PROVIDER SEPARATION

Safe multisig selection does NOT select:
- payment RPC/provider;
- price oracle;
- finality threshold;
- payment evidence format.

Those remain separate pending decisions.

---

## 12. SECURITY MODEL

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
- one compromised hardware signer is insufficient for unilateral withdrawal.

---

## 13. DECISION SUMMARY

Exact architectural decisions made:
- AETERNA service payment and Irys publication are separate layers.
- Payment authority chain is: Creator Identity -> immutable quote -> server
  verification -> Creator Credit.
- USD 1.00 is fixed; exact atomic amount is determined server-side.
- Server verifies recipient, asset, network, amount, quote, identity,
  finality, replay, and duplicate credit before granting credit.
- Payment-to-credit transition is atomic and server-side.
- Creator Credit is bound to Creator Identity, not raw address.
- Wallet/account/network/provider switching aborts active lifecycle and
  cannot transfer credit.
- Provider architecture MUST remain provider-neutral.
- Settlement Wallet MUST exist before production payment verification.
- Settlement Wallet custody: 2-of-3 multisig with hardware-backed keys.
- Settlement Wallet mechanism: Safe multisig on Base Mainnet.
- Application runtime MUST NOT hold Settlement Wallet private keys or sign
  Safe transactions.
- All failures are fail-closed; no uncertain payment may grant credit.

Pending decisions:
- exact hardware wallet models/vendors for 3 signers;
- exact signer identities/entities;
- exact operational roles and separation of duties;
- exact Safe deployment procedure;
- exact Safe address publication mechanism;
- exact signer rotation/replacement procedure;
- exact price source/oracle;
- exact confirmation/finality thresholds;
- exact payment evidence formats per network;
- exact Cloudflare implementation details;
- exact reconciliation/refund policy;
- legal review completion.

---

## 14. REFERENCES

- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md
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
