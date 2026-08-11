AETERNA — Complete System Logic
Status: canonical. FINAL LOCK STABLE.
Authority: AETERNA Canonical Documentation. Status: FINAL LOCK STABLE.
Supersedes: v4.3 FINAL LOCK STABLE.

What is AETERNA?
AETERNA is not a messenger.
AETERNA is a cryptographic time capsule.
The creator builds the capsule. The contents are encrypted locally. No one can open the capsule until the opening conditions are met. Even the AETERNA server cannot read the contents.

Core Entities
Four objects in total.
1. Vault
The payload. Contains: text, photos, video, audio, files.
After preparation it becomes Vault V2.
Canonical item types: text, media.
Canonical media types: image, video, audio, file.
2. Manifest
Public metadata. Canonical fields:

version
capsuleId
sealedAt
openAt
vaultTxId
encryptedSizeBytes
saltBase
heartbeatInterval

Manifest integrity fields:

ext.vaultSha256

version is the Manifest schema version, per MANIFEST_EVOLUTION.md (current: Manifest V1). It is a core protocol field, not an ext field, and is required for compatibility and fail-closed handling of future schema versions.
ext.vaultSha256 is the canonical hash anchor of the ciphertext. It is stored in the ext namespace of the Manifest to distinguish integrity metadata from core protocol fields.
It participates in: ciphertext verification, manifest integrity enforcement, open-state continuity.
It does not participate in: key generation, capability authority, pricing, activity monitoring.
The Manifest does not contain capsule contents. The Manifest does not contain recipient secrets. The Manifest does not generate, derive, or grant any capabilities.
These are the only canonical Manifest fields (including version, per MANIFEST_EVOLUTION.md). No other description of Manifest fields is authoritative.
3. Capabilities
Access rights. There are no accounts, no logins, no users in the system. Everything is built on capabilities.
4. Heartbeat (user-facing: Confirm Presence)
Heartbeat is the canonical liveness confirmation mechanism of every capsule. It is always available as a protocol capability and is never enabled or disabled per capsule. What varies between capsules is only when confirmations become available; this timing is determined solely by the originally selected opening interval. Heartbeat never modifies capsule contents, cryptographic authority, or ciphertext. It affects only Open Authority by updating the effective opening time according to the canonical Heartbeat rules. (See "Heartbeat Specification" below for the full set of canonical rules.)

Capsule Identifier
capsuleId is generated independently, before PREPARED.
capsuleId is not produced by the capability generators (generateRecipientSecret(), generateCreatorAuthority(), generateSaltBase()) — it has its own dedicated, separate generation step.
capsuleId uniquely identifies the capsule.
capsuleId is immutable.
capsuleId becomes immutable after PREPARED.
capsuleId never changes after sealing.
capsuleId participates in vault key derivation.
capsuleId is the canonical capsule identifier throughout the protocol.
After the ciphertext is created, no operation may replace, recover, or alter capsuleId.

Heartbeat Records
Heartbeat records contain:

capsuleId
lastConfirmedAt

Heartbeat records are stored separately from the Manifest.
Heartbeat records never contain:

secret
recipientSecret
creatorAuthority
vault contents
ciphertext

Heartbeat records affect open authority only. Heartbeat records never affect the ciphertext, key derivation, or vault contents.

Heartbeat Window
Every capsule supports Heartbeat. Its availability depends on the originally selected opening interval.

If the initial interval is 30 days or less, Heartbeat is available immediately.
If the initial interval exceeds 30 days, Heartbeat remains unavailable until the remaining time until openAt reaches 30 days.

Before that moment the creator may view Heartbeat status but cannot submit confirmations.

Creator Path

Creator opens /create.
Adds content — for example, text, photos, video, voice messages, PDFs.
Selects an opening date — for example, January 1, 2050.

Heartbeat is automatically supported for every capsule. No separate enable step exists.

If the originally selected opening interval is 30 days or less, Heartbeat becomes available immediately after sealing.
If the originally selected opening interval exceeds 30 days, Heartbeat becomes available automatically during the final 30 days before opening.

Creator Experience Principle
During preparation and sealing, implementation details such as chunk processing, storage settlement, storage providers, Runtime Layer, Chunk Pointer Registry, and internal upload scheduling are not exposed to the creator.
The creator interacts only with high-level preparation and sealing progress (e.g. “Preparing…”, “Uploading…”, “Finalizing…”).
Builder Independence Principle
Builder components never operate on encrypted media.
Builder operates only on creator-provided source files.
Builder never reads encrypted media.
Builder never interacts with Runtime Storage.
Encrypted media belongs exclusively to Runtime Layer after preparation begins.

Creation Pipeline

Create
↓
Add Content
↓
Prepare Media
↓
Prepare Vault
↓
Prepare Encrypted Capsule
↓
PREPARED
↓
Calculate Capacity
↓
Business Quote Creation
↓
Business Quote
↓
Payment
↓
CapsuleHold
↓
Request Upload Token
↓
Upload
↓
Storage Authority Established
(Chunk Pointer Registry entries recorded per chunk)
↓
Verification
↓
Create Manifest
↓
Manifest Authority Established
↓
SEALED
Capacity is calculated after PREPARED according to the canonical Business Authority rules.
Business Quote is then created exactly once.
Business Quote becomes the canonical commercial authority of the capsule.
All payment authorization and verification stages consume the existing Business Quote.
No protocol stage after Business Quote creation may regenerate, replace or modify Business Quote.

Capability Generation
Capability generators run before media encryption and before prepareVault().
These generators produce only:

recipientSecret
creatorAuthority
saltBase

After capability generation, generateVaultKey() derives the vault key. The derived key is shared by prepareMediaChunks() (chunk encryption) and prepareEncryptedCapsule() (vault encryption).
They do not produce capsuleId. capsuleId is generated independently, before PREPARED, in its own dedicated step (see Capsule Identifier).
They are generated exactly once. They cannot be regenerated without violating the Ciphertext Authority Law.
textRecipient Link: /capsule/:id#recipientSecret
Creator Link: /capsule/:id#recipientSecret&c=creatorAuthority
Creator Authority Link: /capsule/:id#c=creatorAuthority
recipientSecret is the sole source of decryption authority.
creatorAuthority is the sole source of authority for sending liveness confirmation signals.
Capability Authority Clarification
recipientSecret and creatorAuthority:

are capability values
are generated before prepareEncryptedCapsule() and before PREPARED
are not derived from the ciphertext
are not derived from vaultSha256
are not derived from encryptedPayload
are not stored inside the vault
are not stored in the Manifest
become immutable after the ciphertext is created

Loss of these values makes recovery impossible. Recovery would violate ciphertext continuity.

Vault Preparation
Invoked by: prepareVault()
prepareVault() does not create secret, saltBase, or capsuleId. prepareVault() only assembles Vault V2 and serializes it into vaultBytes, using values already generated upstream — recipientSecret, creatorAuthority, saltBase (via capability generators) and capsuleId (generated independently, before PREPARED).
encryptVault() is not called as a separate, standalone step. Encryption occurs inside prepareEncryptedCapsule().
prepareEncryptedCapsule() performs:
textencryptVault()
↓
sha256(ciphertext)
↓
return encryptedPayload + vaultSha256
Note: generateSaltBase() runs earlier — in the capability generator block — and is not part of prepareEncryptedCapsule(). generateVaultKey() also runs earlier, after capability generation, and is reused by both media encryption and prepareEncryptedCapsule().
Full pipeline:
textgenerateCapsuleId()
↓
generateRecipientSecret()
generateCreatorAuthority()
generateSaltBase()
↓
generateVaultKey()
↓
prepareMediaChunks()
↓
encryptChunk()
↓
Runtime Storage
↓
ChunkMetadata[]
↓
toVaultItems()
↓
prepareVault()
↓
vaultBytes
↓
prepareEncryptedCapsule()
↓
PreparedCapsule
↓
PREPARED
Computed at this stage: vaultSha256.

PreparedCapsule Authority
PreparedCapsule is the canonical PREPARED authority object.
PREPARED state cannot exist without PreparedCapsule.
PreparedCapsule activates the Ciphertext Authority Law.
PreparedCapsule is consumed by:

capacity calculation
Business Quote creation
CapsuleHold
upload
manifest creation

No operation after PREPARED may modify or replace PreparedCapsule.
PreparedCapsule structure:
JavaScriptPreparedCapsule {
    chunkMetadata
    encryptedPayload
    encryptedSizeBytes
    vaultSha256
    saltBase
    capsuleId
    recipientSecret
    creatorAuthority
}
openAt and open authority:
The sealed openAt value is determined by the creator before PREPARED and is a binding PBKDF2 vault-key derivation input (see INVARIANTS.md §2.2); it is therefore part of Ciphertext Authority and is immutable for the lifetime of the capsule.
effectiveOpenAt is a separate, derived value computed by resolveEffectiveOpenAt() from sealed openAt, Trusted Time, and Heartbeat records. effectiveOpenAt belongs to Open Authority only and does not intersect with Ciphertext Authority.
The sealed openAt value is established before PREPARED, alongside the other Ciphertext Authority inputs, and becomes immutable at that point in the same manner as those inputs.
Changing sealed openAt after it is established is forbidden under all circumstances, including Heartbeat. The canonical Heartbeat Renewal Rules update effectiveOpenAt within Open Authority only and never touch sealed openAt or vault-key derivation.
Sealed openAt is written to the Manifest after payment, but it is not created or modified at that point. The Manifest records the already-established value — it is not the source of openAt.
Two related but distinct values exist: sealed openAt (a Ciphertext Authority / key-derivation input) and effectiveOpenAt (an Open Authority computation). Only effectiveOpenAt is mutable via Heartbeat; sealed openAt never changes.
After the PreparedCapsule object is created, the following become immutable:

chunkMetadata core fields (chunkId, mediaId, index, size)
encryptedPayload
encryptedSizeBytes
vaultSha256
saltBase
capsuleId
recipientSecret
creatorAuthority

Storage pointers are not part of chunkMetadata and are not part of the immutable core. The Chunk Pointer Registry is the sole surface for chunk-to-storage-pointer mapping; entries are recorded during Upload and belong to Storage Authority (see "Chunk Pointer Registry" section below).
PreparedChunk ciphertext retention is implementation-defined.

Critical Boundary
After PREPARED is reached, the ciphertext control mechanism is activated.
The ciphertext authority set includes:

chunkMetadata core fields (chunkId, mediaId, index, size)
encryptedPayload
encryptedSizeBytes
vaultSha256
saltBase
capsuleId
recipientSecret
creatorAuthority


CIPHERTEXT AUTHORITY LAW
The following values become immutable:

chunkMetadata core fields (chunkId, mediaId, index, size)
ciphertext (encryptedPayload)
vaultSha256
encryptedSizeBytes
saltBase
capsuleId
recipientSecret
creatorAuthority

Forbidden:

re-encryption
modifying saltBase
modifying vaultSha256
modifying the ciphertext
replacing capsuleId
replacing recipientSecret
replacing creatorAuthority
re-encrypting chunks
regenerating chunk identifiers
modifying chunk metadata core fields (chunkId, mediaId, index, size)

No operation after PREPARED may alter cryptographic authority.
Capabilities are not recovered or granted at any stage after PREPARED, including manifest creation. Authority is established before PREPARED, not after.

Media Preparation
Media preparation occurs after capability generation and generateVaultKey(), before prepareVault(), and before payment.
For each media file:
textderiveChunkBaseIV()
↓
deriveChunkIV()
↓
encryptChunk()
↓
store in Runtime Storage
↓
prepare ChunkMetadata
During media preparation encrypted chunks are written into the Runtime Layer. Permanent storage upload does not occur during media preparation.
After all chunk metadata is prepared, canonical chunk references are written into Vault V2 via toVaultItems(). Only after this may prepareVault() and prepareEncryptedCapsule() be called.
PreparedChunk
JavaScriptPreparedChunk {
    chunkId
    mediaId
    chunkIndex
    ciphertext
    ciphertextSize
}
iv is not stored. The initialization vector is deterministic and is recovered on demand via deriveChunkBaseIV() and deriveChunkIV(); it is never stored alongside the chunk.
PreparedChunk Lifetime
PreparedChunk is an implementation helper produced during media preparation.
Its lifetime is implementation-defined.
After ciphertext has been transferred into the Runtime Layer, PreparedChunk no longer owns ciphertext.
Ciphertext continuity is preserved by the Runtime Layer until Upload verification completes.

Chunk Identifier Authority

Chunk identifiers are canonical content references.
Chunk identifiers participate in vault content authority.
Chunk identifiers are immutable after PREPARED.
Chunk identifiers are not storage provider identifiers.
Chunk identifiers are not capability values.
Chunk identifiers do not participate in key derivation.

Storage providers map chunk identifiers to operational storage pointers. Changing storage pointers must not require changing chunk identifiers.

Chunk Metadata Authority

Chunk metadata core fields (chunkId, mediaId, index, size) are part of the Vault content management system.
Chunk metadata describes the structure of encrypted media.
Chunk metadata core fields participate in ciphertext continuity.
Chunk metadata core fields become immutable after PREPARED.
Storage pointers belong to Storage Authority (via the Chunk Pointer Registry) and are not part of Ciphertext Authority.

Chunk metadata core fields do not contain storage provider pointers, transaction identifiers, capability values, or key material.
Storage pointers are Storage Authority metadata only, held exclusively in the Chunk Pointer Registry. Storage pointers do not participate in ciphertext continuity, capability authority, key derivation, manifest integrity, or open authority.
Changing the storage provider requires only updating the corresponding Chunk Pointer Registry entry — it must not require modifying core chunk metadata fields. Chunk metadata is used when reconstructing media in the OPENED state.

Storage Pointer Management
Storage provider pointers are operational metadata. They are not part of: vault authority, manifest authority, ciphertext continuity, capability authority, or key derivation.
Storage provider pointers may change without requiring: vault modification, manifest modification, re-encryption, or capability regeneration.
Storage migration must preserve: ciphertext, chunk identifiers, recipient access, creator access, manifest integrity.

Storage Authority Registry
Storage Authority maintains a persistent Chunk Pointer Registry.
The Chunk Pointer Registry is the canonical operational mapping between immutable chunk identifiers and storage-provider pointers.
Canonical structure:
JavaScriptChunkPointerRegistry {
    chunkId
    pointer
}
During Upload:
textPreparedChunk
↓
storage.upload()
↓
pointer assigned
↓
ChunkPointerRegistry updated
Storage Authority writes:
textchunkId
↓
pointer
into the Chunk Pointer Registry.
The Chunk Pointer Registry is operational metadata only.
The Chunk Pointer Registry is NOT part of:

Ciphertext Authority
Capability Authority
Manifest Authority
Open Authority
Business Authority

The Chunk Pointer Registry may be modified without:

re-encryption
vault modification
manifest modification
capability regeneration
vaultSha256 modification

Storage migration updates only:
textchunkId
↓
pointer
mappings.
OPENED media recovery path:
textChunkMetadata[]
↓
chunkId
↓
Chunk Pointer Registry lookup
↓
pointer
↓
download encrypted chunk
↓
decryptChunk()
↓
stream reconstruction
↓
release processed memory
↓
Blob / MediaSource / File Stream
↓
progressive render
Emergency Runtime uses the same Chunk Pointer Registry lookup process.
Loss of a storage provider does not require modification of:

Vault
Manifest
PreparedCapsule
Capabilities

Only the Chunk Pointer Registry may be updated.
Chunk identifiers remain the canonical content authority.
Storage pointers remain operational metadata.

Upload Token
An upload token may be requested after successful payment. Issuing an upload token before payment is forbidden.
An upload token is a temporary capability issued only after payment confirmation.
Upload tokens permit: uploading encrypted chunks, uploading the encrypted vault.
Upload tokens do not grant: decryption, heartbeat signaling, capsule access, recipient authority, creator authority.
Upload tokens are operational capabilities.
Upload tokens do not participate in:

ciphertext authority
capability authority
heartbeat authority
recipient authority
creator authority

Upload tokens may expire or be replaced without affecting the capsule.
Canonical chunk references stored in Vault metadata are immutable chunk identifiers. Chunk references are not storage provider identifiers, Arweave transaction IDs, or Irys transaction IDs.
Storage provider pointers are operational metadata and are not part of Vault authority. Changing the storage provider must not require Vault modification.

Media Architecture Summary
textgenerateCapsuleId()
↓
generateRecipientSecret()
generateCreatorAuthority()
generateSaltBase()
↓
generateVaultKey()
↓
Prepare Media
↓
encryptChunk()
↓
Runtime Storage
↓
ChunkMetadata[]
↓
toVaultItems()
↓
prepareVault()
↓
vaultBytes
↓
prepareEncryptedCapsule()
↓
PreparedCapsule
↓
PREPARED

Ciphertext Preparation Authority
Prepared encrypted chunks are created before payment. Prepared encrypted chunks become part of the ciphertext integrity.
After PREPARED, the following become immutable:

encryptedPayload
encryptedSizeBytes
vaultSha256
saltBase
capsuleId
recipientSecret
creatorAuthority
chunkMetadata core fields (chunkId, mediaId, index, size)

Forbidden:

re-encrypting chunks
regenerating chunk identifiers
modifying chunk metadata core fields (chunkId, mediaId, index, size)

Recording or updating a chunk's entry in the Chunk Pointer Registry during Upload is permitted — the Chunk Pointer Registry belongs to Storage Authority and is not part of Ciphertext Authority.
CAPSULE_HOLD processes ciphertext stored in the Runtime Layer.

Prepared Boundary (Full Path)
textgenerateCapsuleId()
↓
generateRecipientSecret()
generateCreatorAuthority()
generateSaltBase()
↓
generateVaultKey()
↓
prepareMediaChunks()
↓
encryptChunk()
↓
Runtime Storage
↓
ChunkMetadata[]
↓
toVaultItems()
↓
prepareVault()
↓
vaultBytes
↓
prepareEncryptedCapsule()
↓
PreparedCapsule
↓
PREPARED

Trusted Time Authority
Trusted Time affects open authority only.
Trusted Time never participates in:

key derivation
capability authority
ciphertext continuity
vault contents

Trusted Time is used exclusively by resolveEffectiveOpenAt() to determine whether OPENABLE conditions are met. Local clocks and offline clocks MUST NEVER unlock capsules; no local-time fallback for opening exists anywhere in the protocol (see INVARIANTS.md §3.1, §9 and MANIFEST_EVOLUTION.md §10). If Trusted Time is unavailable, OPENABLE cannot be determined and no opening occurs until Trusted Time is restored.

Heartbeat Specification
Heartbeat is the canonical liveness confirmation mechanism of Open Authority. It is described here as a complete, self-contained specification.

Purpose
Heartbeat allows the creator to postpone the effective opening time of a capsule by periodically confirming continued presence, without ever touching ciphertext, cryptographic authority, or vault contents. Heartbeat is always active for every capsule. It is not a per-capsule option. Only the availability timing of confirmations varies, according to the Heartbeat Window.

Heartbeat Window (availability)
Heartbeat availability depends on the originally selected opening interval, fixed at sealing time:

If the initial interval is 30 days or less, Heartbeat is available immediately after sealing.
If the initial interval exceeds 30 days, Heartbeat remains unavailable until the remaining time until openAt reaches 30 days. Before that moment, the creator may view Heartbeat status but cannot submit confirmations.

Heartbeat Renewal Rules
Heartbeat renewal depends on the initial opening interval.

If the initial opening interval is 30 days or less, each successful confirmation extends effectiveOpenAt by the original opening interval. Sealed openAt is never modified.

Examples:
5-day capsule → Heartbeat confirmation → effectiveOpenAt +5 days
20-day capsule → Heartbeat confirmation → effectiveOpenAt +20 days
30-day capsule → Heartbeat confirmation → effectiveOpenAt +30 days

If the initial opening interval exceeds 30 days, Heartbeat becomes available only during the final 30 days before opening. Each successful confirmation extends effectiveOpenAt by exactly 30 days. Sealed openAt is never modified.

Example:
365-day capsule
Presence unavailable during the first 335 days.
Remaining 30 days → Heartbeat confirmation → effectiveOpenAt += 30 days.

Interaction with Open Authority
Heartbeat records (capsuleId, lastConfirmedAt) are consumed by resolveEffectiveOpenAt() together with Trusted Time to compute effectiveOpenAt. Heartbeat records never modify the sealed openAt value; they only influence effectiveOpenAt, computed by Open Authority. Heartbeat never modifies ciphertext, capability authority, or vault contents. Heartbeat is one of several inputs to Open Authority, alongside sealed openAt and Trusted Time.

Emergency Runtime Behavior
Emergency Runtime exposes Confirm Presence identically to the primary runtime, if currently available according to the canonical Heartbeat rules above. Emergency Runtime implements no parallel or simplified Heartbeat logic.

Summary
Heartbeat governance rests on: purpose, the Heartbeat Window, the Renewal Rules, its interaction with Open Authority, and identical behavior across the primary runtime and Emergency Runtime, for both short and long capsules.

Emergency Runtime
An authority-preserving fallback runtime.
emergency.html CapsuleView is a full-featured fallback. It is a static offline rendering surface that operates without contacting the AETERNA server for resolution or key material.
It preserves:

recipient authority
creator authority
heartbeat authority
open authority
ciphertext continuity

Emergency Runtime uses the canonical openCapsule() logic — no parallel or simplified opening procedure is implemented.
When Trusted Time is unavailable, Emergency Runtime — like the primary runtime — cannot determine OPENABLE and must not open the capsule. There is no local-time or offline-clock fallback for opening (see INVARIANTS.md §3.1, §9 and MANIFEST_EVOLUTION.md §10). Cryptographic authorities and openCapsule() logic remain unchanged in all cases.
Emergency Runtime may use heartbeat APIs if available, but does not depend on them for opening.
Emergency Runtime uses the same visual state machine as CapsuleView:
textloading
↓
preview
↓
opening
↓
opened
Emergency Runtime must be visually identical to CapsuleView.
Creator Link
text#secret&c=creatorAuthority
Exposes: Preview, Countdown, Heartbeat status, Confirm Presence (if currently available according to canonical Heartbeat rules), Open capsule, Opened contents.
Recipient Link
text#secret
Exposes: Preview, Countdown, Open capsule, Opened contents.
Constraints
Emergency Runtime generates nothing:

keys
capabilities
ciphertext
chunk identifiers

It uses only existing authority established during PREPARED. It cannot create, recover, or replace lost capabilities.
Emergency Runtime obeys the Bounded Memory Law and the Streaming Reconstruction Law.
Emergency Runtime must not require whole-capsule buffering.
Automatic Failover
Emergency Runtime is the canonical disaster recovery runtime.
If the primary runtime becomes unavailable, fails to initialize, or throws an unrecoverable error, the system may automatically transition to Emergency Runtime.
User intervention is not required, although manual transition to Emergency Runtime remains permitted.
Automatic failover must preserve:

capsuleId
recipient authority
creator authority
heartbeat authority
open authority
ciphertext continuity

Automatic failover must not alter:

ciphertext
capabilities
vault contents
chunk identifiers
manifest integrity

The transition affects only the rendering surface.
Cryptographic authority remains unchanged.
Post-open Recovery
If OPENABLE conditions have already been satisfied and the primary runtime is unavailable, Emergency Runtime must remain capable of:

obtaining the Manifest
downloading encrypted payloads
verifying vault integrity
deriving the vault key
decrypting the vault
reconstructing media streams
rendering opened contents

Loss of the primary runtime must not imply loss of capsule access.
Disaster Recovery Principle
A capsule that can be opened by the primary runtime must also be openable by Emergency Runtime.
Failure of React, UI components, router state, or application code must not result in loss of access to a valid capsule.
Capsule continuity has higher priority than application continuity.
The failure of the primary runtime must not prevent a recipient or creator from accessing an otherwise valid capsule.
Application continuity and capsule continuity are independent.
AETERNA itself may fail. A valid capsule must not.

Capsule Lifecycle
textDRAFT
↓
MEDIA_PREPARED
↓
PREPARED
↓
PAID
↓
CAPSULE_HOLD
↓
SEALED
↓
CONFIRM PRESENCE WINDOW
(availability depends on the original opening interval)
↓
OPENABLE
↓
OPENED
DRAFT — capsule contents are being assembled; nothing has been created yet.
MEDIA_PREPARED — prepareMediaChunks() is complete; PreparedChunk[] and ChunkMetadata[] exist. PREPARED has not yet been reached.
PREPARED — capabilities are generated, the vault is encrypted into PreparedCapsule, the Ciphertext Authority Law is activated. chunkMetadata core fields, encryptedPayload, and all cryptographic authorities become immutable.
PAID — payment has been successfully verified against the canonical Business Quote.
CAPSULE_HOLD — the prepared ciphertext is held pending upload; no media encryption occurs at this stage.
SEALED — the Manifest is created and verified; further capsule modification is closed.
CONFIRM PRESENCE WINDOW — present for every capsule. It governs Heartbeat availability and renewal. Its behaviour depends only on the originally selected opening interval.
OPENABLE — resolveEffectiveOpenAt() conditions are met.
OPENED — the vault is decrypted and rendered; access becomes permanent.

Business Layer Authority
Pricing and settlement are governed by:
AETERNA_PAYMENT_AND_ECONOMICS_MODEL_v1
Business authority governs:

capacity calculation
creator pricing
creator payment
future treasury governance settlement
storage settlement

Business authority does not govern:

capability authority
key derivation
ciphertext continuity
heartbeat semantics
open semantics

Business authority is isolated from:

capability authority
recipient authority
creator authority
heartbeat semantics
trusted time semantics
open semantics
ciphertext continuity

If an implementation contradicts the business protocol, the implementation must be fixed. Business law must not be weakened.
Business Quote Authority
Business Quote is the canonical commercial authority of a capsule.
Business Quote is created exactly once after PREPARED.
Business Quote becomes immutable immediately after creation.
Payment Authorization consumes Business Quote.
Payment Verification consumes Business Quote.
Verification never creates Business Authority.
Business Quote is temporary Business Authority only.
Business Quote never becomes part of:
• PreparedCapsule
• Vault
• Manifest
Business Quote expires after the payment lifecycle completes.
Server Business Authority
Business Quote is established exclusively by the server.
The client may display creator pricing for user experience.
The client never establishes Business Authority.
The client never becomes the canonical commercial authority.
Business Authority exists only after successful server validation.
Server-created Business Quote is the sole commercial authority throughout the payment lifecycle.

Authority Domains
The system is divided into four independent, non-intersecting authorities.
Ciphertext Authority

chunkMetadata (core fields: chunkId, mediaId, index, size)
encryptedPayload
vaultSha256
saltBase
capsuleId
recipientSecret
creatorAuthority

Open Authority

openAt
heartbeatInterval
heartbeat records
Trusted Time
resolveEffectiveOpenAt()

Business Authority

capacity calculation
creator pricing
creator payment
future treasury governance settlement
storage settlement

Storage Authority

Chunk Pointer Registry
storage pointers
backend providers

Authorities are isolated. A change in one authority cannot affect another. Violating isolation is a protocol error.

Note
The four Authority Domains defined above are the only protocol authority domains.
Terms such as Capability Authority, Manifest Authority, Recipient Authority, Creator Authority, and Heartbeat Authority describe functional authority within specific protocol mechanisms.
They are not independent Authority Domains and do not extend the canonical authority-domain model.

Runtime Layer
For the purposes of this specification, "prepared ciphertext" refers to encrypted media chunks and the encrypted vault that exist only as temporary operational state before sealing completes.
The Runtime Layer is not an authority.
It exists solely to execute the protocol safely within the client environment.
The Runtime Layer never establishes, modifies, or replaces protocol authority.
It does not participate in:

Ciphertext Authority
Open Authority
Business Authority
Storage Authority

Its responsibilities include temporary operational state required to execute the protocol, including:

prepared ciphertext retention before Upload
upload scheduling
upload progress
temporary local runtime storage
temporary reconstruction buffers during OPENED
runtime cleanup

Runtime implementations may execute multiple concurrent uploads in order to improve network utilization. The number of concurrent uploads is implementation-defined. Runtime implementations should adapt concurrency to the capabilities of the current device and browser.
Runtime Ownership
After successful transfer of a prepared chunk into the Runtime Layer, the Runtime becomes the sole temporary owner of the prepared ciphertext until Upload verification completes.
After successful transfer into the Runtime Layer, any previous operational owner of the prepared ciphertext shall immediately release its ownership.
Runtime ownership never implies protocol authority.
Runtime never owns plaintext.
Runtime never stores plaintext.
Runtime ownership applies exclusively to ciphertext.
Plaintext lifetime is governed by the Minimal Lifetime Principle and must end immediately after successful encryption or successful rendering.
The Runtime Layer must not:

modify ciphertext
regenerate keys
regenerate capabilities
modify Vault
modify Manifest
regenerate chunk identifiers

The Runtime Layer is implementation-defined.
Implementations may use any suitable local runtime storage mechanism provided that:

ciphertext continuity is preserved
no re-encryption is required
browser memory usage remains bounded
creator payment always precedes permanent storage settlement
runtime data is removed after successful Upload or cancellation

Runtime Session Lifetime
A Runtime instance is created before media preparation begins and remains valid until sealing either completes successfully or terminates with failure or cancellation.
A Runtime implementation may outlive individual UI components, route transitions, or intermediate workflow stages.
The concrete implementation of Runtime lifetime is implementation-defined.
The protocol requires only that temporary ciphertext continuity be preserved until Upload verification completes or the operation terminates.
Runtime Session Ownership
The protocol does not define which application component owns a Runtime session. Ownership is implementation-defined.
The only protocol requirement is that a single Runtime session preserve ciphertext continuity from the beginning of media preparation until Upload verification or operation termination.
Runtime Cleanup
Runtime implementations shall ensure cleanup after successful completion, cancellation, or unrecoverable failure. Runtime cleanup is an implementation responsibility and does not affect protocol authority.
Persistence of Runtime data is implementation-defined unless a Persistent Runtime implementation is present.
If Persistent Runtime is implemented, ciphertext continuity across browser restart, tab closure, page reload and session restoration shall be preserved until Upload verification completes or the operation terminates.
Persistent Runtime remains part of the Execution Layer and never becomes Protocol Authority.
The Runtime Layer is temporary.
It is never part of the protocol authority and never becomes part of the sealed capsule.

Final Protocol Summary
textCreator
↓
Build Capsule
↓
generateCapsuleId()
↓
generateRecipientSecret()
generateCreatorAuthority()
generateSaltBase()
↓
generateVaultKey()
↓
Prepare Media
↓
encryptChunk()
↓
Runtime Storage
↓
ChunkMetadata[]
↓
toVaultItems()
↓
prepareVault()
↓
vaultBytes
↓
prepareEncryptedCapsule()
↓
PreparedCapsule
↓
PREPARED
══════════════════════════
Ciphertext Authority Law
══════════════════════════
↓
Calculate Capacity
↓
Business Quote Creation
↓
Business Quote
↓
Payment Authorization
↓
Payment Verification
↓
PAID
↓
CapsuleHold
↓
Upload
↓
Storage Authority Established
↓
Verification
↓
Create Manifest
↓
Manifest Authority Established
↓
SEALED
↓
Trusted Time
↓
Confirm Presence Window Evaluation
↓
resolveEffectiveOpenAt()
↓
OPENABLE
↓
openCapsule()
↓
verifyVaultSize()
↓
verifyVaultSha256()
↓
generateVaultKey()
↓
decryptVault()
↓
validate Vault
↓
OPENED
↓
VaultRenderer
↓
Permanent Access
Capabilities (recipientSecret, creatorAuthority) are generated before prepareEncryptedCapsule() and before PREPARED — not after the Manifest. capsuleId is generated independently, on its own track, also before PREPARED. The Manifest is metadata; it does not generate authority.

Core Principles

No accounts
Capability-based access control
Ciphertext continuity
Creator pays once
Storage independence
Heartbeat governance (always active; availability depends on interval)
Trusted time source
Verify before decrypt
Streaming delivery
Streaming reconstruction
Bounded memory
Media failure isolation
Authority-preserving emergency runtime
Permanent availability


BOUNDED MEMORY LAW
During creation and opening, memory consumption must remain bounded.
The protocol must never require loading the entire capsule into memory.
Large capsules must be processed incrementally.
Neither PREPARED, Upload, OPENED, nor Emergency Runtime may require whole-capsule buffering.
Memory usage must not scale linearly with capsule size.
Browser memory limitations must not define the maximum capsule size.
Protocol limits and storage limits may constrain capsule size. Available RAM must not.
Neither creation preview nor opened media playback may require loading the complete media object into RAM.
Chunk processing, upload, download, and reconstruction are expected to operate incrementally.

STREAMING PREVIEW LAW
During capsule creation, media preview must operate incrementally.
Implementations must not require loading the entire media object into memory.
Whenever the platform permits, preview should use the browser's native streaming capabilities (File, Blob, MediaSource, Object URLs or equivalent).
Preview memory usage shall remain bounded independently of media size.
Preview uses creator source files only.
Preview never reads encrypted chunks from Runtime.
Preview is a user-interface concern only.
Preview does not participate in:

Ciphertext Authority
Open Authority
Business Authority
Storage Authority

Preview never modifies protocol state.

STREAMING UPLOAD LAW
During sealing, encrypted media shall be processed incrementally.
Each chunk shall be:

encrypted
stored in Runtime
read from Runtime
uploaded
verified
released from Runtime

The protocol must not require retaining the ciphertext of the complete media object before upload.
Multiple chunks may be uploaded concurrently, provided that:

ciphertext continuity is preserved
ChunkMetadata ordering remains canonical
browser memory remains bounded

Upload scheduling is implementation-defined.

STREAMING DOWNLOAD LAW
Downloading opened media shall be incremental.
The protocol must not require reconstructing the entire media object in memory before download begins.
Chunks may be downloaded, decrypted and written progressively.
Memory consumption shall remain bounded.

STREAMING RECONSTRUCTION LAW
Media reconstruction in OPENED state is incremental.
Chunks are downloaded, decrypted, and assembled progressively.
The protocol must not require downloading all chunks before rendering begins.
Whole-capsule buffering is forbidden.
Completed chunks may be released from memory after use.
Media playback shall begin as soon as sufficient decrypted data is available.
Large videos and audio files shall begin playback before the complete media object has been reconstructed whenever browser APIs permit.
Whenever equivalent platform capabilities exist, implementations shall prefer progressive rendering over complete reconstruction before rendering.
Rendering may begin before the complete media object is reconstructed.
Media rendering shall be progressive whenever the platform permits.
Emergency Runtime follows the same streaming reconstruction rules as the primary runtime.

STREAMING PLAYBACK LAW
During OPENED state, audio and video playback shall be progressive.
Playback must not require loading the complete media object into memory.
Whenever the browser platform permits, playback shall begin as soon as sufficient decrypted media data becomes available.
Playback buffers are implementation-defined and may be released after use.
Playback shall obey the Bounded Memory Law.
Emergency Runtime follows the same playback rules as the primary runtime.

DECRYPTED DATA LIFETIME LAW
Plaintext generated during OPENED reconstruction is temporary execution state.
Plaintext is never protocol authority.
Plaintext must not become persistent Runtime state.
Plaintext must not be retained beyond the minimum lifetime required for rendering or export.
Execution Layer shall release decrypted memory as soon as practical.

Payment Failure Law
If payment fails:

sealing forbidden

If storage settlement fails:

sealing forbidden

If upload verification fails:

sealing forbidden

All failures must remain fail-closed.
No capability issuance permitted after failed settlement.
No upload token may be issued after payment failure.
No Manifest may be created after settlement failure or upload verification failure.

Business Model
Creator pays first.
Creator payment is the prerequisite for any storage settlement.
AETERNA infrastructure must never fund storage before creator payment.
AETERNA infrastructure must never perform storage settlement before creator payment succeeds.
No protocol funds may be committed before creator payment.
Creator pricing independence
Internal Runtime implementation, chunk scheduling, upload strategy, storage provider behavior, and concurrency must not affect the creator pricing model. Creator pricing depends only on canonical business rules defined by the Business Authority.
Revenue is:
textcreator payment
minus
real storage settlement
minus
operating costs
Storage settlement is invisible to creators.

Revision History (carried forward, correctness confirmed)
✔ BOUNDED MEMORY LAW added...
✔ STREAMING RECONSTRUCTION LAW added...
... (все предыдущие пункты сохранены)
✔ rev6.3: Runtime Layer + Streaming Upload Law + Creator Experience Principle + pricing independence + Runtime Session Ownership.
✔ Добавлены STREAMING PREVIEW LAW, STREAMING DOWNLOAD LAW, Builder Independence Principle, Business Quote Authority и Server Business Authority.
✔ Унифицированы PreparedCapsule consumers, PAID description и Final Protocol Summary.
✔ Добавлены DECRYPTED DATA LIFETIME LAW, уточнения Runtime Ownership, Streaming Reconstruction, Builder Independence и Runtime Session Lifetime.
✔ Исправлен конфликт с Persistent Runtime. Заменены "should" → "shall" в Streaming Laws. Документ полностью согласован с текущей Runtime-архитектурой и Persistent Runtime Specification.
✔ v4.2 rev1: Heartbeat promoted to a full canonical specification ("Heartbeat Specification" section) covering purpose, the Heartbeat Window, Renewal Rules, interaction with Open Authority, and Emergency Runtime behavior. Expanded Heartbeat description in Core Entities. Updated Creator Path step to describe Presence availability rules. Added Heartbeat Window rule after Heartbeat Records. Added HEARTBEAT WINDOW stage to Capsule Lifecycle (conditional on heartbeatEnabled). Clarified Emergency Runtime's Confirm Presence exposure. Split "Trusted Time + Heartbeat" into "Trusted Time" → "Heartbeat Window Evaluation" → resolveEffectiveOpenAt() in the Final Protocol Summary. No changes to Ciphertext Authority, Vault, Manifest, PreparedCapsule, Runtime, Storage, Business Layer, Payment, Streaming, Crypto, or Capability Authority sections.
✔ v4.2 rev2 (wording clarifications, no protocol change): "Interaction with Open Authority" now states explicitly that Heartbeat records never modify the originally sealed openAt value and only influence the effective opening time computed by Open Authority. Capsule Lifecycle diagram now labels HEARTBEAT WINDOW as "(optional, only when Heartbeat is enabled)" directly under the stage name for clarity.
✔ v4.2 rev3 (terminology rule, no protocol change): established that this document (Complete System Logic) uses the canonical protocol term "Heartbeat" exclusively; the user-facing label "Confirm Presence" is glossed once at first mention ("Heartbeat (user-facing: Confirm Presence)") and is otherwise reserved for the Emergency Runtime action/status distinction ("Heartbeat status" vs "Confirm Presence" as the button label), which is intentionally left unchanged. Renewal Rule examples now say "Heartbeat confirmation" instead of "Confirm Presence." The Human-readable Product Description remains the sole document using "Confirm Presence" as its primary term. Note: this revision does NOT make Heartbeat mandatory or remove the heartbeatEnabled opt-in — that would be a protocol-level change and was not applied pending confirmation.
✔ v4.3 (protocol change, confirmed by request): Heartbeat promoted from an optional per-capsule feature to a canonical capability present on every capsule. Removed heartbeatEnabled from the Manifest and from the Open Authority field list — heartbeatInterval remains. Core Entities and Heartbeat Specification now state that Heartbeat is always active and is never enabled or disabled per capsule; only the timing of confirmation availability varies, per the Heartbeat Window rules. Creator Path no longer contains a separate "(Optional) Enables Presence" step. Capsule Lifecycle stage renamed from HEARTBEAT WINDOW to CONFIRM PRESENCE WINDOW, present unconditionally for every capsule (the prior "if Heartbeat is disabled, skip to OPENABLE" branch is removed). Final Protocol Summary stage renamed from "Heartbeat Window Evaluation" to "Confirm Presence Window Evaluation." No changes to Ciphertext Authority, Storage Authority, Runtime, Business Layer, or cryptography.
✔ v4.3.1 (final polish, no protocol change): Creator Path wording shortened — since Heartbeat is glossed once at first mention ("Heartbeat (user-facing: Confirm Presence)"), the redundant "(Confirm Presence)" suffix was dropped from the two availability sentences. "Heartbeat-only Link" renamed to "Creator Authority Link," since a Heartbeat-specific link name no longer fits a model where Heartbeat is always on. Corresponding wording and grammatical-agreement fixes were made in the Human-readable Product Description (see its own revision note).
✔ v4.3.1 rev1 (terminology clarification, no protocol change): Added a Note directly after the Authority Domains section stating that the four listed Authority Domains (Ciphertext, Open, Business, Storage) are the only protocol authority domains, and that terms such as Capability Authority, Manifest Authority, Recipient Authority, Creator Authority, and Heartbeat Authority describe functional authority within specific mechanisms rather than independent Authority Domains. No architectural change; resolves ambiguity flagged during Chief Architect review.
This document defines all canonical operational rules of AETERNA from creation to opening, including capability authority, liveness monitoring authority, billing authority, storage authority, emergency runtime compatibility, cryptographic continuity, and long-term access guarantees.