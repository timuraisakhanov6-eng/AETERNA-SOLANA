# AETERNA SECURITY POLICY

Status: canonical operational security policy
Authority: repository-wide operational security
Scope: deployment + runtime + disclosure
Compatibility: Master Protocol v4.3.2

---

# 1. SECURITY MODEL

AETERNA is a capability-based, client-side encrypted protocol.

The protocol is designed around:

- local-only cryptography
- recipient-exclusive decrypt authority
- immutable Manifest architecture
- Trusted Time Open Authority
- Authority Domain isolation
- deterministic cryptographic validation
- fail-closed runtime behavior

The backend MUST NEVER possess:

- recipientSecret
- vault keys
- decrypt authority

Runtime Layer is NOT an Authority.

---

# 2. SECURITY GUARANTEES

The protocol guarantees:

- ciphertext-only persistence
- no backend plaintext recovery
- no admin decrypt capability
- no server-side unlock override
- recipient-exclusive decrypt authority
- Business Authority isolation
- Emergency Runtime continuity
- deterministic vault verification

These guarantees are valid only within the canonical threat model.

---

# 3. CANONICAL COMPATIBILITY

This repository follows:

**Master Protocol v4.3.2**

Implementation components MUST remain compatible with the canonical protocol.

---

# 4. SECURITY REPORTING

Security vulnerabilities SHOULD be reported privately.

Reports SHOULD include:

- affected Authority Domain
- affected runtime layer
- reproduction steps
- protocol impact
- invariant violations
- proof of concept when available

Critical vulnerabilities SHOULD NOT be disclosed publicly before remediation.

---

# 5. SECURITY PRIORITIES

Security priorities are:

1. Protocol invariants
2. Cryptographic integrity
3. Authority isolation
4. Trusted Time enforcement
5. Manifest immutability
6. Runtime parity
7. Fail-closed behavior
8. Availability

Availability MUST NEVER override protocol guarantees.

---

# 6. SECRET HANDLING

Sensitive material includes:

- recipientSecret
- creatorAuthority
- vault keys
- plaintext
- decrypted media

These values MUST NEVER:

- reach backend systems
- be logged
- be stored by storage providers
- appear in Manifests
- appear in analytics
- appear in query parameters

Recipient Capability authority exists exclusively in the URL fragment.

---

# 7. TRUSTED TIME

Trusted Time is the canonical Open Authority.

Trusted Time participates only in unlock authorization.

Forbidden:

- local-time authority
- browser-clock authority
- timestamp override
- Trusted Time bypass

Emergency Runtime MAY use a local time guard.

Local time MUST NEVER become protocol authority.

---

# 8. AUTHORITY DOMAINS

Security depends on strict isolation of:

- Ciphertext Authority
- Open Authority
- Business Authority
- Storage Authority

Authority boundaries MUST NEVER be bypassed.

---

# 9. STORAGE SECURITY

Storage infrastructure is hostile.

Storage MUST preserve:

- ciphertext-only persistence
- immutable storage
- integrity-first retrieval

Storage providers MUST NEVER obtain:

- decrypt authority
- capability authority
- Open Authority
- Business Authority

All Vaults MUST undergo local cryptographic verification.

---

# 10. EMERGENCY RUNTIME

Emergency Runtime is protocol-critical.

Emergency Runtime MUST preserve:

- runtime parity
- Manifest validation
- decrypt ordering
- Heartbeat behavior
- Open Authority semantics
- fail-closed behavior

Emergency Runtime downgrade is forbidden.

---

# 11. DEPLOYMENT SECURITY

Production deployments SHOULD preserve:

- HTTPS-only delivery
- restrictive CSP
- integrity-preserving builds
- environment isolation
- secure secret management
- deterministic deployments

Deployment MUST NOT weaken protocol invariants.

---

# 12. STREAMING SECURITY

Security MUST preserve:

- Streaming Preview
- Streaming Upload
- Streaming Download
- Streaming Reconstruction
- Bounded Memory

Whole-capsule buffering MUST NOT become a protocol requirement.

---

# 13. FORBIDDEN CONDITIONS

The following conditions invalidate protocol security:

- local-time authority
- decrypt-before-unlock
- decrypt-before-verify
- backend decrypt authority
- recipient authority escalation
- creator authority escalation
- AES-256-GCM nonce reuse
- upload-before-payment
- Manifest mutation after sealing
- renderer-based XSS execution
- Emergency Runtime downgrade
- fail-open behavior

---

# 14. AUDIT REQUIREMENTS

Security audits MUST preserve layered analysis.

Canonical audit layers include:

1. Authority Domains
2. Runtime Layer
3. Cryptography
4. Storage
5. Manifest / Vault
6. Trusted Time
7. Heartbeat
8. Open Pipeline
9. Renderer
10. Emergency Runtime

Audits MUST verify:

- protocol invariants
- Authority isolation
- runtime parity
- fail-closed behavior

---

# 15. NON-GOALS

The protocol does NOT protect against:

- compromised recipient devices
- operating system malware
- browser engine compromise
- voluntary capability disclosure
- physical device seizure
- screenshots
- nation-state endpoint compromise

These threats exist outside protocol boundaries.

---

# 16. FINAL SECURITY PRINCIPLE

Protocol invariants override implementation decisions.

Authority isolation overrides infrastructure convenience.

Cryptographic correctness overrides application behavior.

Fail-closed behavior overrides availability.

The Master Protocol is authoritative over every implementation.