# AETERNA

AETERNA is a cryptographically sealed, non-custodial digital time capsule protocol.

The protocol provides:

- client-side encrypted capsules
- recipient-exclusive decrypt authority
- Trusted Time unlock enforcement
- immutable Manifest architecture
- hostile-storage resilience
- Emergency Runtime continuity

AETERNA is designed around deterministic protocol invariants rather than infrastructure trust.

---

# Core Principles

## Recipient Authority

Decrypt authority belongs exclusively to the holder of the Recipient Capability.

Recipient secrets:

- never leave the client
- never reach backend systems
- never appear in manifests
- never appear in storage providers

Capability possession defines decrypt authority.

---

## Client-Side Cryptography

All cryptographic operations execute locally:

- key derivation
- vault encryption
- AES-256-GCM decryption
- integrity verification

Servers never possess:

- plaintext
- vault keys
- recipient secrets

---

## Trusted Time

Unlock eligibility derives from canonical Trusted Time.

Trusted Time participates only in Open Authority.

Local device time never becomes protocol authority.

---

## Immutable Manifest

Capsule Manifests become immutable after sealing.

Manifest mutation invalidates protocol correctness.

---

## Hostile Storage

Storage infrastructure is treated as hostile.

Security derives from:

- SHA-256 verification
- AES-256-GCM authentication
- canonical validation

Never from storage trust.

---

## Emergency Runtime

Emergency Runtime preserves protocol continuity during infrastructure failure.

Emergency Runtime preserves:

- validation parity
- decrypt ordering
- Heartbeat behavior
- Open Authority semantics
- fail-closed behavior

---

# Architecture

AETERNA consists of the following layers:

| Layer | Responsibility |
|---|---|
| Creator Runtime | Capsule creation |
| Recipient Runtime | Unlock and decrypt |
| Emergency Runtime | Recovery continuity |
| API Layer | Trusted Time + Business services |
| Storage Layer | Ciphertext persistence |
| Crypto Layer | Encryption and integrity |

Runtime Layer performs execution only.

Runtime Layer is **not** an Authority.

---

# Authority Domains

The protocol separates authority into independent domains:

| Authority | Responsibility |
|---|---|
| Ciphertext Authority | Vault integrity |
| Open Authority | Trusted Time + unlock policy |
| Business Authority | Creator Service Quote + service-payment validation + Creator Credit authority |
| Storage Authority | Immutable ciphertext persistence |

Authority Domains remain isolated.

---

# Streaming Model

AETERNA preserves:

- Streaming Preview
- Streaming Upload
- Streaming Download
- Streaming Reconstruction
- Bounded Memory

Whole-capsule buffering is never required by the protocol.

---

# Security Model

AETERNA is designed around:

- protocol invariants
- authority isolation
- fail-closed behavior
- deterministic validation
- hostile infrastructure assumptions
- runtime parity
- cryptographic verification supremacy

Protocol correctness derives from invariant preservation.

---

# Canonical Documentation

Core protocol documentation:

| Document | Purpose |
|---|---|
| Master Protocol | Canonical protocol specification |
| Complete System Logic | Canonical protocol behavior |
| Canonical Specifications | Domain-specific specifications |
| Threat Model | Security assumptions |
| Runtime Specifications | Runtime architecture |
| Cryptographic Specifications | Cryptographic architecture |
| Audit Documentation | Security audits |

---

# Development

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

---

# License

See the repository license for licensing information.