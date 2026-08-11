# AETERNA Manifest Evolution Rules

Status: canonical

Authority: manifest governance layer

---

# 1. PURPOSE

This document defines immutable evolution rules for AETERNA manifest schemas.

Manifest compatibility is protocol-critical.

---

# 2. MANIFEST PRINCIPLE

Manifests are immutable protocol authority objects.

Manifest mutation after sealing is forbidden.

---

# 3. MANIFEST VERSIONING

Manifest schemas MUST be versioned.

Current canonical version:

- Manifest V1

Unknown manifest versions MUST fail closed.

---

# 4. STABLE FIELDS

The following Manifest V1 fields are protocol-stable:

- version
- capsuleId
- sealedAt
- openAt
- vaultTxId
- encryptedSizeBytes
- saltBase
- heartbeatInterval

The following integrity field is mandatory within the ext namespace:

- ext.vaultSha256

Changes to the semantics of any stable field REQUIRE protocol migration review.

---

# 5. OPTIONAL FIELDS

Optional fields MAY be introduced only when:

- older runtimes fail closed safely
- authority semantics remain unchanged
- validation remains deterministic

Optional fields MUST NOT weaken invariant enforcement.

---

# 6. HEARTBEAT FIELDS

Heartbeat-related manifest field:

- heartbeatInterval

Heartbeat semantics are defined by the canonical Heartbeat specification.

Changes REQUIRE compatibility review.

---

# 7. EXTENSION FIELDS

The ext object MAY contain protocol extensions.

Extensions MUST:

- remain deterministic
- preserve fail-closed semantics
- avoid authority escalation
- preserve compatibility boundaries

Unknown extensions MUST fail closed when required by security semantics.

Mandatory integrity extensions defined by the current canonical Manifest version remain protocol-stable.

---

# 8. MANIFEST VALIDATION

Manifest validation MUST remain:

- deterministic
- fail-closed
- runtime-consistent
- invariant-preserving

Validation weakening is forbidden.

---

# 9. IDENTITY CONTINUITY

capsuleId continuity is mandatory.

Manifest identity MUST remain consistent across:

- runtime loading
- decrypt pipeline
- emergency runtime
- storage retrieval

Identity drift is forbidden.

---

# 10. TEMPORAL STABILITY

Temporal semantics MUST preserve:

- trusted-time exclusivity
- unlock ordering
- effectiveOpenAt semantics
- Heartbeat behavior

Local-time authority is forbidden.

---

# 11. STORAGE STABILITY

Storage-related manifest fields MUST preserve:

- immutable blob identity
- integrity verification compatibility
- hostile gateway assumptions

Storage trust escalation is forbidden.

---

# 12. SECURITY EVOLUTION RULE

Manifest evolution MUST NOT weaken:

- recipient authority isolation
- cryptographic integrity
- fail-closed behavior
- runtime parity

Security regressions are forbidden.

---

# 13. BREAKING CHANGE RULE

Breaking manifest changes REQUIRE:

1. new manifest version
2. compatibility review
3. migration analysis
4. runtime parity review
5. audit review

Silent manifest evolution is forbidden.

---

# 14. FINAL PRINCIPLE

Manifest schemas are security-critical protocol surfaces.

Every Manifest evolution shall preserve canonical protocol compatibility.