# AETERNA Infrastructure

Version: 1.0
Status: Canonical

---

# Purpose

This document defines the canonical infrastructure of the AETERNA protocol.

It specifies the responsibilities, authority boundaries, and interactions between protocol infrastructure components.

It does not redefine protocol behavior.

If any implementation conflicts with this document, the implementation must be corrected.

---

🌐 AETERNA Infrastructure

## 1. AETERNA_PROTOCOL_TREASURY_SAFE

Type: deferred / future treasury governance layer

Purpose

Future project treasury governance and fund custody.

Current stage status:
- Treasury Safe is NOT the active Web3 payment receiver;
- Treasury Safe is NOT required for current capsule publication.

Future use:
- After team/investor/governance requirements appear, Treasury Safe may be reintroduced as a separate governance/treasury layer.
- This must not change basic protocol invariants.

Does not
- does not accept user payments in the current stage;
- does not participate in Irys publication;
- does not perform encryption.

## 2. AETERNA_SIGNER_PRIMARY

Type: primary signer of the Treasury Safe

Purpose

The main controller of the Treasury Safe.

Performs
- confirms Safe operations;
- manages the Treasury;
- confirms transfers;
- changes Safe configuration.

Does not
- does not accept user payments;
- does not hold the treasury;
- does not pay for publications.

## 3. AETERNA_SIGNER_RECOVERY

Type: backup signer

Purpose

Recovery of control over the Treasury Safe.

Performs
- replacing the Primary signer;
- restoring access;
- confirming operations when needed.

Does not
- does not accept payments;
- does not hold funds;
- is not an Executor.

## 4. AETERNA_SOLANA_SERVICE_SETTLEMENT_ADDRESS

Type: AETERNA-owned public Solana service-payment recipient

Purpose

Receives the $1.00 USDC AETERNA Service Payment from creators on Solana Mainnet.

Public address:

`6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu`

Performs
- receives AETERNA service payments in approved payment assets on approved networks;
- validates that payments are associated with an immutable Creator Service Quote and a verified Creator Identity.

Does not
- is not the Irys payment receiver;
- is not a storage provider;
- does not determine publication cost;
- does not fund Irys publication;
- does not receive user secrets;
- does not receive encryption keys;
- does not receive plaintext data.

## 5. AETERNA_SETTLEMENT_WALLET

Type: AETERNA-owned service-payment recipient

Purpose

Receives the AETERNA service payment from creators on supported rails.

Current status:
- Base payment rail is frozen and reserved for future activation.
- Active canonical rail: supported Solana-compatible wallet.
- Active canonical settlement address: AETERNA_SOLANA_SERVICE_SETTLEMENT_ADDRESS.

Performs
- receives AETERNA service payments in approved payment assets on approved networks;
- validates that payments are associated with an immutable Creator Service Quote and a verified Creator Identity.

Does not
- is not the Irys payment receiver;
- is not a storage provider;
- does not determine publication cost;
- does not fund Irys publication;
- does not receive user secrets;
- does not receive encryption keys;
- does not receive plaintext data.

## 5. CREATOR_IDENTITY

Type: server-verifiable creator principal

Purpose

Maps one authenticated creator to one or more verified wallet/account controls across networks.

Performs
- issues challenge/nonce for wallet proof;
- verifies wallet signature/proof against claimed account and challenge;
- creates or retrieves a server-issued Creator Identity record;
- binds verified network accounts to that Creator Identity.

Active canonical Solana rail uses:
- Solana Wallet Standard;
- Sign In With Solana (SIWS)-compatible authentication model;
- Ed25519 signature verification.

Legacy/frozen Base rail uses:
- EIP-191 `personal_sign` or equivalent officially supported EVM signing method.

Does not
- is not a raw blockchain address;
- is not frontend wallet display;
- is not provider session state;
- does not perform payment verification;
- does not grant decryption capability.

## 6. CREATOR_CREDIT

Type: server-authoritative service entitlement

Purpose

Represents one verified AETERNA service payment as a reusable entitlement to attempt one successful capsule lifecycle.

Performs
- grants exactly one AVAILABLE Creator Credit after independent payment verification;
- binds Credit to an immutable Creator Identity;
- transitions Credit through AVAILABLE -> CONSUMING -> CONSUMED;
- restores Credit to AVAILABLE on failure before authoritative publication + Seal.

Does not
- is not storage pricing;
- is not Irys payment;
- is not gas;
- is not capsule-size pricing;
- does not expire.

## 🌍 External Services

### 7. Alchemy

Purpose

RPC provider for supported networks used in payment verification.

Used for:
- verifying on-chain transactions;
- retrieving blockchain data;
- checking confirmations;
- retrieving block information.

Does not:
- does not hold funds;
- does not accept payments;
- does not sign transactions.

### 8. Wallet Connection Abstraction

Purpose

Connecting user wallets for AETERNA service payment and identity proof.

Current active implementation:
- Supported Solana-compatible wallet for Solana Mainnet / native USDC.
- Base Mainnet / native USDC via minimal EIP-1193 browser provider is frozen and reserved for future activation.

Pending expansions:
- Additional wallet/provider adapters may be added only through explicit canonical selection.

Used for:
- Connect Wallet;
- retrieving the user's address;
- initiating transaction signing.

Does not:
- does not hold money;
- does not verify payment;
- does not know the Capsule price.

### 9. MetaMask

Purpose

The user's wallet, and wallets used by administrators.

Performs:
- storing private keys;
- signing transactions;
- sending approved service-payment assets;
- holding gas for on-chain operations.

Note: MetaMask-class EVM wallets remain supported for future Base reactivation.
Current canonical active rail is a supported Solana-compatible wallet.

### 10. ChainList

Purpose

Adding supported networks for the user.

Used only once.

Does not:
- does not participate in payment;
- does not interact with AETERNA.

## 💳 Payment Infrastructure

### 11. AETERNA Service Payment

Purpose

The $1 USD-equivalent AETERNA service payment that grants one Creator Credit.

Performs:
- creates immutable Creator Service Quote;
- verifies payment independently of client claims;
- grants Creator Credit to verified Creator Identity.

Does not:
- is not Irys publication payment;
- does not determine Irys cost;
- does not bundle storage pricing.

## 🗄 Storage

### 12. Irys

Purpose

Immutable storage backend for published encrypted Vault data.

Irys publication is a separate payment layer from the AETERNA service payment. The creator pays Irys through the supported Irys publication flow. Irys determines the actual publication/storage cost. AETERNA service payment does not automatically fund Irys publication.

Irys is not a payment receiver for AETERNA service payments.

### 13. Arweave

Purpose

Immutable long-term storage of the Capsule.

After publication, the data becomes permanent.

## 🖥 AETERNA Client (Browser-Side, User Environment)

Crypto Layer and Runtime Layer are client-side protocol layers. They execute entirely inside the user's browser/local environment and are never hosted, executed, or accessible on the server. This is a protocol identity invariant (see AI/AI_CONSTITUTION.md Art. 6–7) and is not an infrastructure implementation detail that may be relocated.

### Crypto Layer

Performs:
- generating the Secret;
- PBKDF2;
- AES-256-GCM;
- Vault;
- SHA-256;
- canonical serialization.

Does not know:
- price;
- payment;
- publication;
- the user.

Executes exclusively in the browser. The server never receives the Secret, plaintext, or decryption capability.

### Runtime Layer

Performs:
- Prepare;
- Preview;
- Upload;
- Open;
- Heartbeat.

Does not know:
- the commercial model;
- publication;
- Treasury Safe operation; Treasury Safe is deferred/future governance infrastructure and is not part of the current runtime payment/publication flow.

Executes exclusively in the user's local environment. The server is not a Runtime host.

## ⚙ AETERNA Server

The server boundary hosts only Business Layer and Storage Layer. It never hosts cryptography or Runtime execution.

### Business Layer

Creates:
- Creator Service Quote.

Issues (operational, non-authoritative):
- Upload Token.

Performs:
- creating the Creator Service Quote;
- verifying payment independently against the immutable quote;
- issuing Upload Token;
- controlling the publication lifecycle.

Does not know:
- how encryption works;
- how the Vault is published;
- how Arweave works;
- how Irys publication is funded.

## Storage Layer

Receives:
- Upload Token.

Performs:
- publishing the Vault via Storage Authority;
- receiving vaultTxId;
- publishing chunks and recording their locations in the Chunk Pointer Registry (the sole canonical chunk-to-storage-pointer mapping surface; see AI/07_PROJECT_GLOSSARY.md and AETERNA_COMPLETE_SYSTEM_LOGIC.md);
- creating Storage Authority;
- passing the result to Seal.

Does not know:
- how the user paid;
- how much the AETERNA service fee was;
- who owns the wallet or account;
- how Irys publication is funded.

## 🔐 Full Architecture

```
                     User
                            │
            ┌───────────────┴───────────────┐
            │                               │
       Wallet/account                Wallet/account
            │                               │
            ▼                               ▼
   Creator Identity proof          Irys publication flow
            │                               │
            ▼                               ▼
   AETERNA Service Payment         Irys publication payment
   (Settlement Wallet)             (separate layer)
            │                               │
            ▼                               ▼
   Creator Service Quote           Irys determines cost
            │                               │
            ▼                               ▼
   Payment Verified                Publication executed
            │                               │
            ▼                               ▼
   Creator Credit AVAILABLE        Storage Authority
            │                               │
            ▼                               ▼
   Capsule Lifecycle               Manifest Authority
```

## 🏦 Final Role Map

| Component | Primary role |
|---|---|
| AETERNA_PROTOCOL_TREASURY_SAFE | Deferred/future governance treasury layer; not current Web3 payment receiver |
| AETERNA_SIGNER_PRIMARY | Primary controller of the Treasury Safe |
| AETERNA_SIGNER_RECOVERY | Backup controller of the Treasury Safe |
| AETERNA_SETTLEMENT_WALLET | AETERNA-owned recipient for $1 service payments; grants Creator Credit via verified quote |
| CREATOR_IDENTITY | Server-verifiable creator principal; not raw address or provider session |
| CREATOR_CREDIT | Server-authoritative entitlement for one capsule lifecycle; bound to Creator Identity |
| AETERNA_EXECUTOR_HOT | PENDING selection; publication execution component; not canonical AETERNA service-payment receiver or Irys funder |
| Alchemy | Access to supported blockchains and transaction verification |
| Minimal EIP-1193 browser provider | Base Mainnet / native USDC wallet connect and signing; currently frozen/reserved |
| MetaMask | Storing keys and signing transactions |
| ChainList | Adding supported networks for the user |
| Irys | Publishing the encrypted Vault; separate publication/storage payment layer |
| Arweave | Immutable long-term storage of the Capsule |
| Business Layer | Creator Service Quote → payment verification → Upload Token |
| Storage Layer | Upload Token → Storage Authority → Manifest Authority |
| Seal | Storage Authority → Manifest Authority |

## Architectural Principles

- The Creator Service Quote is created before payment begins and is the sole commercial source of truth; it is not replaced or superseded by any post-verification authority object.
- Payment verification confirms successful payment against the Creator Service Quote, independently of client claims, and does not create a separate authority object.
- One verified AETERNA service payment creates at most one Creator Credit.
- Creator Credit is bound to one Creator Identity and may authorize only one active capsule lifecycle while CONSUMING.
- Upload Token is issued only after successful payment verification and required business authority conditions.
- The Storage Layer begins publication only after receiving Upload Token.
- Irys publication payment is separate from the AETERNA service payment. AETERNA service payment does not automatically fund Irys.
- Storage Authority confirms successful publication of the Vault.
- Manifest Authority is created only after a successful Seal and becomes the permanent source of truth for the Capsule's sealed identity, integrity, and Vault discovery. Per-object chunk-location resolution is a separate concern governed by Storage Authority via the Chunk Pointer Registry, not by the Manifest.
- Crypto Layer, Business Layer, Storage Layer, and Runtime Layer are fully isolated from one another and have independent areas of responsibility.
- Each layer creates only its own Authority and has no right to modify the Authority of another layer.

## Authority Sequence in the Capsule Lifecycle

Upload Token is an operational capability, not a protocol Authority, and is therefore not part of the Authority chain below (see AI/07_PROJECT_GLOSSARY.md).

```
Commercial Authority
(Creator Service Quote)
          ↓
      [Payment Verification — validates Creator Service Quote, not a separate Authority]
          ↓
      [Creator Credit — server-authoritative entitlement]
          ↓
      [Upload Token — operational, non-authoritative]
          ↓
Storage Authority
(via Chunk Pointer Registry)
          ↓
Manifest Authority
```

## Creator Identity and Credit Model

Current canonical creator model:

Creator Identity
→ immutable Creator Service Quote
→ $1 USD-equivalent AETERNA service payment
→ independently verified payment
→ Creator Credit AVAILABLE
→ later capsule lifecycle reservation
→ Credit CONSUMING
→ separate Irys publication/payment
→ authoritative publication verification
→ authoritative Seal verification
→ Credit CONSUMED

Hard rules:
- $1 USD = 1 Creator Credit.
- Creator Credit does not expire.
- Creator Credit is not storage pricing, Irys payment, gas, or capsule-size pricing.
- One verified AETERNA service payment -> maximum one Creator Credit.
- Duplicate payment verification -> no duplicate Credit.
- Credit belongs to Creator Identity.
- One Credit cannot authorize two active capsule lifecycles.
- Credit is consumed only after authoritative publication AND authoritative Seal.
- Failure before final success preserves/restores Credit according to canonical recovery rules.
- Frontend is never authority.

AETERNA service payment and Irys publication payment are independent layers.

Historical note: legacy Paddle/bank-card and legacy Base/USDC web3 paths remain preserved for backward compatibility but are not part of the current canonical authority chain.