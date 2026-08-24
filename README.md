# AETERNA

AETERNA is a cryptographically sealed, non-custodial digital time capsule protocol.
The protocol provides:
- client-side encrypted capsules
- recipient-exclusive decrypt authority
- Trusted Time unlock enforcement
- immutable Manifest architecture
- hostile-storage resilience
- Emergency Runtime continuity
- fixed service payment model: one verified 1 USDC payment grants one capsule creation entitlement

AETERNA is designed around deterministic protocol invariants rather than infrastructure trust.

---

# Core Principles

## Recipient Authority
Decrypt authority belongs exclusively to the holder of the Recipient Capability.
Recipient secrets never leave the client and never reach backend systems.

## Client-Side Cryptography
All cryptographic operations execute locally. Servers never possess plaintext, vault keys, or recipient secrets.

## Trusted Time
Unlock eligibility derives from canonical Trusted Time. Local device time never becomes protocol authority.

## Immutable Manifest
Capsule Manifests become immutable after sealing.

## Hostile Storage
Security derives from cryptographic verification, not storage trust.

## Emergency Runtime
Emergency Runtime preserves validation parity, decrypt ordering, Heartbeat behavior, and fail-closed behavior.

## Service Payment
One verified AETERNA Service Payment of exactly 1 USDC grants exactly one Creator Credit and one capsule creation entitlement.

---

# Documentation

## Active Documentation

Active AI documentation:
- `AI/AI_CONSTITUTION.md`
- `AI/04_AGENT_RULES.md`
- `AI/07_PROJECT_GLOSSARY.md`

Active canonical documentation:
- `docs/canonical/AETERNA_COMPLETE_ENGINEERING_MODEL.md`
- `docs/canonical/AETERNA_COMPLETE_PROJECT_LOGIC.md`
- `docs/canonical/AETERNA_COMPLETE_SYSTEM_LOGIC.md`
- `docs/canonical/AETERNA_INFRASTRUCTURE.md`
- `docs/canonical/AETERNA_CREATOR_CREDIT_SPEC.md`
- `docs/canonical/AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md`
- `docs/canonical/AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md`
- `docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md`
- `docs/canonical/AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md`
- `docs/canonical/AETERNA_MULTI_RAIL_SERVICE_PAYMENT_POLICY_SPEC.md`
- `docs/canonical/AETERNA_IRYS_DIRECT_CREATOR_PAYMENT_AND_CHUNK_PAYMENT_POLICY_SPEC.md`
- `docs/canonical/AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md`
- `docs/canonical/AETERNA_USDC_AMOUNT_AND_FINALITY_POLICY_SPEC.md`
- `docs/canonical/AETERNA_AUTHORITATIVE_PUBLICATION_SEAL_VERIFICATION_AND_LIFECYCLE_RECOVERY_SPEC.md`
- `docs/canonical/AETERNA_FINALIZATION_PUBLICATION_SEAL_RECOVERY_RUNTIME_INTERFACE_SPEC.md`
- `docs/canonical/INVARIANTS.md`
- `docs/canonical/MANIFEST_EVOLUTION.md`
- `docs/canonical/VAULT_EVOLUTION.md`

Operational documentation:
- `HARDENING.md`
- `DISASTER_RECOVERY.md`

Proposed changes:
- `docs/rfc/RFC-001_CHUNK_POINTERS.md`

## Archived Documentation

`docs/archive/` contains historical and archived materials.
Archived documents are not active canonical authority.