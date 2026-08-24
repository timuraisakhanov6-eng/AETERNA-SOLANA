# AETERNA — Creator Credit Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0

---

## 1. NAME

Creator Credit

## 2. PURPOSE

Creator Credit is the entitlement that gives an authenticated creator
the right to successfully create one AETERNA capsule.

Creator Credit is the canonical service entitlement object.

Creator Credit is not a storage allocation, storage balance, publication
cost, or Irys payment instrument.

## 3. PRICE

The AETERNA service fee for one Creator Credit is fixed at USD 1.00
equivalent.

The Creator Credit price:

- does NOT depend on capsule size;
- does NOT use storage blocks;
- does NOT depend on Irys storage cost;
- is NOT an Irys storage price.

Payment Quote expiration and Creator Credit expiration are different things.

A Payment Quote may expire.

Creator Credit does NOT expire.

## 4. ACQUISITION

One successfully verified AETERNA service payment creates at most one
Creator Credit.

A duplicate verification of the same payment MUST NOT create another
Creator Credit.

Repeated verification of the same payment must return the existing
entitlement or an equivalent already-processed result rather than
minting another Credit.

## 5. IDENTITY

Creator Credit is bound to one authenticated creator wallet identity.

For the entire capsule lifecycle, the creator MUST use the same
authenticated creator wallet identity:

AETERNA service payment
-> Creator Credit
-> capsule creation
-> Irys publication
-> Seal

Switching to a different wallet identity during this lifecycle is forbidden.

This specification defines only the rule:

- Creator Credit belongs to the authenticated creator identity.

The concrete wallet provider, wallet protocol, blockchain, payment asset,
signature scheme, and wallet authentication mechanism are NOT YET SELECTED.

Do NOT hardcode:
- legacy Paddle;
- legacy bank-card rails;
- legacy Web3 provider assumptions;
- any specific wallet provider.

Use an abstract concept:

Authenticated Creator Identity

The concrete Wallet/Payment Architecture will be specified separately.

Current active implementation:
- Base Mainnet / native USDC via minimal EIP-1193 browser provider.

Future adapters:
- Additional wallet/provider adapters may be added only through explicit canonical selection.

## 6. STATE MACHINE

Canonical states:

- AVAILABLE
- CONSUMING
- CONSUMED

Transitions:

- AVAILABLE -> CONSUMING -> CONSUMED
- CONSUMING -> AVAILABLE on failure before successful final result

State meaning:

- AVAILABLE
  Creator may use the entitlement to create one capsule.

- CONSUMING
  The entitlement is reserved for one active creation attempt.
  No second concurrent attempt may use the same entitlement.

- CONSUMED
  The creator's capsule has successfully completed the canonical
  publication + sealing result.
  The entitlement can never be reused.

## 7. WHEN CREDIT IS CONSUMED

Creator Credit is NOT consumed when:

- payment is initiated;
- payment is verified;
- /create is opened;
- Create is clicked;
- content editing begins;
- preparation begins;
- upload begins;
- Irys publication begins.

Creator Credit becomes CONSUMED ONLY after:

1. required publication has successfully completed;
2. canonical Seal has successfully completed;
3. capsule reaches the successful sealed result.

## 8. FAILURE SAFETY

If anything fails before successful final seal:

- wallet rejection;
- page close;
- browser restart;
- network failure;
- preparation failure;
- upload failure;
- Irys publication failure;
- sealing failure;
- any other non-success terminal error;

the Creator Credit remains AVAILABLE or is safely restored to AVAILABLE
from CONSUMING.

A creator must NOT have to pay another USD 1.00 merely because the system
failed before producing the successful capsule result.

## 9. CONCURRENCY / DOUBLE-SPEND

One AVAILABLE Creator Credit may be reserved by only one active creation
attempt.

The transition:

- AVAILABLE -> CONSUMING

must be atomic.

Two browser tabs, repeated requests, retries, or concurrent API calls
must NOT allow one Credit to produce two successful capsules.

## 10. PAYMENT IDEMPOTENCY

One verified payment event may produce maximum 1 Creator Credit.

Repeated verification of the same payment must return the existing
entitlement or an equivalent already-processed result rather than
creating another Credit.

## 11. FRONTEND AUTHORITY

Frontend state is NEVER authoritative.

The following cannot create or prove Creator Credit:

- React state;
- localStorage;
- sessionStorage;
- URL parameters;
- client-supplied "paid" flags;
- client-supplied wallet ownership claims;
- client-supplied credit status.

Server-side authority is authoritative.

## 12. WALLET BINDING

Creator Credit cannot be transferred between creator identities.

The current specification defines only the rule:

- Credit belongs to the authenticated creator identity.

Exact wallet authentication and wallet disconnect/reconnect behavior
must be specified in the separate Wallet / Payment Architecture
specification.

Do NOT invent that behavior here.

## 13. IRYS SEPARATION

Creator Credit pays only for the AETERNA service entitlement.

It does NOT represent:

- storage capacity;
- Irys storage balance;
- Irys gas;
- Irys publication cost;
- capsule size;
- storage blocks.

Irys publication/storage is a separate layer.

The actual Irys payment flow remains pending the finalized Irys
production architecture.

## 14. USER MODEL

Human-readable explanation:

- USD 1.00 gives the creator one right to successfully create one
  capsule.
- The credit has no expiration.
- The creator can take as long as needed.
- The credit is consumed only after a successful capsule result.
- If creation fails before success, the creator keeps the credit.
- After successful creation, the credit is consumed and the next
  capsule requires another Creator Credit.

## 15. NON-GOALS

This specification does NOT define:

- wallet provider;
- wallet connection UI;
- supported payment assets;
- price oracle;
- payment quote implementation;
- blockchain;
- Irys uploader;
- Irys signing flow;
- payment transaction format;
- final Creator Credit storage/KV schema;
- API endpoints.

Those belong to later architecture specifications.
