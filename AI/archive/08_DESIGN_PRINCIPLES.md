# AETERNA Design Principles

Version: 1.0
Status: Canonical AI Guidance

---

# Purpose

This document summarizes the engineering principles that govern AETERNA.

It does not define new protocol rules.

It summarizes existing canonical rules and points AI systems toward the correct architectural decisions.

If this document conflicts with the canonical protocol, the canonical protocol always takes precedence.

---

# General Rule

Engineering decisions must preserve protocol integrity.

Convenience must never override protocol correctness.

Implementation must adapt to the protocol.

The protocol must never adapt to the implementation.

---

# Principle 1 — Documentation First

Canonical documentation is the primary engineering authority.

Source code is evidence of implementation.

If implementation and documentation conflict, implementation must be corrected.

---

# Principle 2 — Preserve Architecture

AI must preserve the existing architecture.

Improving implementation is allowed.

Redesigning protocol behavior is forbidden.

---

# Principle 3 — Authority Separation

Authority domains must remain independent.

Implementation must never merge or blur authority boundaries.

Changes affecting one authority must not modify another authority.

---

# Principle 4 — Non-Custodial Design

Secrets belong exclusively to the user.

Servers never obtain decryption authority.

The protocol must remain non-custodial under every implementation.

---

# Principle 5 — Cryptographic Integrity

Ciphertext authority becomes immutable after PREPARED.

No implementation may regenerate keys, capabilities, ciphertext, or immutable identifiers.

---

# Principle 6 — Fail Closed

When uncertainty exists, the protocol must fail safely.

Errors must never weaken security or authority boundaries.

---

# Principle 7 — Runtime Independence

Runtime exists only to execute the protocol.

Runtime is never protocol authority.

Implementation details of Runtime must never influence protocol behavior.

---

# Principle 8 — Emergency Compatibility

Emergency Runtime must preserve every protocol authority.

Fallback behavior must remain protocol-compatible.

Disaster recovery must never require protocol changes.

---

# Principle 9 — Simplicity for Users

Complexity belongs inside the implementation.

The user should interact with a simple, predictable product.

Internal architecture should remain invisible to users whenever possible.

---

# Final Principle

Every engineering decision should answer one question:

"Does this preserve the canonical protocol?"

If the answer is uncertain, stop and consult the canonical documentation before proceeding.