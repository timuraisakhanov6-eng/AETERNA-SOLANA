# AETERNA HARDENING GUIDELINES

Status: operational security guidance
Authority: defensive hardening recommendations
Scope: runtime + infrastructure hardening
Compatibility: Master Protocol v4.3.2

---

# 1. PURPOSE

This document defines recommended hardening practices for AETERNA deployments.

Hardening improves defensive resilience but does NOT redefine protocol invariants.

Canonical protocol correctness remains defined by:

- protocol invariants
- authority isolation
- cryptographic correctness
- fail-closed behavior

---

# 2. HARDENING PRINCIPLE

Hardening exists to reduce operational attack surface.

Hardening SHOULD improve:

- runtime isolation
- memory hygiene
- operational integrity
- hostile-input resistance
- deployment resilience

Hardening MUST NEVER weaken protocol guarantees.

---

# 3. CONTENT SECURITY POLICY

Deployments SHOULD enforce restrictive Content Security Policy (CSP).

Recommended goals:

- prevent inline script execution
- restrict third-party script injection
- reduce XSS exposure
- isolate runtime execution

Emergency Runtime CSP SHOULD preserve runtime parity.

---

# 4. RUNTIME ISOLATION

Deployments SHOULD isolate:

- creator runtime
- recipient runtime
- emergency runtime
- operational dashboards
- payment integrations
- webhook infrastructure

Runtime Layer is NOT an Authority.

Cross-runtime authority leakage is forbidden.

---

# 5. MEMORY HYGIENE

Sensitive runtime material MAY include:

- recipientSecret
- creatorAuthority
- vault keys
- plaintext buffers
- decrypted media
- temporary runtime buffers

Deployments SHOULD:

- minimize secret lifetime
- release references when practical
- avoid persistent storage
- avoid analytics exposure

Perfect memory zeroization cannot be guaranteed in JavaScript runtimes.

---

# 6. LOGGING RESTRICTIONS

Deployments SHOULD avoid logging:

- recipientSecret
- creatorAuthority
- vault keys
- decrypted payloads
- plaintext
- capability fragments
- sensitive runtime buffers

Operational logs MUST remain non-authoritative.

---

# 7. STORAGE HARDENING

Storage infrastructure SHOULD preserve:

- ciphertext-only persistence
- immutable storage semantics
- integrity-first retrieval
- hostile gateway assumptions

Storage infrastructure remains hostile.

Storage MUST NOT gain:

- decrypt authority
- capability authority
- Business Authority
- Open Authority

---

# 8. API HARDENING

Operational APIs SHOULD:

- validate all input
- fail closed on ambiguity
- reject malformed payloads
- preserve Authority isolation
- minimize exposed metadata

Implicit trust assumptions are forbidden.

---

# 9. PAYMENT HARDENING

Payment integrations SHOULD preserve:

- Creator Service Quote authority
- strict transaction validation
- upload-after-payment enforcement
- replay resistance
- environment isolation
- fixed USD 1.00 service fee

Payment integrations MUST remain non-authoritative.

---

# 10. EMERGENCY RUNTIME HARDENING

Emergency Runtime SHOULD preserve:

- validation parity
- decrypt ordering parity
- Trusted Time behavior
- Heartbeat behavior
- fail-closed behavior

Emergency Runtime downgrade is forbidden.

---

# 11. FRONTEND HARDENING

Frontend deployments SHOULD:

- avoid unsafe HTML rendering
- preserve renderer isolation
- escape hostile plaintext
- minimize executable DOM behavior

Renderer trust assumptions are forbidden.

---

# 12. DEPENDENCY HARDENING

Deployments SHOULD:

- minimize dependency surface
- avoid unnecessary runtime libraries
- audit cryptographic dependencies
- preserve deterministic runtime behavior

Dependency sprawl increases operational risk.

---

# 13. INFRASTRUCTURE HARDENING

Operational infrastructure SHOULD preserve:

- HTTPS-only transport
- environment isolation
- secret isolation
- deterministic deployments
- controlled release procedures

Infrastructure convenience MUST NOT weaken protocol guarantees.

---

# 14. STREAMING PRESERVATION

Hardening MUST preserve:

- Streaming Preview
- Streaming Upload
- Streaming Download
- Streaming Reconstruction
- Bounded Memory

Hardening MUST NOT introduce whole-capsule buffering.

---

# 15. FAIL-CLOSED PRINCIPLE

Operational uncertainty SHOULD fail closed.

Deployments SHOULD NOT:

- bypass validation
- bypass integrity verification
- bypass authority verification
- weaken Trusted Time enforcement

Availability MUST NOT override protocol guarantees.

---

# 16. NON-GOALS

Hardening does NOT redefine:

- protocol invariants
- Authority Domains
- Runtime Layer
- cryptographic model
- Manifest semantics
- Open Authority semantics
- Trusted Time semantics

Optional hardening MUST NOT redefine protocol correctness.

---

# 17. FORBIDDEN CONDITIONS

The following conditions remain forbidden:

- local-time authority
- decrypt-before-verify
- decrypt-before-unlock
- AES-256-GCM nonce reuse
- authority escalation
- manifest mutation
- renderer-based XSS execution
- emergency runtime downgrade
- fail-open behavior

Hardening MUST NOT weaken these guarantees.

---

# 18. SECURITY RATIONALE

The hardening model improves:

- operational resilience
- deployment hygiene
- hostile-input resistance
- runtime isolation
- infrastructure integrity

Security remains grounded in canonical protocol invariants.

---

# 19. FINAL HARDENING PRINCIPLE

Protocol invariants override implementation convenience.

Canonical architecture overrides hardening shortcuts.

Hardening improves resilience but does NOT redefine protocol correctness.

Fail-closed defensive posture is recommended across all deployments.