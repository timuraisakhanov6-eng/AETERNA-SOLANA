# AETERNA Documentation

Version: 1.0

Status: Canonical

---

# Purpose

This directory contains the official documentation of the AETERNA project.

Documentation is organized according to its authority and purpose.

---

# Documentation Structure

## canonical/

Contains the canonical engineering and protocol documentation.

These documents define the protocol and have higher authority than implementation.

See:

- docs/canonical/README.md

---

## rfc/

Contains Requests for Comments (RFCs).

RFC documents describe proposed protocol or architectural changes.

RFC documents are not canonical unless explicitly adopted.

---

# Authority

Canonical documentation has higher authority than:

- implementation;
- source code;
- generated artifacts;
- development notes.

Whenever implementation conflicts with canonical documentation:

Implementation shall be corrected.

Canonical documentation shall never be rewritten to justify implementation.

---

# Relationship to Source Code

Source code implements the protocol.

Documentation defines the protocol.

Implementation exists to realize canonical documentation.

It never defines protocol behavior.

---

# Relationship to AI Documentation

The AI documentation defines:

- AI operating rules;
- engineering workflow;
- review process;
- implementation methodology.

The canonical documentation defines:

- protocol behavior;
- engineering model;
- system logic;
- canonical specifications.

AI systems shall consult the applicable canonical documentation before reviewing implementation.

---

# Final Principle

Whenever uncertainty exists:

1. Read the applicable canonical documentation.
2. Follow the AI documentation workflow.
3. Inspect implementation only after the governing documentation has been reviewed.

Never infer protocol behavior from source code.

Never modify canonical documentation to justify implementation.