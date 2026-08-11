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
- Treasury Safe does NOT participate in the current funding flow for Executor Hot;
- Treasury Safe is NOT required for current capsule publication.

Future use:
- After team/investor/governance requirements appear, Treasury Safe may be reintroduced as a separate governance/treasury layer.
- This must not change basic protocol invariants.

Does not
- does not accept user payments in the current stage;
- does not fund Executor Hot in the current stage;
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

## 4. AETERNA_EXECUTOR_HOT

Type: hot working wallet + current Web3 payment receiver + Publication Authority

Public address
0xb0d9E5d93c1fecFA78479F23d283eaa652EE3755

Purpose

Current-stage Web3 payment receiver and publication executor.

```
Client
  ↓
Executor Hot public address
  ↓
payment verification
  ↓
Upload Authority / publication pipeline
  ↓
Executor Hot pays Irys publication cost
  ↓
Irys
  ↓
Arweave immutable storage
```

Performs
- receives current Web3 payments;
- controls its own Base ETH balance;
- pays gas for on-chain operations;
- funds Irys balance when required;
- pays actual Irys publication cost;
- executes publication authority.

Does not
- is not Payment Verification Authority;
- is not Business Quote Authority;
- is not Manifest Authority;
- is not Trusted Time Authority;
- does not receive user secrets;
- does not receive encryption keys;
- does not receive plaintext data.

## 🌍 External Services

### 5. Alchemy

Purpose

RPC provider for the Base network.

Used for:
- verifying USDC transactions;
- retrieving blockchain data;
- checking confirmations;
- retrieving block information.

Does not:
- does not hold funds;
- does not accept payments;
- does not sign transactions.

### 6. Reown (WalletConnect)

Purpose

Connecting user wallets.

Supports:
- MetaMask
- Coinbase Wallet
- Rabby
- Rainbow
- Trust Wallet

```
Wallet
    ↓
Reown
    ↓
AETERNA
```

Used for:
- Connect Wallet;
- retrieving the user's address;
- initiating transaction signing.

Does not:
- does not hold money;
- does not verify payment;
- does not know the Capsule price.

### 7. MetaMask

Purpose

The user's wallet, and wallets used by administrators.

Performs:
- storing private keys;
- signing transactions;
- sending USDC;
- holding ETH for gas payment.

### 8. ChainList

Purpose

Adding the Base network for the user.

Used only once.

Does not:
- does not participate in payment;
- does not interact with AETERNA.

## 💳 Payment Infrastructure

### 9. Paddle

Purpose

Accepting bank cards.

```
Bank card
        ↓
     Paddle
        ↓
   AETERNA company
```

After successful verification, the Business Layer validates payment against the existing Business Quote. Business Quote remains the sole canonical commercial authority object; verification does not create a separate Payment Authority object — it confirms that the Business Quote's payment condition has been satisfied.

## 🗄 Storage

### 10. Irys

Purpose

Immutable storage backend for published encrypted Vault data.

Publication is funded and executed by Executor Hot.

Irys is not a payment receiver for client payments.

### 11. Arweave

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
- Business Quote.

Issues (operational, non-authoritative):
- Upload Token.

Performs:
- creating the Business Quote;
- verifying payment (validated against the Business Quote — does not create a separate authority object);
- issuing Upload Token;
- controlling the publication lifecycle.

Does not know:
- how encryption works;
- how the Vault is published;
- how Arweave works;
- how Web3 payments are received;
- how Irys is funded.

## Storage Layer

Receives:
- Upload Token.

Performs:
- publishing the Vault via Executor Hot;
- receiving vaultTxId;
- publishing chunks and recording their locations in the Chunk Pointer Registry (the sole canonical chunk-to-storage-pointer mapping surface; see AI/07_PROJECT_GLOSSARY.md and AETERNA_COMPLETE_SYSTEM_LOGIC.md);
- creating Storage Authority;
- passing the result to Seal.

Does not know:
- how the user paid;
- how much the publication cost;
- who owns the card or wallet;
- how Executor Hot funds Irys.

## 🔐 Full Architecture

```
                     User
                            │
            ┌───────────────┴───────────────┐
            │                               │
       Bank card                       MetaMask
            │                               │
            ▼                               ▼
         Paddle                     Reown Connect
            │                               │
            │                       Signing the TX
            │                               │
            └───────────────┬───────────────┘
                            │
                            ▼
                    Business Quote
                            │
                            ▼
              Payment Verified (Business Quote)
                            │
                            ▼
                  Upload Token
                            │
                            ▼
                     Storage Layer
                            │
                            ▼
                   Executor Hot Wallet
                            │
                            ▼
                          Irys
                            │
                            ▼
                  Storage Authority
                            │
                            ▼
                           Seal
                            │
                            ▼
                  Manifest Authority
```

## 🏦 Final Role Map

| Component | Primary role |
|---|---|
| AETERNA_PROTOCOL_TREASURY_SAFE | Deferred/future governance treasury layer; not current Web3 payment receiver |
| AETERNA_SIGNER_PRIMARY | Primary controller of the Treasury Safe |
| AETERNA_SIGNER_RECOVERY | Backup controller of the Treasury Safe |
| AETERNA_EXECUTOR_HOT | Current Web3 payment receiver + Publication Authority; receives client payments, controls operational ETH/gas, pays Irys |
| Alchemy | Access to the Base blockchain and USDC transaction verification |
| Reown (WalletConnect) | Connecting user wallets |
| MetaMask | Storing keys and signing transactions |
| ChainList | Adding the Base network for the user |
| Paddle | Accepting bank card payments |
| Irys | Publishing the encrypted Vault |
| Arweave | Immutable long-term storage of the Capsule |
| Business Layer | Business Quote → payment verification → Upload Token |
| Storage Layer | Upload Token → Executor Hot → Storage Authority |
| Seal | Storage Authority → Manifest Authority |

## Architectural Principles

- The Business Quote is created before payment begins and is the sole commercial source of truth; it is not replaced or superseded by any post-verification authority object.
- Payment verification confirms successful payment against the Business Quote, regardless of payment method (bank card or Web3), and does not create a separate authority object.
- Upload Token is issued only after successful payment verification.
- The Storage Layer begins publication only after receiving Upload Token.
- Executor Hot pays for the Irys publication from its own available funds received as the current Web3 payment receiver.
- Storage Authority confirms successful publication of the Vault.
- Manifest Authority is created only after a successful Seal and becomes the permanent source of truth for the Capsule's sealed identity, integrity, and Vault discovery. Per-object chunk-location resolution is a separate concern governed by Storage Authority via the Chunk Pointer Registry, not by the Manifest.
- Crypto Layer, Business Layer, Storage Layer, and Runtime Layer are fully isolated from one another and have independent areas of responsibility.
- Each layer creates only its own Authority and has no right to modify the Authority of another layer.

## Authority Sequence in the Capsule Lifecycle

Upload Token is an operational capability, not a protocol Authority, and is therefore not part of the Authority chain below (see AI/07_PROJECT_GLOSSARY.md).

```
Commercial Authority
(Business Quote)
          ↓
      [Payment Verification — validates Business Quote, not a separate Authority]
          ↓
      [Upload Token — operational, non-authoritative]
          ↓
Storage Authority
(via Chunk Pointer Registry)
          ↓
Manifest Authority
```