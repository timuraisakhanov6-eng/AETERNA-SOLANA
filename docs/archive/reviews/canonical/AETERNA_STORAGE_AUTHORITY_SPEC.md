# Purpose

This document defines the canonical Storage Authority of the AETERNA Protocol.

Its purpose is to establish the ownership, responsibilities, boundaries, and lifecycle of Storage Authority and the Chunk Pointer Registry.

This document defines:

- what Storage Authority owns;
- what Storage Authority is responsible for;
- how the Chunk Pointer Registry exists within Storage Authority;
- how Runtime and Emergency Runtime obtain storage pointers;
- how Storage Authority interacts with other protocol authorities.

This document does not define implementation details.

It does not prescribe:

- programming languages;
- storage engines;
- databases;
- KV namespaces;
- HTTP endpoints;
- internal APIs;
- framework-specific implementations.

Those are implementation decisions and must preserve the canonical authority model defined here.

If any implementation conflicts with this document, this document has higher authority.

# Scope

This specification applies to the Storage Authority of the AETERNA Protocol.

It defines the canonical behavior of Storage Authority throughout the complete capsule lifecycle, including:

- chunk publication;
- storage pointer ownership;
- Chunk Pointer Registry creation;
- Chunk Pointer Registry persistence;
- Runtime pointer resolution;
- Emergency Runtime pointer resolution.

This specification governs only Storage Authority.

It does not define the behavior of:

- Manifest Authority;
- Vault Authority;
- Ciphertext Authority;
- Capability Authority;
- Business Authority;
- Open Authority.

Those authorities are defined by their own canonical specifications.

Storage Authority may interact with other authorities only through explicitly defined protocol boundaries.

Storage Authority MUST NOT assume responsibility for any authority that it does not own.

Likewise, no other authority may assume ownership of Storage Authority.

# Authority Definition

Storage Authority is the canonical protocol authority responsible for the publication, persistence, and resolution of immutable storage locations used by the AETERNA Protocol.

Storage Authority owns the operational relationship between immutable Chunk Identifiers and immutable Storage Pointers.

This relationship is represented by the Chunk Pointer Registry.

Storage Authority is the sole authority permitted to create, maintain, and resolve the Chunk Pointer Registry.

No other protocol authority owns, controls, or modifies this mapping.

Storage Authority exists independently of all other protocol authorities.

Its existence does not depend on:

- Manifest Authority;
- Vault Authority;
- Ciphertext Authority;
- Capability Authority;
- Business Authority;
- Open Authority.

Storage Authority operates only within its own authority boundary.

Other protocol authorities may consume information provided by Storage Authority only through explicitly defined protocol boundaries.

Storage Authority does not inherit authority from any other protocol component.

Likewise, no other authority inherits ownership of Storage Authority.

Storage Authority remains the sole canonical source of storage-location resolution throughout the entire protocol lifecycle.

# Storage Authority Responsibilities

Storage Authority is responsible exclusively for storage-location management within the AETERNA Protocol.

Its responsibilities are limited to the following canonical functions.

## Publication

Storage Authority publishes immutable encrypted protocol objects to the underlying storage infrastructure.

Successful publication produces immutable Storage Pointers.

Storage Authority does not create plaintext, ciphertext, Vaults, or Manifests.

It publishes only data that has already been prepared by the appropriate protocol layers.

---

## Chunk Pointer Registry

Storage Authority creates and maintains the Chunk Pointer Registry.

The Chunk Pointer Registry is the canonical operational mapping between:

- immutable Chunk Identifiers; and
- immutable Storage Pointers.

Storage Authority is solely responsible for the correctness and persistence of this mapping.

---

## Storage Resolution

Storage Authority resolves immutable Chunk Identifiers into Storage Pointers.

This resolution is performed whenever Runtime or Emergency Runtime requires access to encrypted chunk data.

Storage Authority does not participate in cryptographic operations after pointer resolution.

---

## Persistence

Storage Authority is responsible for preserving the canonical Chunk Pointer Registry.

The Registry remains persistent independently of Manifest Authority and independently of Runtime state.

Storage Authority determines how Registry persistence is implemented.

The persistence mechanism itself is an implementation detail and is outside the scope of this specification.

---

## Runtime Support

Storage Authority provides the canonical storage-location resolution service required by:

- Runtime;
- Emergency Runtime;
- future protocol runtimes operating under the canonical authority model.

Storage Authority provides storage pointers only.

It never provides cryptographic authority or decryption capability.

---

## Integrity

Storage Authority preserves the integrity of storage-location mappings.

Storage Authority MUST fail closed whenever:

- storage-location resolution cannot be completed;
- Registry integrity cannot be verified;
- Registry data is incomplete;
- Registry data is inconsistent.

Storage Authority MUST NEVER fabricate, infer, or substitute storage pointers.

Only canonical Registry data may be returned.

# What Storage Authority MUST NOT Do

Storage Authority owns only storage-location management.

It MUST NOT assume responsibilities belonging to any other protocol authority.

Storage Authority MUST NOT:

- create or modify Manifest Authority;
- create or modify Vault Authority;
- create or modify Ciphertext Authority;
- create or modify Capability Authority;
- create or modify Business Authority;
- create or modify Open Authority.

---

## Manifest Authority

Storage Authority MUST NOT define, modify, or validate Manifest contents.

Storage Authority MUST NOT determine:

- capsule identity;
- sealing metadata;
- opening time;
- protocol metadata;
- Manifest integrity fields.

Storage Authority MUST NOT extend the canonical Manifest schema.

---

## Vault Authority

Storage Authority MUST NOT inspect, interpret, or modify Vault contents.

Storage Authority treats Vault data as opaque encrypted payload.

Storage Authority does not understand Vault structure.

---

## Cryptography

Storage Authority MUST NOT:

- generate cryptographic keys;
- derive cryptographic keys;
- encrypt data;
- decrypt data;
- verify decrypted content.

Cryptographic operations belong exclusively to the protocol cryptographic layers.

---

## Runtime

Storage Authority MUST NOT perform Runtime operations.

Storage Authority MUST NOT:

- reconstruct files;
- stream media;
- render content;
- open capsules.

Its responsibility ends after canonical storage-pointer resolution.

---

## Business Logic

Storage Authority MUST NOT:

- calculate payments;
- validate purchases;
- issue capabilities;
- create upload permissions;
- make commercial decisions.

---

## Authority Separation

Storage Authority MUST NEVER become the owner of another protocol authority.

Likewise, no other authority may assume ownership of Storage Authority.

Authority boundaries are immutable protocol invariants.

Violation of authority boundaries constitutes a protocol violation.

# Chunk Pointer Registry

The Chunk Pointer Registry is the canonical operational data structure owned exclusively by Storage Authority.

Its sole purpose is to maintain the canonical mapping between immutable Chunk Identifiers and immutable Storage Pointers.

The Chunk Pointer Registry is the only canonical source of storage-location resolution within the AETERNA Protocol.

---

## Canonical Mapping

Each Registry entry represents exactly one relationship:

Chunk Identifier
↓

Storage Pointer

A Registry entry MUST NOT represent any other protocol information.

---

## Ownership

The Chunk Pointer Registry is owned exclusively by Storage Authority.

No other protocol authority owns any portion of the Registry.

Storage Authority is solely responsible for:

- creating Registry entries;
- validating Registry entries;
- maintaining Registry integrity;
- resolving Registry entries;
- preserving Registry persistence.

---

## Canonical Responsibility

The Chunk Pointer Registry is responsible only for storage-location mapping.

It does not define:

- capsule identity;
- Vault contents;
- Manifest metadata;
- cryptographic information;
- business information;
- protocol capabilities.

---

## Registry Independence

The Chunk Pointer Registry exists independently of all protocol authorities except Storage Authority.

The Registry is NOT part of:

- Manifest Authority;
- Vault Authority;
- Ciphertext Authority;
- Capability Authority;
- Business Authority;
- Open Authority.

The Registry remains an independent Storage Authority object throughout the entire protocol lifecycle.

---

## Canonical Resolution

Runtime and Emergency Runtime resolve encrypted chunk locations exclusively through the Chunk Pointer Registry.

Storage-location resolution follows this canonical sequence:

Chunk Identifier
↓

Chunk Pointer Registry

↓

Storage Pointer

↓

Encrypted Chunk Retrieval

The Registry performs only storage-location resolution.

It does not perform download, decryption, validation, reconstruction, or rendering.

---

## Immutability

Registry entries are immutable after successful publication.

Storage Authority MUST NEVER silently rewrite an existing Chunk Identifier mapping.

If a Registry entry cannot be resolved consistently, Storage Authority MUST fail closed.

---

## Canonical Authority

The Chunk Pointer Registry is the only canonical authority permitted to resolve immutable Chunk Identifiers into Storage Pointers.

Any alternative source of storage-location mapping constitutes a protocol violation.

# Registry Ownership

Ownership of the Chunk Pointer Registry belongs exclusively to Storage Authority.

Ownership is a protocol authority concept and is independent of implementation details.

Storage Authority is the only protocol authority permitted to:

- create Registry entries;
- publish Registry entries;
- persist Registry entries;
- validate Registry entries;
- resolve Registry entries.

No other protocol authority owns any part of the Chunk Pointer Registry.

---

## Manifest Authority

Manifest Authority MUST NOT own Registry data.

Manifest Authority MUST NOT create Registry entries.

Manifest Authority MUST NOT persist Registry entries.

Manifest Authority MUST NOT modify Registry entries.

Manifest Authority MUST NOT resolve Registry entries.

Manifest Authority MAY reference Storage Authority only through explicitly defined protocol boundaries.

---

## Vault Authority

Vault Authority MUST NOT own the Chunk Pointer Registry.

Vault Authority may contain immutable Chunk Identifiers required for media reconstruction.

Vault Authority MUST NEVER contain Storage Pointers.

---

## Runtime

Runtime does not own the Chunk Pointer Registry.

Runtime consumes Storage Authority services.

Runtime performs storage-location resolution exclusively through Storage Authority.

Runtime MUST NEVER become a source of Registry data.

---

## Emergency Runtime

Emergency Runtime follows the same ownership model as Runtime.

Emergency Runtime does not own Registry data.

Emergency Runtime resolves chunk locations through Storage Authority using the same canonical Registry.

---

## Implementation Independence

Ownership of the Chunk Pointer Registry is independent of implementation.

The implementation MAY use any persistence technology that preserves the canonical authority model.

Implementation details MUST NOT redefine ownership.

---

## Canonical Ownership Invariant

Throughout the protocol lifecycle there is exactly one owner of the Chunk Pointer Registry:

Storage Authority.

Any implementation that allows another authority to own, create, modify, or resolve Registry entries violates the canonical protocol architecture.

# Registry Lifecycle

The Chunk Pointer Registry follows a deterministic lifecycle within Storage Authority.

The lifecycle is independent of Manifest Authority and is completed before Manifest Authority is created.

Storage Authority is solely responsible for every stage of the Registry lifecycle.

---

## Stage 1 — Chunk Publication

Encrypted chunks are published through Storage Authority.

Successful publication produces immutable Storage Pointers.

Chunk publication does not create Manifest Authority.

---

## Stage 2 — Registry Entry Creation

After successful publication of an encrypted chunk, Storage Authority creates a Registry entry.

Each Registry entry establishes the canonical relationship between:

- immutable Chunk Identifier; and
- immutable Storage Pointer.

Storage Authority validates every Registry entry before persistence.

---

## Stage 3 — Registry Persistence

Validated Registry entries are persisted by Storage Authority.

Registry persistence is completed before Manifest Authority is created.

Successful Registry persistence establishes the canonical Storage Authority state required for subsequent protocol operations.

---

## Stage 4 — Manifest Creation

Only after successful Registry persistence may Manifest Authority be created.

Manifest Authority consumes the existence of Storage Authority.

Manifest Authority does not create, modify, or persist Registry data.

---

## Stage 5 — Runtime Resolution

During capsule opening, Runtime resolves immutable Chunk Identifiers through the Chunk Pointer Registry.

Storage Authority returns the corresponding immutable Storage Pointers.

Runtime uses the resolved Storage Pointers to retrieve encrypted chunk data.

---

## Stage 6 — Emergency Runtime Resolution

Emergency Runtime follows the same lifecycle as Runtime.

Emergency Runtime performs Chunk Pointer Registry resolution through Storage Authority before retrieving encrypted chunk data.

Emergency Runtime MUST NOT implement an alternative storage-location resolution mechanism.

---

## Lifecycle Completion

Once Registry persistence has completed successfully, Registry entries remain immutable for the lifetime of the published storage objects.

Storage Authority does not recreate, replace, or silently rewrite Registry entries after successful publication.

Any failure during Registry creation, validation, persistence, or resolution MUST terminate the operation using fail-closed behavior.

# Registry Creation

The Chunk Pointer Registry is created exclusively by Storage Authority.

Registry creation is part of the Storage Authority lifecycle and is completed before Manifest Authority is established.

The creation of the Registry is triggered by successful publication of immutable encrypted chunks.

Storage Authority is solely responsible for:

- validating Chunk Identifiers;
- validating Storage Pointers;
- creating Registry entries;
- establishing the canonical Chunk Identifier → Storage Pointer relationship.

No other protocol authority participates in Registry creation.

---

## Creation Boundary

Registry creation begins only after Storage Authority has successfully published encrypted chunk data.

Registry creation completes only after all Registry entries have been successfully validated and persisted.

Partial Registry creation MUST NOT be considered successful.

If Registry creation cannot be completed, Storage Authority MUST fail closed.

---

## Authority Ownership

Registry creation belongs exclusively to Storage Authority.

The following authorities MUST NOT create Registry entries:

- Manifest Authority;
- Vault Authority;
- Ciphertext Authority;
- Capability Authority;
- Business Authority;
- Open Authority;
- Runtime;
- Emergency Runtime.

---

## Manifest Independence

Manifest Authority MUST NEVER create the Chunk Pointer Registry.

Manifest Authority MUST NEVER construct Storage Pointer mappings.

Manifest Authority MUST NEVER persist Registry entries on behalf of Storage Authority.

Manifest creation may occur only after successful completion of Registry creation.

---

## Canonical Ordering

The canonical protocol sequence is:

Encrypted Chunk Publication

↓

Chunk Pointer Registry Creation

↓

Chunk Pointer Registry Validation

↓

Chunk Pointer Registry Persistence

↓

Manifest Creation

↓

Capsule Sealing

Any implementation that creates the Manifest before the Registry violates the canonical authority model.

---

## Failure Model

If Registry creation fails for any reason:

- Registry persistence MUST NOT occur;
- Manifest creation MUST NOT occur;
- Capsule sealing MUST NOT continue.

The protocol MUST terminate using fail-closed behavior.

No partial Registry state may be treated as canonical.

# Registry Persistence

The Chunk Pointer Registry is persisted exclusively by Storage Authority.

Registry persistence is the canonical act of establishing the permanent storage-location mapping required for future Runtime resolution.

The persistence mechanism is implementation-defined.

This specification does not require any particular storage technology.

---

## Persistence Responsibility

Storage Authority is solely responsible for persisting Registry entries.

No other protocol authority may persist Registry data on behalf of Storage Authority.

Registry persistence MUST NOT depend upon:

- Manifest Authority;
- Vault Authority;
- Runtime;
- Emergency Runtime;
- Business Authority;
- Capability Authority.

---

## Persistence Boundary

Registry persistence is completed before Manifest Authority is created.

Manifest Authority consumes the existence of a successfully persisted Registry.

Manifest Authority does not establish Registry persistence.

---

## Persistence Integrity

Registry persistence MUST preserve:

- Chunk Identifier integrity;
- Storage Pointer integrity;
- Registry entry completeness;
- Registry consistency.

Storage Authority MUST verify Registry integrity before persistence is considered complete.

---

## Atomicity

Registry persistence MUST be atomic.

A Registry is either:

- completely persisted; or
- not persisted.

Partial Registry persistence MUST NOT be treated as canonical.

---

## Failure Model

If Registry persistence fails:

- Registry creation MUST be considered unsuccessful;
- Manifest Authority MUST NOT be created;
- Capsule sealing MUST terminate;
- Runtime MUST NOT receive incomplete Registry data.

The protocol MUST fail closed.

---

## Immutability

After successful persistence, Registry entries become immutable.

Storage Authority MUST NOT silently replace, rewrite, or reassign existing Registry mappings.

Any modification to an immutable Registry entry constitutes a protocol violation.

---

## Canonical Invariant

Throughout the protocol lifecycle there exists exactly one canonical persisted Chunk Pointer Registry for each successfully published capsule.

Storage Authority remains the sole owner of that Registry for its entire lifetime.

# Registry Read Path

The Chunk Pointer Registry is accessed exclusively through Storage Authority.

Storage Authority provides the canonical storage-location resolution service for all protocol runtimes.

No protocol component may bypass Storage Authority when resolving storage locations.

---

## Runtime Resolution

Runtime resolves immutable Chunk Identifiers through Storage Authority.

For each immutable Chunk Identifier:

Chunk Identifier

↓

Storage Authority

↓

Chunk Pointer Registry

↓

Storage Pointer

↓

Encrypted Chunk Retrieval

Storage Authority returns only the canonical Storage Pointer associated with the requested Chunk Identifier.

---

## Emergency Runtime Resolution

Emergency Runtime follows the identical canonical resolution process.

Emergency Runtime resolves storage locations exclusively through Storage Authority.

Emergency Runtime MUST NOT implement an alternative storage-location resolution mechanism.

---

## Resolution Scope

Storage Authority resolves only immutable storage-location mappings.

Storage Authority does not:

- download encrypted chunks;
- decrypt encrypted chunks;
- reconstruct media;
- render media;
- interpret Vault contents.

Those responsibilities belong to other protocol authorities.

---

## Resolution Integrity

Storage Authority MUST validate Registry integrity before returning Storage Pointers.

If Registry integrity cannot be established, Storage Authority MUST terminate the resolution process using fail-closed behavior.

Storage Authority MUST NEVER:

- fabricate Storage Pointers;
- infer missing Registry entries;
- substitute Registry entries;
- return partially resolved mappings.

---

## Canonical Consumer

The Chunk Pointer Registry may be consumed only through Storage Authority.

Protocol components consume the Registry as a service rather than as a persistent object.

Consumers are not permitted to modify Registry contents.

---

## Implementation Independence

The mechanism used to expose Registry resolution is implementation-defined.

This specification does not prescribe:

- APIs;
- endpoints;
- transports;
- storage engines;
- runtime frameworks.

Any implementation is acceptable provided it preserves the canonical authority model and the fail-closed behavior defined by this specification.

---

## Canonical Invariant

Throughout the protocol lifecycle there exists exactly one canonical path for storage-location resolution:

Chunk Identifier

↓

Storage Authority

↓

Chunk Pointer Registry

↓

Storage Pointer

↓

Encrypted Chunk Retrieval

Any alternative resolution path constitutes a protocol violation.

# Registry Update Rules

The Chunk Pointer Registry is append-only.

Storage Authority MAY create new Registry entries only during the publication of previously unpublished immutable encrypted chunks.

Storage Authority MUST NOT modify existing Registry entries after successful persistence.

---

## Existing Entries

Once a Registry entry has been successfully persisted, the relationship between:

- Chunk Identifier; and
- Storage Pointer

is immutable.

Storage Authority MUST NEVER:

- replace a Storage Pointer;
- replace a Chunk Identifier;
- redirect a Registry entry;
- overwrite an existing mapping.

---

## New Entries

Storage Authority MAY append new Registry entries only when publishing new immutable encrypted chunks that do not yet exist in the Registry.

Appending new entries MUST NOT alter any previously persisted Registry entry.

---

## Duplicate Entries

If Storage Authority detects an attempt to create a Registry entry for an already registered Chunk Identifier, the operation MUST fail closed.

Duplicate Registry entries MUST NEVER be silently accepted.

---

## Inconsistent Entries

If Storage Authority detects conflicting mappings for the same Chunk Identifier, the Registry MUST be considered invalid.

Storage Authority MUST terminate the operation using fail-closed behavior.

---

## Runtime Behavior

Runtime and Emergency Runtime MUST treat the Registry as immutable.

Neither Runtime nor Emergency Runtime may modify Registry contents.

They consume Registry data only through canonical Storage Authority resolution.

---

## Manifest Independence

Updating the Chunk Pointer Registry MUST NEVER require modification of Manifest Authority.

Likewise, changes to Manifest Authority MUST NEVER modify the Registry.

Both authorities evolve independently.

---

## Canonical Invariant

The Chunk Pointer Registry represents immutable storage-location mappings.

After successful persistence, Registry mappings remain stable for the lifetime of the corresponding immutable storage objects.

Any implementation that permits modification of existing Registry mappings violates the canonical protocol.

# Registry Immutability

The Chunk Pointer Registry is immutable after successful persistence.

Immutability is a protocol invariant.

It is independent of implementation technology, storage engine, transport, or runtime environment.

---

## Immutable Mapping

Each Registry entry permanently represents one canonical relationship:

Chunk Identifier

↓

Storage Pointer

Once established, this relationship MUST remain unchanged for the lifetime of the corresponding immutable storage object.

---

## Registry Integrity

Registry immutability guarantees deterministic storage resolution.

The same Chunk Identifier MUST always resolve to the same Storage Pointer.

Storage Authority MUST NOT introduce non-deterministic resolution behavior.

---

## Authority Protection

Immutability protects the authority boundary of Storage Authority.

No external protocol authority may:

- modify Registry entries;
- replace Registry entries;
- remove Registry entries;
- redirect Registry entries.

Only Storage Authority owns Registry persistence, and persistence itself produces immutable state.

---

## Runtime Assumption

Runtime and Emergency Runtime may safely assume that successfully resolved Registry mappings remain stable.

Neither runtime is required to detect or compensate for Registry mutations.

If Registry integrity cannot be verified, Storage Authority MUST fail closed.

---

## Recovery

Recovery mechanisms MUST preserve Registry immutability.

Recovery MAY reconstruct Registry availability.

Recovery MUST NOT reconstruct alternative Registry mappings.

Recovered Registry state MUST be identical to the canonical persisted Registry.

---

## Protocol Consistency

Manifest Authority,

Vault Authority,

Ciphertext Authority,

Capability Authority,

Business Authority,

and Open Authority

all rely upon the immutability of Storage Authority.

Violation of Registry immutability invalidates the canonical storage-location model of the protocol.

---

## Canonical Invariant

The Chunk Pointer Registry is immutable.

The canonical mapping between Chunk Identifiers and Storage Pointers never changes after successful persistence.

This invariant remains true throughout the entire protocol lifecycle.

# Authority Boundaries

Storage Authority operates within a strictly defined authority boundary.

Authority boundaries are immutable protocol invariants.

Each protocol authority owns only its own canonical state and MUST NOT assume responsibility for any other authority.

---

## Storage Authority

Storage Authority owns:

- encrypted storage publication;
- immutable Storage Pointers;
- Chunk Pointer Registry;
- storage-location resolution.

Storage Authority does not own protocol metadata.

---

## Manifest Authority

Manifest Authority owns:

- capsule identity;
- sealing metadata;
- opening metadata;
- Vault discovery;
- canonical Manifest integrity metadata.

Manifest Authority MUST NOT own:

- Storage Pointers;
- Chunk Pointer Registry;
- storage-location mappings.

Manifest Authority consumes the existence of Storage Authority but does not participate in its implementation.

---

## Vault Authority

Vault Authority owns:

- immutable Vault structure;
- capsule contents;
- immutable Chunk Identifiers;
- object metadata required for reconstruction.

Vault Authority MUST NOT own:

- Storage Pointers;
- Chunk Pointer Registry;
- publication metadata.

Vault Authority identifies chunks.

Storage Authority resolves their locations.

---

## Ciphertext Authority

Ciphertext Authority owns only encrypted payload.

Ciphertext Authority has no knowledge of:

- Manifest Authority;
- Storage Authority;
- Chunk Pointer Registry;
- Runtime.

Ciphertext Authority is opaque to every authority except the cryptographic layers that operate upon it.

---

## Capability Authority

Capability Authority owns protocol capabilities.

Capability Authority MUST NOT own storage-location metadata.

Capabilities grant protocol permissions.

They do not define storage resolution.

---

## Business Authority

Business Authority owns commercial protocol state.

Business Authority MUST NOT own:

- storage metadata;
- Manifest metadata;
- Vault metadata;
- Registry metadata.

Commercial state remains independent of storage-location management.

---

## Open Authority

Open Authority owns the protocol rules governing capsule opening.

Open Authority determines:

- whether opening is permitted;
- when opening is permitted;
- under which protocol conditions opening is permitted.

Open Authority MUST NOT resolve storage locations.

Open Authority consumes Storage Authority only after successful authorization.

---

## Runtime

Runtime consumes multiple protocol authorities.

Runtime does not own any protocol authority.

Runtime coordinates:

- Manifest Authority;
- Vault Authority;
- Storage Authority;
- Open Authority.

Runtime MUST NOT redefine authority ownership.

---

## Emergency Runtime

Emergency Runtime follows the identical authority model.

Emergency Runtime consumes Storage Authority through the same canonical Registry resolution process.

Emergency Runtime MUST NOT introduce an alternative authority boundary.

---

## Canonical Authority Rule

Every protocol authority owns exactly one responsibility domain.

No authority may assume ownership of another authority.

No implementation detail may weaken, merge, or redefine canonical authority boundaries.

Violation of authority boundaries constitutes a protocol violation.

# Runtime Flow

The Runtime consumes Storage Authority as part of the canonical capsule opening sequence.

Runtime does not own Storage Authority.

Runtime requests storage-location resolution only after the protocol has determined that capsule opening is permitted.

Storage Authority performs storage-location resolution independently.

---

## Canonical Runtime Sequence

The canonical Runtime sequence is:

Trusted Time

↓

Open Authority Validation

↓

Manifest Authority

↓

Vault Authority

↓

Storage Authority

↓

Chunk Pointer Registry Resolution

↓

Encrypted Chunk Retrieval

↓

Chunk Decryption

↓

Media Reconstruction

↓

Runtime Presentation

Each stage is completed before the next stage begins.

No stage may bypass or replace another canonical authority.

---

## Storage Resolution

After Vault Authority provides immutable Chunk Identifiers, Runtime requests Storage Authority to resolve those identifiers.

Storage Authority returns the canonical Storage Pointer for each Chunk Identifier.

Runtime uses only the resolved Storage Pointers for encrypted chunk retrieval.

Runtime MUST NOT construct Storage Pointers independently.

---

## Authority Consumption

Runtime consumes Storage Authority through canonical protocol boundaries.

Runtime MUST NOT:

- own Registry data;
- persist Registry data;
- modify Registry data;
- replace Registry entries.

Runtime remains a consumer of Storage Authority throughout the entire capsule lifecycle.

---

## Failure Handling

If Storage Authority cannot resolve the requested Chunk Identifiers, Runtime MUST terminate the operation.

Runtime MUST NOT:

- infer missing Storage Pointers;
- fabricate Registry entries;
- substitute alternative storage locations;
- continue using partial Registry data.

The protocol MUST fail closed.

---

## Deterministic Behavior

For the same canonical protocol state, Runtime MUST obtain identical Storage Pointer resolution results.

Runtime MUST NOT introduce non-deterministic storage resolution.

---

## Canonical Runtime Invariant

Runtime performs storage-location resolution exclusively through Storage Authority.

Runtime never becomes the owner of Storage Authority.

Storage Authority remains the sole canonical source of storage-location resolution throughout Runtime execution.

# Emergency Runtime Flow

Emergency Runtime is a canonical protocol runtime intended solely for protocol recovery.

Emergency Runtime follows the same Storage Authority model as the primary Runtime.

Storage Authority remains the sole authority responsible for storage-location resolution.

Emergency Runtime MUST NOT introduce an alternative storage-location resolution mechanism.

---

## Canonical Emergency Runtime Sequence

The canonical Emergency Runtime sequence is:

Manifest Authority

↓

Vault Authority

↓

Storage Authority

↓

Chunk Pointer Registry Resolution

↓

Encrypted Chunk Retrieval

↓

Chunk Decryption

↓

Media Reconstruction

↓

Emergency Runtime Presentation

The sequence remains identical to the primary Runtime after Manifest and Vault resolution.

---

## Storage Resolution

Emergency Runtime resolves immutable Chunk Identifiers exclusively through Storage Authority.

For every Chunk Identifier:

Chunk Identifier

↓

Storage Authority

↓

Chunk Pointer Registry

↓

Storage Pointer

↓

Encrypted Chunk Retrieval

Emergency Runtime MUST NOT resolve storage locations independently.

---

## Authority Consumption

Emergency Runtime consumes Storage Authority.

Emergency Runtime does not own:

- Storage Authority;
- Chunk Pointer Registry;
- Storage Pointers;
- Registry persistence.

Emergency Runtime remains a consumer throughout the entire recovery process.

---

## Failure Handling

If Storage Authority cannot resolve the required Chunk Identifiers, Emergency Runtime MUST terminate the recovery process.

Emergency Runtime MUST NOT:

- fabricate Storage Pointers;
- infer Registry entries;
- substitute storage locations;
- continue using incomplete Registry data.

The protocol MUST fail closed.

---

## Recovery Consistency

Emergency Runtime MUST produce the same storage-location resolution results as the primary Runtime when operating on the same canonical protocol state.

Recovery behavior MUST remain deterministic.

---

## Canonical Emergency Runtime Invariant

Emergency Runtime uses the identical Chunk Pointer Registry owned by Storage Authority.

There is exactly one canonical storage-location resolution model within the protocol.

Primary Runtime and Emergency Runtime consume the same Storage Authority.

No alternative Registry or recovery-specific storage-resolution mechanism may exist.

# Failure Model

Storage Authority follows the canonical fail-closed model of the AETERNA Protocol.

Whenever Storage Authority cannot establish complete confidence in the correctness of storage-location resolution, the operation MUST terminate.

Storage Authority MUST NEVER continue execution using uncertain, inferred, or partially validated Registry data.

---

## Registry Creation Failure

If Storage Authority cannot successfully create the Chunk Pointer Registry:

- Registry persistence MUST NOT occur;
- Manifest Authority MUST NOT be created;
- Capsule sealing MUST terminate.

No partial Registry state may become canonical.

---

## Registry Persistence Failure

If Registry persistence cannot be completed successfully:

- Registry creation MUST be considered unsuccessful;
- Manifest creation MUST NOT continue;
- Capsule sealing MUST terminate.

Partial persistence MUST NOT be accepted.

---

## Registry Resolution Failure

If Storage Authority cannot resolve one or more Chunk Identifiers:

- Runtime MUST terminate;
- Emergency Runtime MUST terminate;
- encrypted chunk retrieval MUST NOT continue.

Storage Authority MUST NEVER fabricate missing Storage Pointers.

---

## Registry Integrity Failure

If Registry integrity cannot be verified:

- Registry data MUST be rejected;
- Storage-location resolution MUST terminate;
- Runtime MUST fail closed.

Storage Authority MUST NEVER attempt automatic repair by inference.

---

## Inconsistent Registry State

If conflicting Registry entries are detected:

- Registry MUST be considered invalid;
- Runtime MUST terminate;
- Emergency Runtime MUST terminate.

Conflicting mappings MUST NEVER be resolved by choosing one arbitrarily.

---

## Missing Registry Data

If required Registry entries are unavailable:

Storage Authority MUST terminate the operation.

Storage Authority MUST NEVER:

- generate placeholder entries;
- fabricate Storage Pointers;
- ignore missing mappings;
- continue with partial Registry data.

---

## Runtime Failure

Storage Authority failures propagate to Runtime.

Runtime MUST NOT continue media reconstruction after Storage Authority failure.

Media reconstruction MUST occur only after successful canonical storage-location resolution.

---

## Emergency Runtime Failure

Emergency Runtime follows the identical failure model.

Emergency Runtime MUST NOT implement recovery behavior that weakens Storage Authority guarantees.

Emergency Runtime MUST fail closed under the same conditions as the primary Runtime.

---

## Canonical Failure Invariant

Storage Authority MUST NEVER:

- guess;
- infer;
- substitute;
- fabricate;
- silently recover;
- silently continue.

When canonical storage-location resolution cannot be completed with certainty, the protocol MUST terminate using fail-closed behavior.

# Security Model

Storage Authority follows the canonical security model of the AETERNA Protocol.

Its responsibility is limited to storage-location management.

Storage Authority never acquires cryptographic authority, protocol authority, or user authority.

---

## Principle of Least Authority

Storage Authority possesses only the minimum authority required to perform storage-location management.

Storage Authority owns:

- Storage Pointer publication;
- Chunk Pointer Registry;
- storage-location resolution.

Storage Authority owns nothing else.

---

## Cryptographic Separation

Storage Authority is cryptographically independent.

Storage Authority MUST NEVER:

- derive cryptographic keys;
- store cryptographic keys;
- generate cryptographic keys;
- encrypt data;
- decrypt data;
- inspect plaintext.

Storage Authority operates exclusively on storage metadata.

---

## Manifest Separation

Storage Authority is independent of Manifest Authority.

Storage Authority MUST NOT:

- create Manifest metadata;
- modify Manifest metadata;
- validate Manifest metadata;
- extend the Manifest schema.

Manifest Authority remains the sole owner of Manifest state.

---

## Vault Separation

Storage Authority treats Vault contents as opaque.

Storage Authority MUST NOT:

- interpret Vault contents;
- modify Vault contents;
- reconstruct Vault objects.

Vault Authority remains solely responsible for Vault semantics.

---

## Runtime Separation

Storage Authority provides storage-location resolution only.

Runtime remains responsible for:

- encrypted chunk retrieval;
- decryption;
- reconstruction;
- presentation.

Storage Authority never performs Runtime operations.

---

## Capability Separation

Storage Authority MUST NOT issue protocol capabilities.

Storage Authority MUST NOT grant access permissions.

Capability Authority remains independent.

---

## Business Separation

Storage Authority has no knowledge of:

- payments;
- subscriptions;
- billing;
- pricing;
- commercial state.

Business Authority remains completely isolated.

---

## Information Exposure

Storage Authority exposes only the information required for canonical storage-location resolution.

Storage Authority MUST NEVER expose:

- cryptographic secrets;
- protocol capabilities;
- business metadata;
- user metadata;
- Vault contents.

---

## Deterministic Security

For the same canonical protocol state, Storage Authority MUST produce identical storage-location resolution results.

Security decisions MUST NOT depend on:

- implementation details;
- infrastructure;
- runtime environment;
- storage provider.

---

## Canonical Security Invariant

Storage Authority exists solely to provide secure, deterministic, fail-closed storage-location resolution.

Its authority is intentionally limited.

Its security model is based on strict separation of responsibilities and the principle of least authority.

Any implementation that expands the authority of Storage Authority beyond this specification violates the canonical protocol architecture.

# Canonical Invariants

The following invariants define the immutable behavior of Storage Authority within the AETERNA Protocol.

These invariants are protocol rules.

They are independent of implementation technology and MUST remain true for every compliant implementation.

---

## Invariant 1 — Single Authority

There is exactly one Storage Authority.

There is exactly one Chunk Pointer Registry owned by Storage Authority.

No alternative Storage Authority may exist.

---

## Invariant 2 — Exclusive Ownership

Storage Authority is the sole owner of the Chunk Pointer Registry.

No other protocol authority may:

- create Registry entries;
- persist Registry entries;
- modify Registry entries;
- resolve Registry entries.

---

## Invariant 3 — Independent Authority

Storage Authority is independent of:

- Manifest Authority;
- Vault Authority;
- Ciphertext Authority;
- Capability Authority;
- Business Authority;
- Open Authority.

No protocol authority may absorb or redefine Storage Authority.

---

## Invariant 4 — Independent Persistence

The Chunk Pointer Registry is persisted independently of Manifest Authority.

Manifest Authority MUST NOT become the persistence mechanism for Storage Authority.

Storage Authority owns its own canonical persistent state.

---

## Invariant 5 — Canonical Resolution

Storage-location resolution always follows the same canonical path:

Chunk Identifier

↓

Storage Authority

↓

Chunk Pointer Registry

↓

Storage Pointer

↓

Encrypted Chunk Retrieval

No alternative resolution path may exist.

---

## Invariant 6 — Runtime Independence

Runtime does not own Storage Authority.

Runtime consumes Storage Authority.

Runtime MUST NEVER become the source of storage-location mappings.

---

## Invariant 7 — Emergency Runtime Consistency

Emergency Runtime follows the identical Storage Authority model as the primary Runtime.

Both runtimes consume the same Chunk Pointer Registry.

No recovery-specific Registry may exist.

---

## Invariant 8 — Immutability

Registry entries become immutable after successful persistence.

Existing Registry mappings MUST NEVER be silently modified.

---

## Invariant 9 — Determinism

Given the same canonical protocol state, Storage Authority MUST always produce identical storage-location resolution.

Resolution MUST NOT depend upon:

- infrastructure;
- implementation;
- storage backend;
- deployment environment.

---

## Invariant 10 — Fail Closed

Storage Authority MUST terminate whenever canonical storage-location resolution cannot be completed with certainty.

Storage Authority MUST NEVER:

- infer;
- fabricate;
- substitute;
- silently repair;
- silently continue.

---

## Invariant 11 — Least Authority

Storage Authority possesses only the authority required to:

- publish storage;
- persist Registry entries;
- resolve storage locations.

Storage Authority MUST NOT assume responsibilities belonging to any other protocol authority.

---

## Invariant 12 — Protocol Stability

Future implementations MAY change:

- storage technologies;
- storage providers;
- transport mechanisms;
- runtime environments.

Future implementations MUST NOT change:

- Storage Authority ownership;
- Chunk Pointer Registry ownership;
- authority boundaries;
- canonical storage-location resolution;
- fail-closed behavior.

These invariants are permanent protocol guarantees.

# Interaction With Other Authorities

Storage Authority operates as an independent protocol authority.

Interaction with other authorities occurs only through explicitly defined protocol boundaries.

No interaction transfers authority ownership.

---

## Manifest Authority

Storage Authority interacts with Manifest Authority only after successful Registry persistence.

Manifest Authority consumes the existence of Storage Authority.

Storage Authority does not expose its internal Registry state to Manifest Authority.

Manifest Authority does not modify Storage Authority.

---

## Vault Authority

Vault Authority provides immutable Chunk Identifiers.

Storage Authority resolves those identifiers into immutable Storage Pointers.

Vault Authority never owns Storage Pointers.

Storage Authority never owns Vault contents.

The interaction is unidirectional.

---

## Ciphertext Authority

Ciphertext Authority provides immutable encrypted payload.

Storage Authority publishes encrypted payload to persistent storage.

After publication, Ciphertext Authority and Storage Authority operate independently.

Neither authority modifies the state of the other.

---

## Capability Authority

Capability Authority authorizes protocol operations.

Storage Authority performs storage operations only after receiving valid protocol authorization.

Storage Authority does not issue capabilities.

Capability Authority does not participate in storage-location resolution.

---

## Business Authority

Business Authority determines commercial authorization.

Storage Authority remains independent of commercial state.

Business Authority never participates in Registry creation, Registry persistence, or Registry resolution.

---

## Open Authority

Open Authority determines whether capsule opening is permitted.

After successful authorization, Runtime may request Storage Authority to resolve storage locations.

Storage Authority does not determine whether opening is allowed.

---

## Runtime

Runtime coordinates protocol authorities.

Runtime requests services from Storage Authority.

Runtime never owns Storage Authority.

Storage Authority never owns Runtime state.

---

## Emergency Runtime

Emergency Runtime interacts with Storage Authority through the same canonical protocol boundary as the primary Runtime.

Emergency Runtime does not establish an alternative interaction model.

---

## Interaction Principles

All protocol authority interactions follow these rules:

- each authority owns only its own state;
- authority ownership is never transferred;
- authorities communicate only through canonical protocol boundaries;
- one authority may consume another authority's services without acquiring ownership.

These interaction principles are immutable protocol invariants.

# Storage Migration

Storage Authority MUST support storage-provider migration without requiring modification of canonical capsule content.

Storage migration operates only on the Chunk Pointer Registry.

---

## Migration Principle

A storage migration changes the operational mapping:

Chunk Identifier

↓

Storage Pointer

without changing the canonical Chunk Identifier.

Chunk Identifiers remain the canonical content references.

Storage Pointers remain operational storage metadata.

---

## What Migration MUST Preserve

Storage migration MUST preserve:

- encrypted ciphertext;
- Chunk Identifiers;
- Vault structure;
- recipient access;
- creator access;
- Manifest integrity;
- Emergency Runtime compatibility.

---

## What Migration MAY Change

Storage migration MAY update:

- storage-provider pointers;
- Chunk Pointer Registry mappings.

Migration MUST NOT require:

- re-encryption;
- Vault modification;
- Manifest modification;
- capability regeneration;
- modification of vaultSha256;
- regeneration of Chunk Identifiers.

---

## Authority Boundary

Only Storage Authority may update Chunk Pointer Registry mappings.

Manifest Authority MUST NOT be modified as part of storage migration.

Vault Authority MUST NOT be modified as part of storage migration.

Ciphertext Authority MUST NOT be modified as part of storage migration.

---

## Canonical Migration Rule

Storage migration changes storage-location metadata only.

The canonical content identified by the Chunk Identifier remains unchanged.

Therefore:

Chunk Identifier

↓

same canonical content

↓

new Storage Pointer

is a valid Storage Authority migration.

---

## Runtime After Migration

Runtime resolves the current Storage Pointer through the Chunk Pointer Registry.

Runtime does not depend on a historical Storage Pointer.

Emergency Runtime uses the same Chunk Pointer Registry resolution process.

---

## Canonical Invariant

Changing the storage provider MUST NOT require changing the capsule's canonical content.

Only the Chunk Pointer Registry mapping may change.

# Operational Sequence

Storage Authority participates in the AETERNA protocol through a defined operational sequence.

The sequence separates storage publication, Chunk Pointer Registry management, Manifest creation, and Runtime resolution.

---

## Upload Sequence

During upload:

1. Encrypted chunk data is prepared by the appropriate runtime layer.
2. Storage Authority receives the encrypted payload through the Storage Adapter.
3. The storage provider publishes the encrypted payload.
4. A canonical Storage Pointer is returned.
5. The Chunk Pointer Registry records the relationship between the Chunk Identifier and the Storage Pointer.

The Registry entry belongs to Storage Authority.

The Manifest does not create or own this mapping.

---

## Seal Sequence

After successful storage publication and Registry establishment:

1. Storage Authority has established the storage location for the published encrypted data.
2. The sealing process creates Manifest Authority state.
3. Manifest Authority records canonical Manifest metadata.
4. `ext.vaultSha256` remains the canonical integrity extension.
5. Chunk Pointer Registry data is not incorporated into the Manifest Authority object.

The Registry already exists as Storage Authority state before Manifest Authority is finalized.

---

## Runtime Resolution Sequence

When Runtime opens media:

1. Runtime obtains the canonical Chunk Identifier.
2. Runtime requests storage-location resolution from Storage Authority.
3. Storage Authority resolves the Chunk Identifier through the Chunk Pointer Registry.
4. The corresponding Storage Pointer is returned.
5. Runtime requests the encrypted chunk using that Storage Pointer.
6. Runtime decrypts and reconstructs the media according to the canonical Runtime pipeline.

Runtime does not resolve storage locations from Manifest Authority.

---

## Emergency Runtime Sequence

Emergency Runtime follows the same Chunk Pointer Registry resolution model.

Emergency Runtime:

1. obtains the required Chunk Identifier;
2. requests Registry resolution;
3. receives the corresponding Storage Pointer;
4. retrieves the encrypted chunk;
5. continues the existing local decryption and reconstruction process.

Emergency Runtime does not create an alternative chunk-pointer authority.

---

## Storage Provider Migration Sequence

If the underlying storage provider changes:

1. The canonical Chunk Identifier remains unchanged.
2. The encrypted content remains unchanged.
3. Storage Authority establishes the new storage location.
4. Storage Authority updates the corresponding Registry mapping.
5. Runtime continues resolving the Chunk Identifier through Storage Authority.

The Manifest does not need to be rewritten solely because the Storage Pointer changes.

---

## Authority Sequence

The canonical authority sequence is:

Storage Authority

↓

Chunk Pointer Registry

↓

Manifest Authority

↓

Runtime resolution through Storage Authority

The sequence does not transfer ownership between authorities.

Each authority creates and maintains only its own canonical state.

---

## Operational Invariant

The physical storage provider is an implementation detail.

The canonical protocol dependency is:

Chunk Identifier

↓

Chunk Pointer Registry

↓

Storage Pointer

↓

Encrypted Chunk

Any implementation that bypasses the Chunk Pointer Registry and derives storage locations from Manifest Authority violates the Storage Authority model.

# Implementation Constraints

Storage Authority implementations MAY vary in infrastructure and storage technology.

Implementation choices MUST preserve the canonical authority model and MUST NOT change protocol behavior.

---

## Storage Backend Independence

The Chunk Pointer Registry MAY be implemented using an appropriate persistent storage mechanism.

The canonical protocol does not require a specific database, KV namespace, object store, or other infrastructure technology.

The selected implementation MUST provide persistent Storage Authority state.

---

## Authority Separation

The physical implementation MUST preserve the logical separation between:

- Storage Authority;
- Manifest Authority;
- Vault Authority;
- Capability Authority;
- Business Authority;
- Open Authority.

A shared infrastructure platform MAY be used only when the logical authority boundaries remain explicit and independently enforced.

Sharing infrastructure does not transfer authority ownership.

---

## Registry Persistence

The implementation MUST provide persistent storage for the Chunk Pointer Registry.

Registry persistence MUST NOT depend on the Manifest object being present.

The Registry MUST NOT be reconstructed from Manifest Authority as its canonical source.

---

## Registry Ownership

Only Storage Authority code may create or update canonical Chunk Pointer Registry state.

Manifest creation code MUST NOT become the Registry persistence mechanism.

Runtime code MUST NOT become the Registry writer.

---

## Storage Pointer Validation

Storage Pointers MUST be validated before they become Registry state.

Invalid or structurally malformed Storage Pointers MUST be rejected.

Storage Authority MUST NOT persist an invalid pointer and rely on Runtime validation later.

---

## Chunk Identifier Validation

Chunk Identifiers MUST be validated before being recorded in the Registry.

A Registry entry MUST represent a valid relationship between:

- a canonical Chunk Identifier;
- a valid Storage Pointer.

---

## Provider Independence

Storage Authority MUST remain independent from the specific storage provider.

Changing the underlying provider MUST NOT require changing:

- Chunk Identifier semantics;
- Vault format;
- Manifest schema;
- cryptographic behavior;
- Runtime authority boundaries.

Only the operational storage mapping may change.

---

## Transport Independence

The protocol does not require a specific HTTP endpoint or transport mechanism for Registry resolution.

An implementation MAY expose Registry resolution through an API, internal service, or another appropriate mechanism.

The transport MUST NOT become the authority itself.

---

## Legacy Compatibility

Legacy Manifest data MAY be supported during migration where required to preserve previously sealed capsules.

Legacy `chunkPointers` data MUST be treated as compatibility data only.

It MUST NOT become canonical Registry state for newly sealed capsules.

New seals MUST use the canonical Storage Authority / Chunk Pointer Registry architecture.

---

## Implementation Invariant

Implementation details MAY change.

Canonical authority ownership MUST NOT change.

A compliant implementation MUST preserve:

Chunk Identifier

↓

Storage Authority

↓

Chunk Pointer Registry

↓

Storage Pointer

↓

Encrypted Chunk

This sequence is architectural and MUST remain stable regardless of the underlying infrastructure.

# Validation Requirements

A Storage Authority implementation is compliant only when all canonical requirements below are satisfied.

Validation MUST verify both architecture and runtime behavior.

---

## 1. Manifest Independence

The canonical Manifest MUST NOT contain `chunkPointers`.

The canonical Manifest integrity extension MUST contain:

```text
ext.vaultSha256
```

and MUST NOT use `ext.chunkPointers` as canonical Storage Authority state.

---

## 2. Independent Registry

The Chunk Pointer Registry MUST exist as Storage Authority state independent of Manifest Authority.

The Registry MUST NOT be reconstructed from:

```text
Manifest.ext.chunkPointers
```

for newly sealed capsules.

---

## 3. Upload Persistence

During successful chunk upload:

```text
Chunk Identifier
        ↓
Storage Authority
        ↓
Storage Pointer
        ↓
Chunk Pointer Registry
```

The Registry entry MUST be established before Manifest Authority is finalized.

---

## 4. Runtime Resolution

Runtime MUST resolve storage locations through Storage Authority.

The canonical runtime path MUST be equivalent to:

```text
Chunk Identifier
        ↓
storage.getChunkPointers()
        ↓
Chunk Pointer Registry
        ↓
Storage Pointer
        ↓
download()
```

Runtime MUST NOT resolve chunk storage locations from Manifest Authority.

---

## 5. Emergency Runtime

Emergency Runtime MUST use the same Chunk Pointer Registry resolution model.

No separate emergency-only pointer registry may be introduced.

---

## 6. Fail-Closed Behavior

Registry resolution MUST fail closed when:

- the capsule identifier is invalid;
- the Chunk Identifier is invalid;
- the Registry is unavailable;
- the Registry is malformed;
- the requested mapping does not exist;
- the Storage Pointer is invalid;
- the returned Registry structure violates the canonical schema.

The implementation MUST NOT fabricate or infer a Storage Pointer.

---

## 7. Storage Pointer Integrity

Every Registry mapping MUST satisfy the canonical Storage Pointer validation rules before being consumed by Runtime.

Malformed pointers MUST never reach the download layer.

---

## 8. Seal Verification

A newly sealed capsule containing media MUST satisfy all of the following:

- encrypted chunks are successfully published;
- Chunk Pointer Registry entries exist;
- Manifest Authority is created successfully;
- Manifest does not contain canonical `ext.chunkPointers`;
- Runtime can resolve every required Chunk Identifier through Storage Authority;
- media can be downloaded and reconstructed successfully.

---

## 9. Text-Only Capsule Verification

A capsule without media chunks MUST remain valid.

Its Registry MAY contain no chunk mappings.

Opening the capsule MUST NOT require a nonexistent media pointer.

---

## 10. Legacy Capsule Verification

Previously sealed capsules MAY contain legacy `ext.chunkPointers` data.

Legacy compatibility MUST NOT make that field canonical for newly sealed capsules.

Legacy handling MUST NOT alter the canonical Manifest model for new capsules.

---

## 11. Storage Migration Verification

After Storage Provider migration:

- Chunk Identifiers MUST remain unchanged;
- encrypted content MUST remain unchanged;
- Manifest Authority MUST remain unchanged;
- the Registry MAY contain updated Storage Pointers;
- Runtime MUST continue resolving chunks successfully.

---

## 12. Forbidden Runtime Paths

The following patterns MUST NOT exist in canonical Runtime code:

```text
manifest.ext.chunkPointers
```

as a source of current Storage Authority state.

Likewise, Runtime MUST NOT:

- construct Storage Pointers;
- guess storage locations;
- derive provider URLs from Chunk Identifiers;
- maintain a second pointer registry.

---

## 13. Forbidden Seal Paths

Seal MUST NOT:

- own the Chunk Pointer Registry;
- persist Registry state as Manifest Authority;
- insert canonical `chunkPointers` into Manifest Authority;
- use Manifest persistence as the Registry persistence mechanism.

Seal consumes established Storage Authority state; it does not become Storage Authority.

---

## 14. Repository Verification

A migration MUST NOT be considered complete until repository-wide verification confirms:

- no live runtime reads of `manifest.ext.chunkPointers`;
- no new-seal writes of `ext.chunkPointers`;
- no Manifest API response exposes `chunkPointers` as canonical Manifest data;
- Storage Authority has an independent Registry persistence path;
- Runtime uses the Registry resolution path;
- Emergency Runtime uses the same Registry resolution model;
- obsolete compatibility code is clearly isolated from canonical paths.

---

## 15. Final Acceptance Criteria

Migration Item 1 is complete only when all of the following are true:

```text
Manifest Authority
        │
        └── ext.vaultSha256

Storage Authority
        │
        └── Chunk Pointer Registry
                 │
                 ├── ChunkId → StoragePointer
                 │
                 └── Runtime resolution
```

There MUST be no second canonical representation of the Chunk Pointer Registry inside Manifest Authority.

Only after these conditions are verified may Migration Item 1 be declared complete.

# Security Considerations

Storage Authority is a protocol authority and MUST preserve the security properties established by the AETERNA canonical architecture.

Storage Authority MUST NOT weaken:

- non-custodial guarantees;
- client-side cryptography;
- authority separation;
- fail-closed behavior;
- Vault integrity;
- Manifest integrity;
- capability boundaries.

---

## No Secret Authority

Storage Authority MUST NOT require or receive:

- capsule secrets;
- encryption keys;
- plaintext Vault data;
- plaintext media;
- recovery secrets.

Storage Authority operates on encrypted data and storage-location metadata only.

---

## No Cryptographic Authority

Storage Authority MUST NOT:

- generate capsule encryption keys;
- derive encryption keys;
- decrypt Vault data;
- decrypt media;
- modify ciphertext;
- participate in cryptographic unlock decisions.

Cryptographic operations remain within their canonical runtime boundaries.

---

## No Manifest Authority Escalation

Storage Authority MUST NOT modify Manifest Authority.

The Chunk Pointer Registry MUST remain separate from Manifest integrity metadata.

In particular, Storage Authority MUST NOT cause:

```text
ext.chunkPointers

# Migration Compatibility

The Storage Authority migration MUST preserve compatibility with capsules sealed before the canonical Chunk Pointer Registry architecture was fully implemented.

Legacy compatibility exists only to preserve previously sealed capsules.

It MUST NOT redefine the canonical architecture for newly sealed capsules.

---

## Legacy Manifest Data

Previously sealed capsules MAY contain:

```text
Manifest.ext.chunkPointers

# Completion Criteria

The Storage Authority migration is complete only when the canonical architecture is implemented and verified end-to-end.

Documentation completion alone does not constitute migration completion.

---

## Canonical Manifest

The newly sealed Manifest MUST contain only the canonical Manifest fields.

The integrity extension MUST contain:

```text
ext.vaultSha256

# Non-Goals

Storage Authority is intentionally limited to storage publication and storage-location resolution.

The following responsibilities are outside the scope of Storage Authority.

---

## Cryptography

Storage Authority MUST NOT:

- generate encryption keys;
- derive encryption keys;
- encrypt plaintext;
- decrypt ciphertext;
- modify encrypted Vault data;
- calculate cryptographic unlock decisions.

---

## Manifest Management

Storage Authority MUST NOT:

- create Manifest Authority;
- modify Manifest Authority;
- determine `openAt`;
- determine `sealedAt`;
- calculate Manifest integrity policy;
- store Chunk Pointer Registry state as Manifest data.

---

## Vault Management

Storage Authority MUST NOT:

- define Vault structure;
- modify Vault metadata;
- create Chunk Identifiers;
- modify Chunk Identifiers;
- determine Vault contents.

Storage Authority consumes canonical Chunk Identifiers produced by the Vault pipeline.

---

## Capability Management

Storage Authority MUST NOT:

- issue capabilities;
- validate capsule ownership;
- create secret links;
- manage recipient authorization;
- determine whether a user is permitted to open a capsule.

---

## Business Authority

Storage Authority MUST NOT:

- calculate capsule price;
- create payment quotes;
- verify payments;
- determine commercial authorization;
- manage subscription or billing state.

---

## Open Authority

Storage Authority MUST NOT:

- determine whether a capsule may open;
- evaluate `openAt`;
- determine trusted time;
- enforce heartbeat policy;
- decide whether a recipient is authorized to decrypt.

---

## Runtime Ownership

Storage Authority MUST NOT:

- own Runtime session state;
- render media;
- control UI state;
- manage playback;
- perform progressive rendering;
- replace Runtime orchestration.

Runtime consumes Storage Authority services.

---

## Emergency Runtime Ownership

Storage Authority MUST NOT:

- implement Emergency Runtime;
- determine Emergency Runtime opening policy;
- replace Emergency Runtime's local cryptographic behavior;
- create a separate emergency storage authority.

Emergency Runtime consumes the canonical Storage Authority model.

---

## Storage Provider Policy

Storage Authority MUST NOT make protocol decisions based on provider-specific behavior.

Provider-specific implementation details MUST remain below the Storage Authority abstraction.

Changing a storage provider MUST NOT change canonical protocol semantics.

---

## Alternative Pointer Resolution

Storage Authority MUST NOT permit alternative canonical mechanisms for resolving:

```text
Chunk Identifier → Storage Pointer

# Document Authority and Change Control

This document defines the canonical Storage Authority model for AETERNA.

Implementation code MUST conform to the canonical architecture defined by the authoritative AETERNA documentation.

---

## Authority of Canonical Documentation

Canonical project documentation has higher authority than:

- implementation code;
- comments;
- temporary migration code;
- proposed RFCs;
- experimental implementations;
- development-only behavior.

RFC documents MUST NOT redefine canonical protocol behavior.

---

## Code Versus Documentation

If implementation code conflicts with this document or another higher-authority canonical document:

1. The conflict MUST be identified.
2. The canonical documentation MUST be treated as authoritative.
3. The implementation MUST NOT silently redefine the protocol.
4. The conflicting implementation MUST be corrected through an explicit migration or implementation change.

Code MUST NOT be used as evidence that a non-canonical architecture has become canonical.

---

## Ambiguous Requirements

If canonical documentation does not define an implementation detail:

- the implementation MAY choose an appropriate mechanism;
- the choice MUST preserve all canonical authority boundaries;
- the choice MUST NOT introduce new protocol semantics;
- the implementation decision MUST remain below the protocol abstraction.

An implementation detail MUST NOT be promoted into a protocol invariant without explicit canonical documentation.

---

## Changes to Storage Authority

Changes to Storage Authority MUST preserve:

- single Storage Authority ownership;
- independent Chunk Pointer Registry;
- canonical `ChunkId → StoragePointer` resolution;
- Manifest independence;
- authority separation;
- fail-closed behavior;
- non-custodial guarantees.

Changes that alter these properties require an explicit protocol-level decision.

---

## RFC and Experimental Designs

Proposed RFCs, experiments, and migration drafts MAY describe possible implementations.

They MUST NOT override canonical Storage Authority requirements.

A proposed design becomes canonical only when the authoritative project documentation explicitly adopts it.

---

## Migration Code

Migration and compatibility code MUST remain distinguishable from canonical code.

Temporary compatibility behavior MUST NOT silently become the new canonical architecture.

Once a migration is complete, obsolete compatibility code SHOULD be removed only after legacy-capsule requirements have been verified.

---

## Change Verification

Before accepting a Storage Authority change, the implementation MUST be checked against:

1. canonical authority ownership;
2. Registry persistence;
3. Registry resolution;
4. Manifest independence;
5. Runtime behavior;
6. Emergency Runtime requirements;
7. legacy compatibility;
8. fail-closed behavior;
9. cryptographic invariants;
10. large-media behavior.

---

## No Silent Protocol Changes

No implementation change may silently:

- move Registry ownership;
- move Registry persistence into Manifest Authority;
- introduce a second Registry;
- create an alternative pointer-resolution path;
- change cryptographic behavior;
- change Vault semantics;
- weaken fail-closed behavior.

Such changes require explicit architectural approval.

---

## Final Rule

The purpose of implementation is to realize the canonical protocol.

The protocol MUST NOT be changed merely because an existing implementation happens to behave differently.

When implementation and canonical documentation disagree:

```text
Canonical Documentation
        ↓
Protocol Authority
        ↓
Implementation

