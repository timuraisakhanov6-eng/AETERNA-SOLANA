# AETERNA — SPEC-WP-23 MVP Settlement Wallet Readiness Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review verifies the canonical MVP Settlement Wallet
0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755
for production readiness on Base Mainnet with native USDC.

This review does NOT create a wallet.
This review does NOT generate an address.
This review does NOT request or store private keys or seed phrases.
This review does NOT modify production code.
This review does NOT modify wrangler.toml.
This review does NOT create Cloudflare resources.
This review does NOT connect a payment provider.

---

## 2. PUBLIC ADDRESS VERIFICATION

Canonical address:
- 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755

Source:
- docs/canonical/AETERNA_MVP_SETTLEMENT_WALLET_SPEC.md

Verification:
- Address matches canonical spec exactly.
- Address is treated as the MVP Settlement Wallet recipient.
- No replacement or modification of the address is performed.

Status:
- RESOLVED

---

## 3. OWNERSHIP CHALLENGE PROTOCOL

Purpose:
- prove control of 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755 without
  revealing the private key.

Canonical challenge/response protocol:

Server generates:
- challengeId: unique one-time challenge identifier;
- nonce: random server-generated nonce;
- domain: explicit AETERNA Settlement Wallet ownership verification;
- purpose: canonical proof of address control for MVP Settlement Wallet;
- expiresAt: server-defined expiry;
- oneTimeUse: true.

Server binds:
- challengeId -> canonical address
- challengeId -> nonce
- challengeId -> domain
- challengeId -> purpose
- challengeId -> expiresAt
- challengeId -> oneTimeUse = true
- challengeId -> status = pending/used/expired

Server provides to user:
- challenge payload containing:
  - domain
  - purpose
  - nonce
  - expiresAt
  - canonical address
  - signing instruction

User action required:
- sign the canonical challenge payload with the hardware-backed wallet
  that controls 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755
- submit the signed response through an approved operational verification
  channel

Server verifies:
- signature is valid for the canonical address;
- challenge has not expired;
- challenge has not been used before;
- signed payload matches server-generated challenge exactly.

After successful verification:
- challenge status -> used;
- address ownership/control is confirmed for operational records.

Do NOT perform the real signature automatically in application code.
Do NOT request the private key or seed phrase.

Exact user action required before production activation:
- The authorized operator must sign the server-generated challenge with the
  hardware-backed wallet controlling 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755
  and return the signed response through the approved operational verification
  channel.

Status:
- RESOLVED at architectural level
- actual execution: operational action, PENDING

---

## 4. HARDWARE-BACKED CONTROL VERIFICATION

Acceptable evidence:
- successful signature of the ownership challenge using the hardware-backed
  wallet;
- operator confirmation that the private key for
  0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755 is stored in a hardware wallet
  or equivalent hardware-backed key storage and is NOT exported to software.

Unacceptable evidence:
- seed phrase disclosure;
- private key disclosure;
- exported JSON key file;
- screenshots containing secrets;
- any software-only key material.

The AETERNA application MUST NOT request, receive, or store:
- seed phrases;
- private keys;
- exported key files.

Status:
- RESOLVED at architectural level
- actual execution: operational action, PENDING

---

## 5. BASE MAINNET VERIFICATION

Chain identity:
- Base Mainnet is the selected initial production network for AETERNA
  Service Payment.

Network parameters:
- chain ID: 8453;
- EVM-compatible;
- native gas token: ETH;
- expected address format: 0x-prefixed 40 hex characters.

Requirements:
- The MVP Settlement Wallet address MUST be used only on Base Mainnet.
- The address MUST NOT be treated as canonical on any other network unless
  explicitly selected by future canonical decision.
- Network selection in production MUST enforce Base Mainnet.

Do NOT change network configuration in code in this phase.

Status:
- RESOLVED

---

## 6. NATIVE USDC VERIFICATION

Selected asset:
- native USDC on Base Mainnet.

Canonical source:
- USDC is issued by Circle;
- official authoritative source for USDC contract identities is Circle
  documentation at https://docs.circle.com/usdc-multichain or equivalent
  current official source.

Retrieval status:
- The exact official Base Mainnet native USDC contract identifier has NOT
  been retrieved from an authoritative current official source in this phase.
- The exact token contract address for Base Mainnet MUST be obtained from
  the official Circle documentation before payment verification code or quote
  binding uses a token contract identifier.

Required token identity for later payment verification adapter:
- network: Base Mainnet
- asset: USDC
- source: official Circle documentation
- status: PENDING retrieval

Do NOT invent or copy a token address from memory.
Do NOT use an unverified token address in production.

Status:
- asset selection: RESOLVED — native USDC
- exact official token identifier: PENDING

---

## 7. SERVICE QUOTE DEPENDENCY

Future immutable Service Quotes will bind:

- Creator Identity: bound Creator Identity identifier;
- selectedNetwork: Base Mainnet;
- selectedPaymentAsset: native USDC;
- exactAtomicAmount: exact amount in USDC atomic units, server-calculated;
- recipient: 0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755.

Quote rules:
- recipient is fixed to the MVP Settlement Wallet address while MVP EOA is
  canonical;
- after Safe migration, new Quotes bind the Safe recipient;
- historical Quotes remain bound to the MVP EOA;
- exactAtomicAmount is determined server-side, not by frontend.

Do NOT modify quote implementation in this phase.

Status:
- RESOLVED at architectural level

---

## 8. PRODUCTION READINESS CHECKLIST

| Item | Status |
|---|---|
| wallet ownership proof | PENDING — requires operator challenge/response |
| hardware-backed control | PENDING — requires challenge verification |
| Base Mainnet | RESOLVED |
| native USDC | RESOLVED — exact official token identifier PENDING |
| recipient declaration | RESOLVED |
| exact atomic amount | PENDING — requires price source/oracle |
| price conversion source | BLOCKED — not yet selected |
| RPC/provider | BLOCKED — not yet selected |
| finality | BLOCKED — not yet selected |
| evidence format | BLOCKED — not yet selected |
| reconciliation/refund policy | BLOCKED — not yet selected |

Blockers:
- price conversion source: BLOCKED
- RPC/provider: BLOCKED
- finality: BLOCKED
- evidence format: BLOCKED
- reconciliation/refund policy: BLOCKED

Prerequisites requiring operator action:
- wallet ownership proof via hardware-backed challenge/response
- hardware-backed control confirmation

---

## 9. VERDICT

SPEC-WP-23 = NOT READY

Reason:
- The canonical address is verified and preserved.
- Base Mainnet is resolved.
- native USDC is resolved as the selected asset.
- hardware-backed ownership challenge protocol is defined.
- However, production activation is blocked by:
  - unresolved operator ownership verification;
  - unresolved exact official Base Mainnet USDC token identifier;
  - unresolved price source/oracle;
  - unresolved RPC/provider;
  - unresolved finality threshold;
  - unresolved evidence format;
  - unresolved reconciliation/refund policy.

Wallet activation MUST NOT proceed until all blockers are resolved.

---

## 10. FILES CREATED

- docs/reviews/implementation/AETERNA_SPEC_WP_23_MVP_SETTLEMENT_WALLET_READINESS.md

---

FINAL CONFIRMATION:

"No wallet was created. No new address was generated. No private key or seed
phrase was requested or stored. No production code or Cloudflare configuration
was modified."
