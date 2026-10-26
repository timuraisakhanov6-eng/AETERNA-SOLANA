# AETERNA Canonical Glossary

Status: canonical
Authority: terminology layer for the canonical documentation

---

# 1. PURPOSE

This document defines the canonical terminology used throughout the AETERNA
project.

Every technical term has exactly one canonical meaning. Terms defined here
MUST NOT be reinterpreted unless the canonical protocol explicitly changes.

This glossary summarizes terminology. It does not redefine protocol behavior.
Wherever a canonical specification defines a term in greater detail, that
specification takes precedence over this glossary.

---

# 2. CORE PROTOCOL OBJECTS

- **Capsule** — the complete protocol object created by a user; contains all
  protocol components required for future opening. A Capsule is not a file,
  not a Vault, and not a Manifest.
- **Vault** — the encrypted payload of a Capsule. The Vault contains encrypted
  user data and never contains plaintext.
- **Manifest** — the public metadata describing a Capsule. The Manifest
  contains protocol metadata only and never contains secrets or plaintext.
- **PreparedCapsule** — the canonical PREPARED authority object; its creation
  establishes Ciphertext Authority. After PreparedCapsule exists,
  cryptographic authority becomes immutable.
- **PreparedChunk** — an implementation object created during media
  preparation; temporarily represents encrypted media before publication.
  PreparedChunk is not protocol authority.

---

# 3. CAPABILITIES

- **Secret / Recipient Secret** — the user-controlled cryptographic capability
  required to derive the vault key. It never leaves the client and is never
  transmitted to the server.
- **Creator Authority** — grants creator-only protocol operations. It never
  grants decryption capability and is independent from the Recipient Secret.
- **Capability Link** — a URL containing protocol capabilities; possession of
  the correct capability grants access. Accounts are never required.
- **Creator Link** — the creator-facing capability link; grants creator-only
  functionality and no additional cryptographic authority.
- **Recipient Link** — the recipient-facing capability link; allows the
  recipient to access the capsule and never grants creator authority.
- **Creator Authority Link** — carries creator authority without recipient
  capability.
- **Upload Token** — a temporary operational capability. It authorizes
  publication only, never grants decryption, and never becomes protocol
  Authority. Upload Token is an operational capability, not a protocol
  Authority, and is therefore not part of the Authority chain.

---

# 4. AUTHORITY DOMAINS

- **Authority** — the canonical right to perform protocol operations.
  Different authority domains remain strictly separated throughout the
  protocol.
- **Ciphertext Authority** — governs immutable encrypted data; becomes
  immutable after PREPARED.
- **Open Authority** — governs when a capsule may be opened; includes Trusted
  Time and Heartbeat rules.
- **Business Authority** — governs pricing and payment; independent from
  every cryptographic authority.
- **Storage Authority** — governs publication and storage metadata; never
  changes cryptographic authority.
- **Protocol Authority** — authority defined by the canonical protocol.
  Implementation objects never become Protocol Authority unless explicitly
  defined by the protocol.

---

# 5. LAYERS

- **Crypto Layer** — performs all cryptographic operations; never performs
  payment or publication.
- **Business Layer** — governs pricing, payment verification, and publication
  authorization; never performs cryptography.
- **Storage Layer** — publishes encrypted data into immutable storage; never
  performs encryption or decryption.
- **Runtime** — executes the protocol. Runtime is never Protocol Authority,
  never owns plaintext, never modifies canonical authority, exists only
  during protocol execution, and is not permanent storage.
- **Runtime Storage** — temporary execution storage holding encrypted
  preparation data before publication; its lifetime is limited to protocol
  execution.
- **Persistent Runtime** — allows publication to continue after interruption;
  remains part of Runtime.
- **Emergency Runtime** — the disaster recovery implementation; preserves
  every protocol authority.

---

# 6. BUSINESS OBJECTS

- **Creator Service Quote** — the canonical commercial entitlement object;
  the sole commercial source of truth for the AETERNA service fee; created
  exactly once and never recalculated.
- **1 USDC service fee / Creator Credit** — the fixed AETERNA service fee,
  fixed before preparation and never changing. Capsule size and storage
  volume do not affect the AETERNA service fee.
- **encryptedSizeBytes** — the encrypted storage size; never affects service
  pricing.

---

# 7. STORAGE MODEL

- **Executor (Executor Hot)** — historical / retired implementation, NOT part
  of the active business model. The Executor Hot code path has been removed
  from the runtime; any remaining reference to it is historical/dead-rail
  only. It is not a canonical publication authority, verifier, storage payer,
  treasury, or publication funder, and AETERNA does not finance, subsidize,
  front, or reimburse Irys costs. An executor accepts only already-encrypted
  data, never decrypts data, never receives user secrets, and never makes
  business decisions.
- **Chunk** — a logical unit of encrypted media. Chunks are LOGICAL units:
  every logical chunk of a capsule's media is published together inside ONE
  AETERNA Container V1 DataItem, never as an independent upload.
- **AETERNA Container V1** — the canonical media-publication model. All
  logical encrypted chunks of a capsule's media are laid out deterministically
  and published as ONE Irys DataItem, producing ONE containerTxId and ONE
  container publication claim. Chunk positions (offset / length) are DERIVED
  from the canonical layout, never persisted, and read back through bounded
  HTTP Range requests. There is no per-chunk publication model.
- **Chunk Identifier** — the immutable identity of a chunk; never depends on
  the storage provider.
- **Chunk Metadata** — describes encrypted media structure; core metadata
  becomes immutable after PREPARED.
- **Container V1 publication record** — maps a capsule's logical chunk
  identifiers to the ONE container DataItem and its derived chunk positions.
- **Storage Pointer** — identifies immutable stored data.

---

# 8. PROTOCOL LIFECYCLE

- **Prepare** — the protocol stage that creates immutable cryptographic state
  before payment and publication.
- **PREPARED** — marks the completion of cryptographic preparation; ciphertext
  becomes immutable.
- **Seal** — the canonical publication procedure that permanently finalizes a
  Capsule; completes only after the Manifest has been successfully published.
- **SEALED** — the Manifest has been successfully published; the capsule
  becomes immutable.
- **OPENABLE** — all opening conditions have been satisfied.
- **OPENED** — the Vault has been decrypted successfully.

---

# 9. OPENING MODEL

- **Heartbeat** — the canonical protocol mechanism governing rolling opening;
  may postpone the effective opening time. Confirm Presence is its
  user-facing representation.
- **Confirm Presence** — the user-facing name of Heartbeat; never changes
  capsule contents and may only postpone the effective opening time.
- **openAt** — the immutable capsule opening timestamp sealed into the
  Manifest; a binding PBKDF2 vault-key derivation input (Ciphertext Authority)
  that never changes after it is established. It is NOT a cryptographic
  time-lock: it is a fixed value, not a current-time-dependent secret, and it
  does not by itself prevent decryption before the opening time. Early opening
  is refused by the canonical client's trusted-time / effectiveOpenAt guard
  (see SECURITY.md §16).
- **effectiveOpenAt** — the authoritative runtime opening boundary; derived at
  runtime from the immutable sealed openAt, Trusted Time, and Heartbeat
  records. It may only move forward, never backwards, and never changes the
  sealed openAt.
- **Trusted Time** — determines opening eligibility only; never participates
  in cryptography and never derives cryptographic keys.

---

# 10. MEDIA MODEL

- **Media Item** — represents user content stored inside the Vault.
- **Vault Item** — the serialized representation stored inside the Vault.
- **Streaming** — processes media incrementally; memory usage remains bounded.
- **Streaming Reconstruction** — rebuilds media progressively during opening;
  whole-file buffering is forbidden.

---

# 11. SECURITY MODEL

- **Non-Custodial** — only the user possesses decryption capability; servers
  never possess decryption authority.
- **Capability-Based Access** — possession of the required capability grants
  access; accounts are unnecessary.
- **Fail Closed** — whenever uncertainty exists, the protocol fails safely;
  security always has priority.
