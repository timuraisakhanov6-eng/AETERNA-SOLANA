# AETERNA — MVP Settlement Wallet Specification

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

## 1. MVP SETTLEMENT WALLET IDENTITY

Public address:
- 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755

Network:
- Base Mainnet

Asset:
- native USDC on Base Mainnet

Purpose:
- receive AETERNA Service Payments only

Historical note:
- This address was previously documented as the legacy AETERNA Executor Hot
  address.
- This existing public address is intentionally re-designated by explicit
  project decision as the temporary MVP Settlement Wallet.
- This reuse does NOT imply the former Executor Hot authority continues.
- The historical role is preserved in prior documents; this document records
  the new role.

---

## 2. ADDRESS REUSE DECISION

This is an explicit canonical decision to reuse an existing public address.

Do NOT treat this as:
- a newly created address;
- a generated address;
- an invented address.

The address is reused as-is with the new MVP Settlement Wallet role.

---

## 3. SERVICE PAYMENT BOUNDARY

This address is authorized to receive:

- AETERNA Service Payment: USD 1.00 equivalent in native USDC on Base Mainnet.

This address MUST NOT be used as:
- Creator Identity;
- Creator Credit;
- Irys payment receiver;
- application signing key;
- automatic withdrawal authority;
- operational/publication payment receiver under the legacy Executor Hot
  model.

---

## 4. TEMPORARY MVP CUSTODY MODEL

Current custody:
- single hardware-backed EOA at 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755

This means:
- one hardware-backed signer controls the address today;
- no Safe multisig is deployed yet;
- no additional signers are configured;
- withdrawal/recovery options are limited to the current single-key control.

Future target:
- Safe 2-of-3 multisig with hardware-backed signers remains the production
  maturity target.
- The future Safe migration is NOT performed in this phase.
- This document does not change the existing canonical Safe selection.

Explicit record:
- Safe 2-of-3 remains the production maturity target;
- single hardware-backed EOA is the approved temporary MVP custody model.

---

## 5. MIGRATION RULE

Future transition:

MVP EOA
-> Safe 2-of-3 created on Base Mainnet
-> Safe verified
-> Safe becomes new canonical Settlement Wallet
-> new Service Quotes bind Safe recipient
-> old MVP EOA stops being canonical service-payment recipient

Rules:
- Existing immutable Quotes issued before migration remain bound to the MVP
  EOA recipient for their lifetime.
- New Quotes issued after Safe declaration bind the Safe recipient.
- The migration MUST be an explicit canonical decision when executed.
- The migration MUST NOT retroactively alter historical Quotes.

Status:
- MVP EOA: current canonical recipient
- Safe migration: future canonical decision, PENDING

---

## 6. APPLICATION RUNTIME SEPARATION

AETERNA runtime
≠
MVP Settlement Wallet private-key custody

The AETERNA application:
- does NOT hold the private key for 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755;
- does NOT sign transactions from this address;
- does NOT configure or control the address;
- only verifies incoming payments to this address.

The private key for this address must NOT be placed in:
- Cloudflare Pages;
- Pages Functions;
- Workers;
- Durable Objects;
- KV;
- `.env`;
- source code;
- CI/CD;
- GitHub.

This separation remains mandatory even under the temporary MVP custody model.

---

## 7. LEGACY ROLE TRANSITION

OLD ROLE:
- legacy AETERNA Executor Hot address

OLD FUNCTION:
- legacy operational/publication/payment-related infrastructure as described
  by historical/current documents.

NEW MVP ROLE:
- AETERNA MVP Settlement Wallet

NEW FUNCTION:
- receive AETERNA Service Payments only

The reuse decision is explicit and intentional.
Legacy operational authority from the Executor Hot role is NOT transferred.
Only the new canonical MVP Settlement Wallet role applies going forward.

---

## 8. WALLET VERIFICATION REQUIREMENTS

Before production use of this address as the MVP Settlement Wallet, the
following MUST be verified:

- [ ] address ownership/control is confirmed by the authorized operator;
- [ ] signing capability is hardware-backed;
- [ ] address exists on Base Mainnet;
- [ ] address can receive native USDC on Base Mainnet;
- [ ] exact public address matches 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755;
- [ ] private key is not exposed to AETERNA runtime.

Do NOT request the private key or seed phrase for verification.
Verification is an operational action, not an application action.

---

## 9. IMMUTABLE QUOTE RULES

Immutable Quote recipient:
- 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755

Rules:
- This recipient is fixed for Quotes issued while the MVP EOA is canonical.
- After Safe migration, new Quotes bind the Safe recipient.
- Historical Quotes remain bound to the MVP EOA.
- Quotes MUST NOT be retroactively rewritten.

---

## 10. SCALING / TREASURY BOUNDARY

The MVP EOA is not bounded by a normal wallet balance ceiling.

Scaling concerns remain for future operational maturity:
- blockchain/RPC ingestion;
- payment verification throughput;
- event indexing;
- quote/payment reconciliation;
- treasury balance management;
- withdrawal operations;
- Safe migration.

Future treasury sweep / Safe migration remains a scaling requirement.
Do NOT implement those in this phase.

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
- MVP Settlement Wallet private key MUST be isolated from application runtime;
- MVP Settlement Wallet compromise MUST NOT compromise Creator Credit
  authority or capsule contents;
- temporary single hardware-backed EOA is a transitional state, not the
  production maturity target.

---

## 12. DECISION SUMMARY

Exact decisions made:
- MVP Settlement Wallet public address: 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755
- Network: Base Mainnet
- Asset: native USDC
- Service fee: USD 1.00
- Temporary custody: single hardware-backed EOA
- Future custody target: Safe 2-of-3 multisig + hardware-backed signers
- Legacy Executor Hot role terminated; address reused for new canonical role.
- Application runtime MUST NOT hold private key or sign transactions.
- Irys payment remains separate.
- Provider/RPC/oracle/finality/evidence/reconciliation/legal decisions
  remain PENDING.

Pending decisions:
- exact price source/oracle;
- exact confirmation/finality thresholds;
- exact payment provider/RPC/adapter;
- exact payment evidence formats;
- exact Cloudflare implementation details;
- exact reconciliation/refund policy;
- exact Safe migration timing/procedure;
- legal review completion.

---

## 13. REFERENCES

- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_AND_PAYMENT_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_DECISION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_MULTISIG_MECHANISM_SPEC.md
- AETERNA_SETTLEMENT_WALLET_SIGNER_OPERATIONS_POLICY.md
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
