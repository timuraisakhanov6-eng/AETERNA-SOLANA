# AETERNA Complete Engineering Model

Version: 1.0

Status: Canonical

---

# Purpose

This document defines the complete engineering model of the AETERNA protocol.

It explains how all canonical components form one coherent engineering system.

This document exists to provide engineers and Artificial Intelligence systems with a unified understanding of AETERNA before inspecting implementation.

This document does not redefine the protocol.

This document does not replace:

- Complete Project Logic
- Complete System Logic
- Canonical Specifications

Implementation exists to realize this engineering model.

---

# Scope

This document explains:

- engineering philosophy;
- protocol identity;
- engineering authority model;
- engineering entity model;
- engineering lifecycle model;
- runtime responsibilities;
- business responsibilities;
- storage responsibilities;
- cryptographic responsibilities;
- security model;
- engineering principles.

This document intentionally avoids implementation details.

Implementation details belong to the applicable canonical specifications.

---

# Engineering Philosophy

AETERNA is a protocol.

It is not defined by a website.

It is not defined by a frontend.

It is not defined by Cloudflare.

It is not defined by React.

It is not defined by SDKs.

It is not defined by source code.

Implementations evolve.

The protocol remains.

Every implementation is temporary.

The protocol is permanent.

Whenever implementation conflicts with canonical documentation, implementation shall be corrected.

Canonical documentation shall never be rewritten to justify implementation.

---

# Protocol Identity

The identity of AETERNA is defined exclusively by its immutable protocol laws.

Those laws are:

- Non-Custodial
- Seal Once
- Browser-side Cryptography
- Fail Closed
- Deterministic Behavior
- Authority Separation
- Immutable Publication

These laws are not implementation choices.

They are protocol identity.

Changing any of these laws changes the protocol itself.

---

# Engineering Philosophy of Authority

The engineering foundation of AETERNA is not software.

It is authority.

Every subsystem exists to preserve authority boundaries.

Authority determines responsibility.

Implementation realizes responsibility.

Implementation never creates authority.

Whenever authority expands beyond canonical boundaries, the protocol has been violated.

---

# Engineering Layers

The engineering model consists of the following conceptual layers.

Layer 1 — Protocol Philosophy

Defines why AETERNA exists.

Layer 2 — Protocol Laws

Defines immutable protocol identity.

Layer 3 — Authority Model

Defines ownership and responsibility.

Layer 4 — Entity Model

Defines protocol objects.

Layer 5 — Lifecycle Model

Defines deterministic state transitions.

Layer 6 — Runtime Model

Executes protocol rules.

Layer 7 — Infrastructure Model

Supports implementation.

Layer 8 — Implementation

Realizes every layer above.

Every layer depends only on higher layers.

Lower layers never redefine higher layers.

---

# Engineering Reading Order

Every engineer and every AI system shall understand AETERNA in the following order.

1. AI/AI_CONSTITUTION.md

2. AI/

3. docs/canonical/AETERNA_COMPLETE_ENGINEERING_MODEL.md

4. docs/canonical/AETERNA_COMPLETE_PROJECT_LOGIC.md

5. docs/canonical/AETERNA_COMPLETE_SYSTEM_LOGIC.md

6. Applicable Canonical Specifications

7. Source Code

Implementation shall never become the primary source of understanding.

---

# Engineering Laws

Every engineering decision shall preserve:

- protocol integrity;
- authority separation;
- deterministic behavior;
- architectural consistency;
- cryptographic correctness;
- non-custodial operation;
- immutable publication;
- long-term maintainability.

Engineering convenience never overrides protocol laws.

---

# Authority Model

Authority is the central engineering concept of AETERNA.

The protocol separates authority into independent authority domains.

The names and boundaries of these domains are defined exclusively by the Complete System Logic.

This document uses those same names and introduces no new terminology.

The canonical authority domains are:

- Ciphertext Authority
- Open Authority
- Business Authority
- Storage Authority

The Runtime Layer is an execution layer.

It is not an authority.

It never establishes, transfers, or modifies protocol authority.

Each authority owns only its own responsibility.

Authorities never merge.

Authorities never inherit unrestricted permissions.

Whenever an implementation allows one authority to perform actions belonging to another authority, protocol integrity has been violated.

---

# Entity Model

The protocol consists of cooperating engineering entities.

Core entities include:

- User
- Secret
- Prepared Capsule
- Vault
- Manifest
- Creator Service Quote
- Payment
- Capability
- Runtime
- Executor
- Storage
- Heartbeat
- Confirm Presence

Every entity has:

- defined responsibility;
- defined lifecycle;
- explicit authority limits;
- explicit protocol purpose.

No entity exists independently of the protocol.

---

# Lifecycle Model

Every capsule progresses through one deterministic lifecycle.

The canonical lifecycle is defined by the Complete System Logic and the applicable canonical specifications.

The lifecycle begins with user preparation.

The lifecycle ends only after protocol completion.

Every lifecycle transition requires:

- applicable authority;
- protocol validation;
- canonical ordering;
- deterministic execution.

Lifecycle transitions may never be reordered unless explicitly authorized by canonical specifications.

---

# Runtime Engineering Model

Runtime executes protocol rules.

Runtime implements protocol behavior.

Runtime never defines protocol behavior.

Runtime never owns protocol authority.

Runtime never owns user data.

Runtime never owns protocol identity.

Runtime is replaceable.

The protocol is not.

Creator Runtime

Responsible only for capsule creation.

Recipient Runtime

Responsible only for capsule access.

Emergency Runtime

Responsible only for canonical emergency recovery.

Persistent Runtime

Responsible only for protocol-defined persistent execution.

Each runtime remains within its assigned responsibility.

---

# Business Engineering Model

Business services implement commercial protocol requirements.

Business Authority includes:

- Creator Service Quote
- Payment Verification
- Commercial validation
- Future treasury governance interaction

Business Authority never changes:

- protocol rules;
- cryptography;
- storage;
- publication order.

Business Authority validates commercial rules.

Business Authority never establishes protocol authority.

Business exists beside the protocol.

It never governs the protocol.

---

# Storage Engineering Model

Storage preserves published protocol artifacts.

Storage never interprets protocol meaning.

Storage never becomes protocol authority.

Storage never gains ownership of user data.

Storage responsibilities include:

- Vault persistence;
- Manifest persistence;
- Chunk persistence;
- Publication durability.

Storage preserves artifacts.

Storage never interprets artifacts.

Storage exists solely to preserve published state.

---

# Cryptographic Engineering Model

Cryptography preserves protocol authority.

Cryptography exists to guarantee:

- Non-Custodial operation;
- deterministic behavior;
- integrity;
- confidentiality;
- canonical verification.

Cryptographic algorithms are defined exclusively by canonical specifications.

Engineering implementation shall never substitute cryptographic primitives for convenience.

---

# Security Engineering Model

Security is a protocol property.

Security is never an optional implementation feature.

Security preserves:

- authority separation;
- browser-side cryptography;
- fail-closed execution;
- secret isolation;
- deterministic validation.

Whenever security conflicts with convenience,

security always wins.

---

# Engineering Audit Model

Engineering audit verifies that implementation preserves the canonical engineering model.

Engineering audit confirms:

- protocol preservation;
- authority preservation;
- lifecycle preservation;
- subsystem responsibility preservation;
- cryptographic correctness;
- storage correctness;
- runtime correctness;
- implementation correctness.

Engineering audit never redesigns the protocol.

Engineering audit never redesigns architecture.

Engineering audit reports only confirmed deviations.

Recommendations shall always be limited to the minimum corrective action required to restore canonical compliance.

Engineering audit proceeds in the following order:

Canonical Documentation

↓

Engineering Model

↓

Architecture

↓

Authority

↓

Lifecycle

↓

Implementation

↓

Release Readiness

---

# Engineering Principles

Every engineer working on AETERNA shall preserve the following principles.

Implementation follows protocol.

Protocol follows canonical documentation.

Authority never expands.

Responsibilities remain separated.

Components remain replaceable.

Runtime never becomes protocol authority.

Business never governs protocol behavior.

Storage never owns user data.

Cryptography remains browser-side.

Published state remains immutable.

Implementation remains deterministic.

Documentation remains canonical.

---

# Engineering Architecture

The engineering architecture of AETERNA is hierarchical.

Each architectural layer has a single responsibility.

Each lower layer realizes the responsibilities defined by the layers above it.

The engineering hierarchy is:

Protocol Philosophy

↓

Protocol Laws

↓

Authority Model

↓

Entity Model

↓

Lifecycle Model

↓

Runtime Model

↓

Infrastructure Model

↓

Implementation

No lower layer may redefine a higher layer.

Implementation realizes architecture.

Architecture realizes the protocol.

The protocol defines the system.

---

# Engineering Responsibilities

Every engineering layer has a distinct responsibility.

Protocol Philosophy
    Defines why the protocol exists.

Protocol Laws
    Define immutable protocol identity.

Authority Model
    Defines responsibility and ownership.

Entity Model
    Defines protocol objects and their purpose.

Lifecycle Model
    Defines deterministic protocol progression.

Runtime Model
    Executes protocol rules.

Infrastructure Model
    Provides supporting services.

Implementation
    Realizes every engineering decision defined by the canonical documentation.

Responsibilities shall remain separated.

No engineering layer shall assume responsibilities belonging to another layer.

---

# Engineering Decision Principle

Engineering decisions shall always follow the canonical documentation.

Whenever multiple implementation options exist, the selected implementation shall:

- preserve protocol integrity;
- preserve authority separation;
- preserve deterministic behavior;
- preserve lifecycle correctness;
- preserve long-term maintainability.

Engineering convenience shall never justify changes to the protocol.

The protocol defines engineering.

Engineering defines implementation.

Implementation never defines the protocol.

---

# Final Engineering Principle

The engineering model exists to preserve the canonical identity of AETERNA.

It provides the common engineering understanding shared by:

- architects;
- engineers;
- reviewers;
- auditors;
- Artificial Intelligence systems.

Every implementation shall conform to the canonical engineering model.

Every audit shall evaluate implementation against the canonical engineering model.

Whenever implementation conflicts with the engineering model:

Implementation shall be corrected.

The engineering model shall never be rewritten to justify implementation.

The protocol is permanent.

Implementations evolve.

Engineering exists to preserve the protocol.