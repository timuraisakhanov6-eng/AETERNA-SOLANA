# CONTRIBUTING

AETERNA is a protocol-first repository.

All contributions MUST preserve:

- protocol invariants
- authority isolation
- runtime parity
- fail-closed behavior
- deterministic validation
- cryptographic correctness

Implementation convenience does NOT override protocol guarantees.

---

# 1. CONTRIBUTION PRINCIPLE

Contributors MUST treat AETERNA as a security-critical protocol system.

Changes MUST preserve:

- canonical architecture
- invariant compatibility
- authority boundaries
- runtime compatibility
- emergency runtime parity
- hostile-input assumptions

Security-sensitive behavior MUST remain deterministic.

---

# 2. BEFORE CONTRIBUTING

Contributors SHOULD read the canonical documentation before modifying protocol-sensitive code.

Recommended reading:

| Document | Purpose |
|---|---|
| Master Protocol | Canonical protocol specification |
| Complete System Logic | Canonical protocol behavior |
| Canonical Specifications | Domain-specific specifications |
| Threat Model | Security assumptions |
| Audit Methodology | Canonical audit process |
| Cryptographic Specifications | Cryptographic architecture |

Protocol understanding is required before modifying security-sensitive code.

---

# 3. SECURITY-CRITICAL AREAS

The following areas are protocol-critical:

- cryptography
- decrypt pipeline
- trusted-time enforcement
- heartbeat semantics
- manifest validation
- emergency runtime parity
- storage verification
- capability parsing
- authority boundaries

Changes to these areas require invariant analysis.

---

# 4. AUTHORITY ISOLATION

AETERNA defines independent Authority Domains.

These boundaries MUST remain isolated:

- Ciphertext Authority
- Open Authority
- Business Authority
- Storage Authority

Runtime Layer is NOT an Authority.

No contribution may merge, bypass, or weaken Authority boundaries.

---

# 5. FORBIDDEN CONTRIBUTIONS

The following changes are forbidden:

- local-time unlock authority
- decrypt-before-verify
- decrypt-before-unlock
- weakened AES-GCM validation
- authority escalation
- manifest mutation
- upload-before-payment
- runtime parity drift
- emergency runtime downgrade
- fail-open behavior

Changes introducing these conditions are invalid.

---

# 6. RUNTIME PARITY REQUIREMENT

Contributors MUST preserve parity across:

- creator runtime
- recipient runtime
- emergency runtime

Parity includes:

- validation rules
- decrypt ordering
- trusted-time semantics
- fail-closed behavior

Runtime drift is forbidden.

---

# 7. RUNTIME LAYER

Runtime is an execution layer only.

Runtime MUST NOT:

- establish protocol authority
- modify protocol authority
- replace protocol authority
- regenerate capabilities
- modify ciphertext

Runtime ownership never implies protocol authority.

---

# 8. FAIL-CLOSED REQUIREMENT

Security-sensitive logic MUST fail closed.

Malformed or uncertain input MUST:

- terminate execution
- reject authority
- stop decrypt continuation

Fail-open behavior is forbidden.

---

# 9. HOSTILE INPUT MODEL

All external input MUST be treated as hostile.

Hostile inputs include:

- manifests
- ciphertext
- storage payloads
- gateway responses
- runtime plaintext
- URL capabilities

Implicit trust assumptions are forbidden.

---

# 10. CRYPTOGRAPHIC CONTRIBUTIONS

Cryptographic changes MUST preserve:

- deterministic derivation
- AES-256-GCM authentication
- canonical serialization
- nonce uniqueness
- SHA-256 integrity binding

Cryptographic drift is forbidden.

---

# 11. HEARTBEAT

Heartbeat behavior MUST remain compatible with the canonical protocol.

Contributions MUST NOT alter:

- Heartbeat availability rules
- Heartbeat renewal rules
- Open Authority semantics

Heartbeat MUST NOT affect Ciphertext Authority.

---

# 12. BUILDER REQUIREMENTS

Builder components MUST remain independent from encrypted media.

Builder MUST NOT:

- operate on encrypted media
- read encrypted chunks
- access Runtime ciphertext

Builder operates only on creator-provided source content.

---

# 13. STREAMING REQUIREMENTS

Contributions MUST preserve:

- Streaming Preview
- Streaming Upload
- Streaming Download
- Streaming Reconstruction
- Bounded Memory

Whole-capsule buffering MUST NOT become a protocol requirement.

---

# 14. DOCUMENTATION REQUIREMENT

Security-sensitive changes SHOULD update canonical documentation when necessary.

Canonical documentation remains authoritative.

Implementation MUST follow the protocol, not the opposite.

---

# 15. AUDIT EXPECTATION

Security-sensitive contributions SHOULD undergo:

- invariant analysis
- authority analysis
- runtime parity review
- decrypt pipeline review

Auditability is mandatory.

---

# 16. REFACTORING GUIDELINES

Refactors MUST preserve:

- runtime behavior
- protocol semantics
- validation ordering
- authority boundaries

Architectural simplification MUST NOT weaken protocol guarantees.

---

# 17. DEPENDENCY GUIDELINES

Contributors SHOULD minimize unnecessary dependencies.

Security-sensitive dependencies require scrutiny.

Dependency convenience does NOT override protocol integrity.

---

# 18. FINAL CONTRIBUTION PRINCIPLE

Protocol invariants override implementation preference.

Canonical architecture overrides implementation convenience.

Security correctness overrides refactoring convenience.

Deterministic fail-closed behavior is mandatory across all contributions.