# AETERNA — SPEC-WP-22 MVP Settlement Wallet Reuse Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review canonicalizes the existing public address
0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755
as the AETERNA MVP Settlement Wallet on Base Mainnet for native USDC service
payments.

This review does NOT create a wallet.
This review does NOT generate a new address.
This review does NOT request or store private keys or seed phrases.
This review does NOT modify production code.
This review does NOT modify wrangler.toml.
This review does NOT create Cloudflare resources.
This review does NOT connect a payment provider.

---

## 2. ADDRESS REUSE DECISION

Explicit canonical decision:
- reuse existing public address 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755
  as the AETERNA MVP Settlement Wallet.

Historical context:
- This address was previously documented as the legacy AETERNA Executor Hot
  address.
- The legacy Executor Hot role is historical and is NOT carried forward.
- The address is explicitly re-designated for the new canonical MVP
  Settlement Wallet role.

This is not a newly generated or invented address.

---

## 3. CANONICAL MVP MODEL

Public address:
- 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755

Network:
- Base Mainnet

Asset:
- native USDC on Base Mainnet

Service fee:
- USD 1.00 equivalent

Custody:
- temporary MVP custody: single hardware-backed EOA
- future target: Safe 2-of-3 multisig + hardware-backed signers

Application runtime:
- NO private-key access
- NO signing authority

Purpose:
- receive AETERNA Service Payments only

---

## 4. LEGACY ROLE TRANSITION

OLD ROLE:
- legacy AETERNA Executor Hot address
- legacy operational/publication/payment-related infrastructure

NEW MVP ROLE:
- AETERNA MVP Settlement Wallet
- receive AETERNA Service Payments only

Canonical record:
- The legacy Executor Hot authority is terminated.
- The address is reused with explicit project approval.
- Historical reports remain historical.
- No old migration reports are rewritten.

---

## 5. SERVICE PAYMENT BOUNDARY

Authorized:
- AETERNA Service Payment: USD 1.00 equivalent in native USDC on Base
  Mainnet.

Prohibited:
- Creator Identity;
- Creator Credit;
- Irys payment receiver;
- application signing key;
- automatic withdrawal authority;
- legacy Executor Hot operational/publication payment receiver.

---

## 6. TEMPORARY MVP CUSTODY

Current state:
- single hardware-backed EOA

Future target:
- Safe 2-of-3 multisig + hardware-backed signers

Canonical record:
- Safe 2-of-3 remains the production maturity target.
- single hardware-backed EOA is the approved temporary MVP custody model.
- This phase does NOT deploy Safe or migrate the address.

---

## 7. MIGRATION RULE

Future transition:

MVP EOA
-> Safe 2-of-3 created
-> Safe verified on Base
-> Safe becomes new canonical Settlement Wallet
-> new Service Quotes bind Safe recipient
-> old MVP EOA stops being canonical service-payment recipient

Quote preservation:
- Existing immutable Quotes bound to MVP EOA remain valid.
- New Quotes after Safe migration bind Safe recipient.
- Migration is a forward-looking canonical decision.
- No historical Quotes are rewritten.

---

## 8. WALLET VERIFICATION

Before production use, the following MUST be verified:

- [ ] address ownership/control by authorized operator
- [ ] hardware-backed signing capability
- [ ] Base Mainnet availability
- [ ] native USDC compatibility
- [ ] exact public address match
- [ ] no private key exposure to AETERNA runtime

Verification is operational, not application-side.
Do NOT request private keys.

---

## 9. SCALING BOUNDARY

The MVP EOA is not bounded by a normal wallet balance ceiling.

Future scaling requirements remain:
- blockchain/RPC ingestion;
- payment verification throughput;
- event indexing;
- quote/payment reconciliation;
- treasury balance management;
- withdrawal operations;
- Safe migration.

Do NOT implement scaling/treasury mechanisms in this phase.

---

## 10. CONSISTENCY WITH PRIOR SPECS

This decision is consistent with:
- SPEC-WP-17: 2-of-3 multisig + hardware-backed keys remains the production
  maturity target.
- SPEC-WP-18R: Base Mainnet + native USDC is the initial production route.
- SPEC-WP-19: Safe multisig is the selected mechanism for production maturity.
- SPEC-WP-20: Safe creation readiness prerequisites are preserved; Safe
  creation remains pending.
- SPEC-WP-21: Signer operations policy is preserved; Safe signer setup
  remains pending.

No contradictions with prior canonical selections.

---

## 11. REMAINING PENDING DECISIONS

The following remain PENDING:
- exact price source/oracle;
- exact confirmation/finality thresholds;
- exact payment provider/RPC/adapter;
- exact payment evidence formats;
- exact Cloudflare implementation details;
- exact reconciliation/refund policy;
- exact Safe migration timing/procedure;
- exact signer identities/entities;
- exact hardware wallet models/vendors;
- exact operational roles;
- exact monitoring/alerting configuration;
- legal review completion.

---

## 12. VERDICT

SPEC-WP-22 = COMPLETE

Reason:
- The existing public address 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755
  is explicitly canonicalized as the MVP Settlement Wallet.
- The historical Executor Hot relationship is clearly classified as
  historical/reassigned.
- Base Mainnet + native USDC is preserved.
- Safe 2-of-3 remains the production maturity target.
- Temporary single hardware-backed EOA is explicitly recorded.
- Application runtime separation is preserved.
- No contradictions with prior canonical selections.

---

## 13. FILES CREATED

- docs/canonical/AETERNA_MVP_SETTLEMENT_WALLET_SPEC.md
- docs/reviews/implementation/AETERNA_SPEC_WP_22_MVP_SETTLEMENT_WALLET_REUSE_REVIEW.md

---

FINAL CONFIRMATION:

"No wallet was created. No new address was generated. No private key or seed
phrase was requested or stored. Only canonical documentation was modified."
