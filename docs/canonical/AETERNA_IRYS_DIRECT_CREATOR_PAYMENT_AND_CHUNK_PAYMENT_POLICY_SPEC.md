# AETERNA — Irys Direct Creator Payment and Chunk Payment Policy Specification

Status: Canonical Target Policy / Implementation Pending
Authority: Business Layer
Version: 1.0
Reference:
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_CREATOR_CREDIT_CONSUMPTION_AND_CAPSULE_CREATION_INTERFACE_SPEC.md
- AETERNA_MULTI_RAIL_SERVICE_PAYMENT_POLICY_SPEC.md

---

## 1. PURPOSE

This document defines the canonical boundary between:
- AETERNA Service Payment;
- Irys publication/storage economics;
- chunked upload mechanics.

This document does NOT implement Irys integration, browser wallet flow,
Executor Hot runtime changes, or protocol core changes.

---

## 2. AETERNA SERVICE PAYMENT BOUNDARY

AETERNA Service Payment:
- amount: exactly 1 USDC;
- purpose: one capsule creation entitlement.

AETERNA Service Payment:
- does NOT pay for Irys storage;
- does NOT pay for Irys publication;
- does NOT pay for capsule content size;
- does NOT pay for chunk count;
- does NOT pay for storage duration;
- does NOT pay for additional blocks.

Canonical rule:
- AETERNA $1 and Irys cost are separate economic operations.

---

## 3. IRYS ECONOMICS

Irys publication/storage:
- separate economic layer from AETERNA Service Payment;
- paid directly by the creator;
- determined by Irys, not by AETERNA.

Canonical target:
Creator -> Irys -> Creator pays Irys directly.

AETERNA does not:
- pre-fund Irys on behalf of the creator as part of the $1;
- include Irys cost in the $1 service fee;
- use Irys payment state as AETERNA business authority.

Target status:
- CREATOR-PAID IRYS = APPROVED CANONICAL TARGET.

Implementation status:
- CREATOR-PAID IRYS IMPLEMENTATION = PENDING.

---

## 4. EXECUTOR HOT BOUNDARY

Executor Hot:
- CURRENT IMPLEMENTATION: server-side publication authority;
- CANONICAL TARGET BUSINESS ROLE: excluded from target business payment model.

Executor Hot:
- is NOT the AETERNA Service Payment recipient;
- is NOT the target business payment authority;
- does NOT define AETERNA pricing.

If current runtime uses Executor Hot-funded publication:
- document it as CURRENT IMPLEMENTATION GAP only;
- do not present it as canonical business model.

---

## 5. CHUNKING SEMANTICS

Chunks are a technical implementation detail for:
- encrypted payload assembly;
- bounded uploads;
- large-capsule publication mechanics.

Chunk semantics:
- chunk count does NOT increase AETERNA payment;
- chunk count does NOT create additional AETERNA payments;
- chunk count does NOT create additional entitlements.

Canonical rule:
- 1 capsule -> 1 AETERNA Service Payment.

For Irys:
- creator pays Irys separately;
- chunk count is irrelevant to AETERNA business logic.

---

## 6. PRE-CAPSULE PAYMENT IDENTITY

During landing payment:
- capsuleId does NOT yet exist.

Canonical pre-capsule payment identity:
- paymentIntentId.

Rules:
- paymentIntentId != capsuleId;
- Service Quote is keyed by paymentIntentId;
- Verified Payment is keyed by paymentIntentId;
- Creator Credit index is keyed by paymentIntentId;
- capsuleId appears only after actual capsule creation begins.

---

## 7. SERVICE PAYMENT IDENTITY CHAIN

Canonical chain:
- paymentIntentId -> immutable Service Quote -> payment verification -> Verified Payment -> Creator Credit -> entitlement -> /create -> capsule creation -> real capsuleId.

Forbidden:
- using capsuleId="landing";
- using fake/synthetic 64-hex capsuleId as payment identity;
- requiring existing capsuleId before payment.

---

## 8. SIZE AND CONTENT

Content size:
- may exist as technical metadata;
- may exist as encryption metadata;
- may exist as upload/storage metadata;
- may exist as informational UI.

Content size:
- does NOT affect AETERNA Service Payment;
- does NOT affect entitlement count;
- does NOT affect Creator Credit grant.

Block pricing / MB tiers / progressive AETERNA pricing:
- explicitly excluded from canonical model.

---

## 9. CURRENT IMPLEMENTATION GAP

Current implementation gaps vs this canonical policy:
- Executor Hot currently performs publication authority;
- Irys economics are not yet separated from AETERNA $1 in runtime;
- paymentIntentId migration is pending;
- chunk-level AETERNA payment UX is not implemented and must remain pending.

These gaps:
- do NOT change the canonical target policy;
- do NOT make current Executor Hot publication the canonical business model;
- do NOT justify per-chunk AETERNA payments.

---

## 10. FUTURE MIGRATION

Future migration requirements:
- migrate quote/verify/credit keys from capsuleId to paymentIntentId;
- separate Irys cost presentation from AETERNA $1 presentation;
- remove any remaining size-based AETERNA pricing from active runtime;
- ensure chunk count never affects AETERNA business state.

---

FINAL CONFIRMATION:

"No production code, API keys, wallets, Cloudflare resources, payment integrations, Irys implementation, protocol core, storage, Seal, or frontend were created, modified, or deleted."
