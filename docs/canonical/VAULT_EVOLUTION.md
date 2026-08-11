# AETERNA Vault Evolution Rules

Status: canonical

Authority: vault governance layer

---

# 1. PURPOSE

This document defines immutable evolution rules for AETERNA vault schemas.

Vault compatibility is cryptographically critical.

---

# 2. VAULT PRINCIPLE

Vaults are encrypted immutable protocol payloads.

Vault semantics MUST remain deterministic.

---

# 3. VAULT VERSIONING

Vault schemas MUST be versioned.

Current canonical version:

- Vault V2

Unknown vault versions MUST fail closed.

---

# 4. CRYPTOGRAPHIC STABILITY

Vault encryption semantics MUST preserve:

- AES-GCM authentication
- canonical serialization
- deterministic decrypt semantics
- integrity verification ordering
- fail-closed behavior

Cryptographic weakening is forbidden.

---

# 5. SERIALIZATION STABILITY

Canonical serialization rules are protocol-critical.

Serialization MUST preserve:

- deterministic ordering
- stable encoding semantics
- runtime parity
- invariant continuity

Serialization drift is forbidden.

---

# 6. ENVELOPE STRUCTURE

The canonical encrypted Vault V2 envelope is defined by the applicable canonical specifications.

Vault envelope semantics MUST remain stable within a protocol version.

Changes to the encrypted envelope REQUIRE:

- a new vault version;
- compatibility review;
- cryptographic review.

---

# 7. VAULT IDENTITY CONTINUITY

Vault contents MUST preserve:

- capsuleId continuity
- deterministic structure
- runtime compatibility

Identity mismatch MUST fail closed.

---

# 8. ITEM EVOLUTION

Vault item schemas MAY evolve only when:

- older runtimes fail closed
- authority semantics remain stable
- renderer isolation remains preserved

Unknown executable item semantics are forbidden.

---

# 9. MEDIA EVOLUTION

Media handling MUST preserve:

- encrypted chunk semantics
- deterministic ordering
- integrity verification
- replay resistance

Media validation weakening is forbidden.

---

# 10. DECRYPT PIPELINE STABILITY

The decrypt pipeline MUST preserve:

1. trusted time validation
2. unlock validation
3. manifest validation
4. integrity verification
5. AES-GCM authentication
6. vault validation
7. renderer isolation

decrypt-before-verify is forbidden.

---

# 11. RUNTIME PARITY

Vault semantics MUST remain equivalent across:

- primary runtime
- Emergency Runtime
- future compatible runtimes

Parity drift is forbidden.

---

# 12. EXECUTABLE CONTENT RULE

Vault contents MUST remain passive data.

Executable vault semantics are forbidden.

The following are forbidden:

- script execution
- inline HTML trust
- executable payload injection
- renderer authority escalation

---

# 13. BREAKING CHANGE RULE

Breaking vault changes REQUIRE:

1. new vault version
2. compatibility review
3. migration strategy
4. cryptographic review
5. runtime parity review
6. audit review

Silent vault evolution is forbidden.

---

# 14. FINAL PRINCIPLE

Vault schemas are cryptographic security boundaries.

Every Vault evolution shall preserve canonical protocol compatibility.