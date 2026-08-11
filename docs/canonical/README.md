# Canonical Documentation

Version: 1.0

Status: Canonical

---

# Purpose

This directory contains the canonical engineering and protocol documentation of the AETERNA project.

These documents collectively define:

- the engineering model;
- the project logic;
- the system logic;
- the protocol behavior;
- the canonical specifications.

Canonical documentation is the authoritative source of truth for AETERNA.

---

# Authority

Canonical documentation has higher authority than:

- implementation;
- source code;
- generated artifacts;
- development notes;
- implementation convenience.

Whenever implementation conflicts with canonical documentation:

Implementation shall be corrected.

Canonical documentation shall never be rewritten to justify implementation.

---

# Scope

The documents contained in this directory define:

- protocol behavior;
- engineering architecture;
- authority boundaries;
- lifecycle rules;
- infrastructure rules;
- canonical specifications.

Implementation details belong to the source code.

Engineering workflow belongs to the AI documentation.

---

# Reading Order

Canonical documentation should be studied in the following order:

1. AETERNA_COMPLETE_ENGINEERING_MODEL.md
2. AETERNA_COMPLETE_PROJECT_LOGIC.md
3. AETERNA_COMPLETE_SYSTEM_LOGIC.md
4. Applicable Canonical Specifications
5. AETERNA_INFRASTRUCTURE.md

Additional canonical specifications should be consulted whenever they govern the requested task.

---

# Current Canonical Documents

Core Canonical Documents

- AETERNA_COMPLETE_ENGINEERING_MODEL.md
- AETERNA_COMPLETE_PROJECT_LOGIC.md
- AETERNA_COMPLETE_SYSTEM_LOGIC.md
- AETERNA_INFRASTRUCTURE.md

Canonical Specifications

- INVARIANTS.md
- MANIFEST_EVOLUTION.md
- VAULT_EVOLUTION.md

Additional canonical documents and specifications may be added as the protocol evolves.

---

# Relationship to AI Documentation

The AI directory defines:

- how AI systems operate;
- engineering workflow;
- review process;
- responsibilities;
- implementation methodology.

This directory defines:

- what AETERNA is;
- how the protocol is engineered;
- how the protocol behaves;
- what implementation must preserve.

---

# Engineering Principle

Implementation realizes the protocol.

Documentation defines the protocol.

The protocol is permanent.

Implementations evolve.

Every engineering decision shall preserve the canonical documentation.

---

# Final Principle

Canonical documentation is the single engineering source of truth for AETERNA.

Whenever uncertainty exists:

1. Read the applicable canonical documentation.
2. Consult the AI documentation for the required workflow.
3. Inspect implementation only after the governing documentation has been reviewed.

Never infer protocol behavior from implementation.

Never modify canonical documentation to justify implementation.