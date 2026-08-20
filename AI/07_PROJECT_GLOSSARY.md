# AETERNA Project Glossary

Version: 1.0
Status: FINAL CANONICAL

---

# Purpose

This document defines the canonical terminology used throughout the AETERNA project.

Every AI must use these definitions consistently.

Terms defined here must not be reinterpreted unless the canonical protocol explicitly changes.

---

# General Rule

Every technical term has exactly one canonical meaning.

The AI must never invent alternative terminology.

The AI must never reinterpret existing terminology.

This glossary summarizes terminology.

It does not redefine protocol behavior.

If any glossary definition conflicts with canonical documentation, the canonical documentation takes precedence.

---

# Core Protocol Objects

## Capsule

A Capsule is the complete protocol object created by a user.

A Capsule contains all protocol components required for future opening.

A Capsule is not a file.

A Capsule is not a Vault.

A Capsule is not a Manifest.

---

## Vault

A Vault is the encrypted payload of a Capsule.

The Vault contains encrypted user data.

The Vault never contains plaintext.

---

## Manifest

The Manifest is the public metadata describing a Capsule.

The Manifest contains protocol metadata only.

The Manifest never contains secrets.

The Manifest never contains plaintext.

---

## PreparedCapsule

PreparedCapsule is the canonical PREPARED authority object.

Its creation establishes Ciphertext Authority.

After PreparedCapsule exists, cryptographic authority becomes immutable.

---

## PreparedChunk

PreparedChunk is an implementation object created during media preparation.

It temporarily represents encrypted media before publication.

PreparedChunk is not protocol authority.

---

# Capabilities

## Secret

Secret is the user-controlled capability used to derive the vault key.

Within the protocol, Secret is implemented as the Recipient Secret.

Secret never leaves the client.

---

## Recipient Secret

The Recipient Secret is the cryptographic capability required to derive the vault key.

It never leaves the client.

It is never transmitted to the server.

---

## Creator Authority

Creator Authority grants creator-only protocol operations.

It never grants decryption capability.

It is independent from the Recipient Secret.

---

## Capability Link

A Capability Link is a URL containing protocol capabilities.

Possession of the correct capability grants access.

Accounts are never required.

---

## Creator Link

The Creator Link is the creator-facing capability link.

It grants creator-only functionality.

It does not grant additional cryptographic authority.

---

## Recipient Link

The Recipient Link is the recipient-facing capability link.

It allows the recipient to access the capsule.

It never grants creator authority.

---

## Creator Authority Link

A Creator Authority Link carries creator authority without recipient capability.

Its behavior is defined by the canonical protocol.

---

## Upload Token

Upload Token is a temporary operational capability.

It authorizes publication only.

It never grants decryption.

It never becomes protocol authority.

---

# Authority Domains

## Business Authority

Business Authority governs pricing and payment.

It is independent from every cryptographic authority.

---

## Ciphertext Authority

Ciphertext Authority governs immutable encrypted data.

It becomes immutable after PREPARED.

---

## Open Authority

Open Authority governs when a capsule may be opened.

It includes Trusted Time and Heartbeat rules.

---

## Storage Authority

Storage Authority governs publication and storage metadata.

It never changes cryptographic authority.

---

## Authority

Authority is the canonical right to perform protocol operations.

Different authority domains remain strictly separated throughout the protocol.

---

# Crypto Layer

Crypto Layer performs all cryptographic operations.

Crypto Layer never performs payment or publication.

---

# Business Layer

Business Layer governs pricing, payment verification and publication authorization.

Business Layer never performs cryptography.

---

## Creator Service Quote

Creator Service Quote is the canonical commercial entitlement object.

Creator Service Quote is the sole commercial source of truth for the AETERNA service fee.

It is created exactly once.

It is never recalculated.

---

## USD 1.00 Creator Credit

USD 1.00 is the fixed AETERNA service fee.

It is fixed before preparation.

It never changes.

Capsule size and storage volume do not affect the AETERNA service fee.

---

## encryptedSizeBytes

encryptedSizeBytes is the encrypted storage size.

It never affects pricing.

---

# Storage Layer

Storage Layer is responsible for publishing encrypted data into immutable storage.

Storage Layer never performs encryption or decryption.

---

## Executor

Executor is the trusted publication service.

Executor accepts only already encrypted data.

Executor never decrypts data.

Executor never receives user secrets.

Executor never makes business decisions.

---

## Chunk

Chunk is a unit of encrypted media.

Chunks are uploaded independently.

---

## Chunk Identifier

Chunk Identifier is the immutable identity of a chunk.

It never depends on the storage provider.

---

## Chunk Metadata

Chunk Metadata describes encrypted media structure.

Core metadata becomes immutable after PREPARED.

---

## Chunk Pointer

Chunk Pointer identifies the storage location of a chunk.

---

## Chunk Pointer Registry

Chunk Pointer Registry maps chunk identifiers to storage pointers.

---

## Storage Pointer

Storage Pointer identifies immutable stored data.

---

# Runtime Layer

## Runtime

Runtime executes the protocol.

Runtime is never Protocol Authority.

Runtime never owns plaintext.

Runtime never modifies canonical authority.

Runtime exists only during protocol execution.

It is not permanent storage.

---

## Runtime Storage

Runtime Storage temporarily holds encrypted preparation data before publication.

Runtime Storage is temporary execution storage.

Its lifetime is limited to protocol execution.

---

## Persistent Runtime

Persistent Runtime allows publication to continue after interruption.

It remains part of Runtime.

---

## Emergency Runtime

Emergency Runtime is the disaster recovery implementation.

It preserves every protocol authority.

---

## Protocol Authority

Protocol Authority is authority defined by the canonical protocol.

Implementation objects never become Protocol Authority unless explicitly defined by the protocol.

---

# Protocol Lifecycle

## Prepare

Prepare is the protocol stage that creates immutable cryptographic state before payment and publication.

---

## PREPARED

PREPARED marks the completion of cryptographic preparation.

Ciphertext becomes immutable.

---

## Seal

Seal is the canonical publication procedure that permanently finalizes a Capsule.

Seal completes only after the Manifest has been successfully published.

---

## SEALED

SEALED means the Manifest has been successfully published.

The capsule becomes immutable.

---

## OPENABLE

OPENABLE means all opening conditions have been satisfied.

---

## OPENED

OPENED means the Vault has been decrypted successfully.

---

# Opening Model

## Heartbeat

Heartbeat is the canonical protocol mechanism governing rolling opening.

It may postpone the effective opening time.

Confirm Presence is its user-facing representation.

---

## Confirm Presence

Confirm Presence is the user-facing name of Heartbeat.

Confirm Presence never changes capsule contents.

It may only postpone the effective opening time.

---

## Trusted Time

Trusted Time determines opening eligibility only.

Trusted Time never participates in cryptography.

Trusted Time never derives cryptographic keys.

---

# Media Model

## Media Item

Media Item represents user content stored inside the Vault.

---

## Vault Item

Vault Item is the serialized representation stored inside the Vault.

---

## Streaming

Streaming processes media incrementally.

Memory usage remains bounded.

---

## Streaming Reconstruction

Streaming Reconstruction rebuilds media progressively during opening.

Whole-file buffering is forbidden.

---

# Security Model

## Non-Custodial

Only the user possesses decryption capability.

Servers never possess decryption authority.

---

## Capability-Based Access

Possession of the required capability grants access.

Accounts are unnecessary.

---

## Fail Closed

Whenever uncertainty exists, the protocol fails safely.

Security always has priority.

---

# Final Rule

This glossary defines canonical terminology.

It does not redefine protocol behavior.

Whenever canonical documentation defines a term in greater detail, canonical documentation always takes precedence over this glossary.

This glossary exists to improve consistency, not to replace canonical specifications.