# AETERNA CANONICAL SECURITY INVARIANTS

Status: canonical security law
Authority: protocol-critical
Scope: entire repository
Compatibility: Manifest V1 + Vault V2 + Heartbeat v1.3

---

# 1. INVARIANT DEFINITION

A security invariant is a condition that MUST remain true across all runtime states.

Violation of any invariant constitutes protocol invalidation.

Invariants override:

- implementation convenience
- frontend UX behavior
- performance optimizations
- storage behavior
- developer assumptions

---

# 2. CRYPTOGRAPHIC AUTHORITY INVARIANTS

## 2.1 Recipient Secret Exclusivity

Recipient decrypt authority MUST derive exclusively from the recipient secret.

No alternative decrypt authority may exist.

The backend MUST NEVER derive decrypt capability.

The storage layer MUST NEVER derive decrypt capability.

The creator MUST NEVER derive recipient decrypt capability.

---

## 2.2 PBKDF2 Determinism

Vault key derivation MUST remain deterministic.

The following inputs MUST remain binding:

- recipient secret
- saltBase
- openAt
- capsuleId

Changing any derivation component MUST invalidate the derived key.

---

## 2.3 AES-GCM Nonce Uniqueness

AES-GCM IV reuse MUST NEVER occur under the same key.

Chunk IV derivation MUST remain deterministic and collision-resistant.

Nonce reuse constitutes catastrophic cryptographic failure.

---

## 2.4 Hash Binding Integrity

vaultSha256 MUST bind encrypted vault integrity.

Clients MUST reject:

- hash mismatches
- truncated payloads
- mutated ciphertext
- malformed envelopes

---

# 3. TEMPORAL AUTHORITY INVARIANTS

## 3.1 Trusted-Time Exclusivity

Trusted unlock authority MUST derive exclusively from the canonical trusted-time endpoint.

Local clocks MUST NEVER unlock capsules.

Offline clocks MUST NEVER unlock capsules.

Client device time MUST NEVER override protocol time.

---

## 3.2 Unlock Boundary Enforcement

Vault decryption MUST NEVER occur before effectiveOpenAt.

All decrypt pipelines MUST verify unlock eligibility before decrypt execution.

decrypt-before-verify is forbidden.

decrypt-before-unlock is forbidden.

---

## 3.3 Heartbeat Expiration Finality

Heartbeat authority MUST collapse permanently after effectiveOpenAt.

Expired heartbeat authority MUST NEVER be recoverable.

No post-expiration extension may exist.

---

# 4. MANIFEST INVARIANTS

## 4.1 Manifest Identity Binding

capsuleId continuity MUST remain preserved across:

- manifest
- vault
- decrypt runtime
- renderer runtime

Identity mismatch MUST invalidate the runtime.

---

## 4.2 Manifest Immutability

Sealed manifests MUST remain immutable.

Clients MUST reject mutated manifests.

Storage providers MUST NOT possess manifest authority.

---

## 4.3 Manifest Validation Before Trust

Manifest fields MUST be validated before use.

No manifest field may be treated as trusted before validation.

Malformed manifests MUST terminate runtime execution.

---

# 5. STORAGE INVARIANTS

## 5.1 Storage Hostility Assumption

Storage systems MUST be treated as hostile.

Gateways MUST NEVER possess trust authority.

Encrypted blobs MUST always undergo local verification.

---

## 5.2 Upload-After-Payment

Encrypted upload MUST occur only after payment authorization succeeds.

upload-before-payment is forbidden.

---

## 5.3 Storage Isolation

Storage systems MUST remain cryptographically isolated from:

- recipient secrets
- derived vault keys
- decrypted plaintext
- heartbeat authority

---

# 6. RUNTIME INVARIANTS

## 6.1 Local-Only Decrypt Runtime

Vault decryption MUST execute locally inside the client runtime.

Plaintext MUST NEVER be transmitted externally.

---

## 6.2 Renderer Isolation

Renderer runtimes MUST treat vault contents as hostile input.

Vault rendering MUST prevent:

- HTML injection
- script execution
- DOM authority escalation
- renderer-based XSS

---

## 6.3 Capability Isolation

Recipient capability MUST remain isolated from creator authority capability.

Creator authority MUST NEVER unlock recipient vaults.

Recipient capability MUST NEVER leak through sharing flows.

---

# 7. EMERGENCY RUNTIME INVARIANTS

## 7.1 Emergency Runtime Equivalence

Emergency runtime validation MUST remain equivalent to primary runtime validation.

Emergency runtime MUST NOT weaken:

- manifest validation
- time validation
- decrypt validation
- heartbeat enforcement
- authority separation

---

## 7.2 Emergency Runtime Independence

Emergency runtime MUST remain operational without React runtime availability.

Emergency runtime MUST preserve local-only decrypt guarantees.

---

# 8. AUDIT INVARIANTS

## 8.1 Canonical Audit Layers

Security auditing MUST preserve layered authority boundaries.

Audit layers include:

1. API / Authority
2. Recipient Runtime
3. Chunk Crypto
4. Storage
5. Manifest / Vault
6. Time
7. Heartbeat
8. Open / Decrypt Pipeline
9. Renderer Runtime
10. Emergency Runtime

---

## 8.2 Audit Authority

Protocol invariants override implementation behavior.

Passing runtime behavior does NOT override invariant violations.

---

# 9. FORBIDDEN SECURITY CONDITIONS

The following conditions are protocol-invalid:

- local-time unlock
- decrypt-before-unlock
- decrypt-before-verify
- recipient authority escalation
- creator authority escalation
- AES-GCM nonce reuse
- upload-before-payment
- manifest mutation
- renderer XSS execution
- emergency runtime downgrade
- heartbeat replay extension
- stale authority persistence
- backend plaintext recovery

Any implementation introducing these conditions is invalid.

---

# 10. FINAL SECURITY PRINCIPLE

The protocol MUST fail closed.

When uncertainty exists:

- authority MUST be denied
- decryption MUST stop
- manifests MUST be rejected
- unlock MUST fail safely

Security guarantees override application availability.