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

Emergency Runtime uses the same Trusted Time opening policy as the primary
runtime. It MUST NOT treat local time as protocol authority.

Trusted Time is an opening-policy input. It does NOT, by itself, create a
cryptographic time-lock (see §16).

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
- a recipient who controls its own client JavaScript while holding
  `recipientSecret` — such a client can decrypt before `effectiveOpenAt`
  (see §16.4)
- physical device seizure
- screenshots
- nation-state endpoint compromise

These threats exist outside protocol boundaries.

For the exact scope of the Model 01 time boundary, see §16.

---

# 16. TIME BOUNDARY — CURRENT MODEL (MODEL 01)

This section states the ACTUAL current production model. It is a statement of
architectural scope, not a new requirement, and it does not weaken any
invariant.

## 16.1 `openAt` is NOT a cryptographic time-lock

`openAt` is NOT a cryptographic time-lock.

Model 01 does NOT implement time-lock encryption, timed-release encryption,
a VDF, a time-lock puzzle, a beacon-based release, or any cryptographic
release mechanism.

`openAt` is:

- an immutable input to the Vault key derivation (Ciphertext Authority);
- the initial opening-policy boundary;
- an input to the effective-open calculation.

`effectiveOpenAt` is the authoritative current opening boundary (Open
Authority), derived from the immutable `openAt`, Trusted Time, and Heartbeat
records.

## 16.2 Normal open path

```
trusted /api/time
  → resolve effectiveOpenAt
  → the (unmodified) client refuses to open early
  → decrypt only after the guard passes
```

The Vault key derivation and `decryptVault()` themselves have NO time
parameter: `openAt` is a KDF input, not a current-time-dependent secret. The
time boundary is enforced by the canonical client's opening-policy check.

## 16.3 Two distinct claims — do not conflate

**A.** "An UNMODIFIED client MUST NOT decrypt before `effectiveOpenAt`."
→ IMPLEMENTED and enforced in the canonical runtime (normal client path).

**B.** "Cryptographically NOBODY can decrypt before `effectiveOpenAt`."
→ **FALSE for Model 01.**

Model 01 guarantees A. Model 01 does NOT guarantee B.

## 16.4 Architectural limitation (stated, not softened)

A malicious recipient that ALREADY possesses `recipientSecret` and fully
controls its own browser JavaScript can remove the client-side time guard and
derive the key / decrypt the plaintext before `effectiveOpenAt`.

Reason: the client-side time guard is bypassable, the ciphertext is public and
immutable, and the key derivation does not require any time-release secret.

This is a precise architectural property of Model 01 — not a defect in any
single implementation, and not a "best effort" caveat.

## 16.5 Model 01 threat model (time boundary)

| Threat | Result |
|---|---|
| Local browser/system clock change | CANNOT unlock |
| `Date.now()` override | CANNOT unlock |
| Client-side time-guard modification (holds `recipientSecret`) | CAN obtain plaintext before `effectiveOpenAt` |
| Direct decrypt invocation (holds `recipientSecret`) | CAN obtain plaintext before `effectiveOpenAt` |
| UI / state manipulation | CAN alter UI appearance only |
| Public ciphertext download | CANNOT decrypt without `recipientSecret` |
| API-response manipulation | CANNOT produce plaintext (KDF inputs must match) |
| Server | Does NOT possess plaintext or the complete key |

## 16.6 Non-custodial scope

The server does NOT know `recipientSecret`, the plaintext, or the complete
content decryption key. Ciphertext remains public and immutable by design.

This is NOT a claim that early decryption is cryptographically impossible.

## 16.7 Model 02 — future, NOT launched

Model 02 is a FUTURE design effort and is NOT part of the current production
model. Its target security property is:

> "No plaintext before `effectiveOpenAt`, even for a malicious recipient that
> possesses `recipientSecret` and controls the client."

Model 02 may require a cryptographic time-release / distributed release
mechanism. No construction is adopted here; Model 02 remains a separate future
project and an expanded payment model.

## 16.8 Existing capsules

Existing Model 01 sealed capsules are NOT retroactively changed and remain
governed by Model 01 security semantics. Model 02 cryptographic time-lock
guarantees MUST NOT be promised for Model 01 capsules.

---

# 17. FINAL SECURITY PRINCIPLE

Protocol invariants override implementation decisions.

Authority isolation overrides infrastructure convenience.

Cryptographic correctness overrides application behavior.

Fail-closed behavior overrides availability.

The Master Protocol is authoritative over every implementation.