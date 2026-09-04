# AETERNA — Creator Identity Architecture Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- IRYS-RESEARCH-1 findings
- Irys official documentation:
  - https://docs.irys.xyz/build/d/features/supported-tokens
  - https://docs.irys.xyz/build/d/irys-in-the-browser
  - https://docs.irys.xyz/build/d/quickstart
  - https://docs.irys.xyz/build/d/sdk/setup
  - https://docs.irys.xyz/build/d/networks

---

## 1. PURPOSE

This document defines how AETERNA maps one creator identity to one or more
network-specific wallet accounts, while preserving:

- one wallet identity for the entire capsule lifecycle;
- ability to pay AETERNA in one network/asset;
- ability to pay Irys in another network/asset;
- server-verifiable, non-custodial, replay-resistant identity binding.

This document does NOT implement the identity architecture.

## 2. CANONICAL RULE

ONE CREATOR IDENTITY
=
ONE AUTHENTICATED CREATOR WALLET IDENTITY
=
ONE CAPSULE PER SUCCESSFULLY CONSUMED CREATOR CREDIT

For one capsule lifecycle, the creator MUST use the same authenticated
creator wallet identity.

Switching to a different wallet identity during this lifecycle is forbidden.

## 3. WHAT IS CREATOR IDENTITY

Creator Identity is the server-verifiable, non-custodial, wallet-control-based
identity that AETERNA binds to a Creator Credit and a capsule lifecycle.

Creator Identity is NOT:

- a raw blockchain address sent by the frontend;
- React state;
- localStorage;
- sessionStorage;
- URL parameters;
- client-supplied claims.

Creator Identity is established by:

- server-issued challenge/nonce;
- wallet signature/proof;
- server verification.

## 4. IDENTITY OPTIONS COMPARED

### 4.1 Single wallet/provider with multichain account support

Some wallet providers expose multiple network accounts under one provider
session.

- Feasibility: depends on provider support.
- Risk: provider must safely derive/correlate accounts without exposing
  cross-account linkage assumptions that AETERNA cannot verify.
- Suitability: acceptable ONLY if provider explicitly supports the model
  and AETERNA can verify account binding server-side.

### 4.2 Reown/AppKit multichain identity model

Reown/AppKit provides wallet-agnostic connection and may expose multichain
sessions.

- Feasibility: depends on Reown/AppKit documented multichain behavior.
- Risk: abstraction may hide provider-specific account semantics.
- Suitability: acceptable as a future adapter, but not required for initial
  launch.

### 4.3 Wallet provider with EVM + Solana account support

Some providers support both EVM and Solana accounts.

- Feasibility: depends on provider documentation.
- Risk: provider must not conflate accounts from different networks into
  one identity without explicit, verifiable proof.
- Suitability: acceptable ONLY if provider explicitly documents secure
  multichain account management.

### 4.4 Separate network accounts bound to one AETERNA creator identity
through explicit cryptographic proof

Each network account is independently proven via challenge/signature.

Server stores explicit bindings:

Creator Identity
-> EVM account proof
-> Solana account proof
-> additional account proofs

- Feasibility: high; no reliance on provider-level identity linkage.
- Risk: low; each proof is independently verifiable.
- Suitability: recommended canonical architecture.

## 5. RECOMMENDED IDENTITY ARCHITECTURE

Recommended architecture:

Option 4: Separate network accounts bound to one AETERNA creator identity
through explicit cryptographic proof.

Why this is safest:

- It does NOT assume any provider-level multichain identity model.
- It does NOT conflate raw addresses with identity.
- It does NOT rely on provider-specific account linkage that AETERNA cannot
  verify.
- It supports any future provider/adapter.
- It preserves non-custodial security.
- It is compatible with provider-neutral architecture.

## 6. HOW CREATOR IDENTITY IS CREATED

Canonical flow:

1. Creator connects a wallet/provider in the browser.
2. AETERNA server issues a server-generated challenge/nonce bound to the
   exact identity-proof context.
3. Wallet signs the challenge using an officially supported signing method
   for the selected network/provider.
4. Frontend submits:
   - signed challenge;
   - network/account information;
   - provider metadata.
5. AETERNA server verifies:
   - signature is valid for the claimed account;
   - challenge/nonce is fresh and bound to the context;
   - account format is valid for the network.
6. Server creates or updates a Creator Identity record binding:
   - internal creator identity reference;
   - verified network account;
   - provider metadata;
   - proof metadata;
   - timestamps.
7. Subsequent operations bind to this Creator Identity.

### 6.1 Challenge / Nonce Requirements

Server-issued challenges and nonces MUST satisfy the following invariants:

- Server-generated: the server MUST generate the challenge/nonce.
  Frontend-generated values MUST NOT be accepted as authoritative.
- Cryptographically unpredictable: the challenge/nonce MUST be generated
  using a cryptographically secure random source.
- Single-use: each challenge/nonce MUST be consumed at most once.
  Reuse after successful verification MUST be rejected.
- Context-bound: the challenge/nonce MUST be bound to the exact
  identity-proof context, such as:
  - a specific identity-binding operation;
  - a specific network-account association operation;
  - a specific payment quote when the proof is tied to payment.
- Server-side persistence: the server MUST maintain sufficient state to
  enforce single-use, expiration, and context binding.
- Bounded expiration: the challenge/nonce MUST expire after a
  server-defined bounded time window.
- Rejection after expiration: any proof using an expired challenge/nonce
  MUST be rejected.
- Rejection after successful consumption: any proof reusing an already-
  consumed challenge/nonce MUST be rejected.
- No frontend authority: the challenge/nonce MUST be generated and
  validated server-side. Frontend-supplied timestamps or context claims
  MUST NOT be trusted.

These requirements apply to all supported networks and providers,
regardless of the specific signing method.

## 7. WALLET CONTROL PROOF

Wallet control is proven by:

- server-issued challenge/nonce;
- wallet signature/proof;
- server verification.

The frontend MUST NOT be trusted to simply submit a wallet address.

For initial launch:
- supported Solana-compatible wallet;
- Solana Wallet Standard;
- Sign In With Solana (SIWS)-compatible authentication model;
- Ed25519 signature verification.

Required wallet capability:
- `solana:signMessage`
- or equivalent SIWS/sign-in capability exposed by the wallet.

Wallet brand MUST NOT be hardcoded.
Provider-agnostic adapters are required.

Authentication message must be bound to:
- AETERNA domain/application identifier;
- network = `solana`;
- creator public key;
- server-generated challenge/nonce;
- issuedAt timestamp;
- expiration timestamp;
- unique challenge id.

The message MUST NOT include private data.

Challenge requirements:
- server-generated;
- single-use;
- expiring;
- replay-protected.

Server MUST verify:
- claimed public key;
- signature;
- exact challenge bytes;
- network = `solana`;
- challenge expiry;
- challenge not consumed.

Client-supplied `verified=true` MUST NOT be trusted.
Client-supplied `creatorIdentityId` MUST NOT be trusted.

For future providers:
- equivalent standards-based proof per provider/network.

Legacy/frozen rail:
- EVM injected provider proof remains defined for future Base reactivation.

## 8. MULTI-NETWORK ASSOCIATION

If the same creator later proves control of an account on another network:

1. Server issues a new challenge/nonce bound to an explicit identity-
   association context.
2. Wallet signs with the new network account.
3. Server verifies signature and associates the new account with the
   existing Creator Identity.
4. The Creator Identity now has multiple bound network accounts.

Requirements:

- Each network account MUST be independently proven.
- AETERNA MUST NOT assume cross-network account ownership from provider
  session state alone.
- The association MUST be explicit and server-verified.
- Association does NOT mutate the existing Creator Identity into a raw
  address; the Creator Identity remains the server-side identity object.
- Association does NOT silently alter an active capsule lifecycle.

If association fails:

- The new account MUST NOT be bound.
- The existing Creator Identity and any active lifecycle MUST remain
  unchanged.
- The creator MAY retry identity association after correcting the proof.

## 9. SERVER-SIDE DATA

Creator Identity record contains:

- creatorIdentityId: internal stable identifier;
- accounts: list of bound network accounts, each with:
  - network;
  - account address;
  - proof metadata;
  - boundAt timestamp;
- primaryProvider: provider used for initial binding;
- createdAt;
- updatedAt;
- status: active/suspended.

This record does NOT store wallet private keys.

## 10. DEFINITIONS

The following terms are defined to remove ambiguity across networks,
providers, and accounts:

- Creator Identity
  Server-verifiable, wallet-control-based identity object stored server-side.
  Creator Identity is NOT a raw blockchain address. It is the canonical
  principal to which AETERNA binds a Creator Credit and a capsule lifecycle.

- Network
  A blockchain or equivalent settlement network recognized by AETERNA for
  identity proof, AETERNA service payment, or Irys publication.
  Examples include specific EVM networks or Solana Mainnet.
  The exact supported network set is a separate configuration decision.

- Network-specific account
  An account address or identifier valid on a specific Network.
  Examples include an EVM address on Ethereum Mainnet or a Solana account
  address on Solana Mainnet.
  A network-specific account is a credential identifier, not an identity
  object by itself.

- Wallet/provider session
  A browser-side connection to a wallet/provider that exposes signing and
  account capabilities.
  A wallet/provider session MAY expose one or more network-specific
  accounts, but provider session state is NOT authoritative for identity.

- Bound account
  A network-specific account that has been independently proven via
  server-issued challenge/signature and explicitly recorded in the Creator
  Identity record.
  Only bound accounts participate in AETERNA service payment or Irys
  publication under that Creator Identity.

- Active account for a lifecycle step
  The bound network account selected for the current capsule lifecycle step,
  as required by the server-side protocol for that step.
  The active account for a step MUST be a bound account.
  The active account MUST NOT change mid-step without explicit server
  verification and lifecycle rules.

Relationship:

Creator Identity
-> one or more bound accounts
-> each bound account belongs to one network-specific account
-> each bound account is independently proven
-> wallet/provider session is only the mechanism used to prove control,
   not the identity itself

During one capsule lifecycle:

- Creator Identity MUST NOT change.
- Bound network accounts MUST NOT change mid-lifecycle.
- Switching wallet/provider/network account during capsule lifecycle is
  forbidden.
- The active account for the current step is fixed for that step and MUST
  be a bound account recorded in the Creator Identity.

If the creator changes wallet/network/provider:

- current capsule lifecycle MUST be treated as aborted;
- Creator Credit MUST be restored to AVAILABLE if it was CONSUMING;
- a new lifecycle requires re-establishing Creator Identity with the new
  wallet/account via fresh challenge/signature and server verification.

## 11. AETERNA PAYMENT FLOW

AETERNA service payment flow:

1. Creator connects initial wallet/provider.
2. Creator Identity is established or retrieved.
3. AETERNA server creates Creator Service Payment Quote:
   - USD 1.00;
   - selected AETERNA payment asset;
   - exact atomic amount;
   - immutable quote.
4. Wallet confirms payment in the selected network/asset.
6. AETERNA server verifies payment against the immutable quote.
7. Creator Credit is granted to the Creator Identity.
8. Creator Credit becomes AVAILABLE.
9. After successful payment, the user returns to the same prepared /create workspace.
10. Final CREATE CAPSULE requires the same verified creator wallet/account used for the service payment.
11. If the current connected account or creator identity does not match the verified payment identity, creation MUST fail closed.

Key rule:

- AETERNA payment asset is chosen from AETERNA’s approved allowlist.
- AETERNA payment asset does NOT determine Irys payment asset.

## 12. IRYS PAYMENT FLOW

Irys publication flow:

1. Creator prepares capsule.
2. When ready, Irys publication begins.
3. The same Creator Identity is used.
4. Creator may select an Irys-supported payment asset, potentially on a
   different network than the AETERNA payment.
5. If the Irys asset/network requires additional proof of account control,
   the server MUST verify it and bind it to the existing Creator Identity
   before or during the Irys flow.
6. If the wallet changes after AETERNA service payment but before final CREATE CAPSULE, the existing AVAILABLE Creator Credit MUST NOT be consumed by the new identity.
7. Irys determines actual publication/storage cost.
8. Creator pays Irys through the supported Irys flow.
9. Irys publication succeeds.
10. Seal succeeds.
11. Creator Credit becomes CONSUMED.

Key rule:

- Irys payment asset is independently selected from Irys-supported assets.
- Irys payment asset does NOT determine AETERNA service payment asset.

## 13. WALLET-SWITCHING RULES

If the user changes wallet/provider:

- The new wallet/provider MUST re-establish Creator Identity via fresh
  challenge/signature.
- The new Creator Identity MUST NOT inherit the previous Creator Credit
  or capsule lifecycle.
- Any in-progress capsule lifecycle using the old identity MUST be treated
  as aborted.
- Creator Credit MUST be restored to AVAILABLE if it was CONSUMING.

If the user changes network account within the same provider:

- This is treated as a new wallet/account for identity purposes.
- Same rules as wallet change apply.

## 14. NETWORK-SWITCHING RULES

Definitions used in this section:

- Required network/account for a step:
  The network/account required by a capsule lifecycle step is determined
  by explicit server-side protocol or payment operation requirements.
  It is NOT determined by frontend preference, provider session state,
  or client claims.

If the user switches network within the same wallet/provider during a
capsule lifecycle:

- The active account for the current step MUST match the required
  network/account for that step.
- AETERNA service payment MUST use the network/asset specified in the
  immutable quote.
- Irys publication MUST use the network/asset supported by the final Irys
  production flow.
- A network switch does NOT preserve authorization for the current step
  unless the server explicitly verifies the new network account, binds it
  to the Creator Identity, and the step rules allow the switch.

If the user attempts to continue a capsule lifecycle on a different network
account:

- This is treated as a potential identity change.
- Server MUST verify explicit account proof and identity association before
  allowing continuation.
- Without explicit proof, the lifecycle MUST be rejected.

If the user changes account, chain/network, or provider:

- This is treated as a wallet/identity change.
- The active capsule lifecycle MUST be aborted.
- Creator Credit MUST be restored to AVAILABLE if it was CONSUMING.
- A new lifecycle requires re-establishing Creator Identity.

## 15. WHAT THE USER SEES

User-facing principles:

- "Connect Wallet" establishes your creator identity.
- Your creator identity follows you through the whole capsule journey.
- AETERNA service fee: $1, shown in your selected asset.
- Irys publication cost: shown separately, may use a different asset.
- If you change wallet or network, you may need to confirm your identity
  again.
- Your creator identity is not a blockchain address you type manually.

## 16. CLOUDFLARE IDENTITY ENDPOINT ARCHITECTURE

This section defines only the architectural responsibilities for server-side
identity endpoints in a Cloudflare Pages/Workers environment.

It does NOT define exact route names, KV schemas, database keys, or
implementation code.

Responsibilities:

- challenge issuance:
  server generates and stores challenge/nonce with context binding and
  expiration;
- proof verification:
  server verifies wallet signature/proof against claimed account and
  challenge;
- Creator Identity creation/retrieval:
  server creates or retrieves Creator Identity record after successful
  proof;
- network-account association:
  server verifies independent proof for additional network accounts and
  explicitly associates them with an existing Creator Identity;
- lifecycle identity binding:
  server binds capsule lifecycle operations to an immutable Creator
  Identity.

Authority:

- All identity decisions MUST be authoritative server-side.
- Frontend MAY display identity state.
- Frontend MUST NOT create, modify, or prove identity state.

Compatibility:

- Identity endpoints MUST be browser-compatible.
- Identity endpoints MUST NOT depend on Node-only runtime assumptions.
- Identity endpoints MAY be hosted on Cloudflare Pages/Workers.

## 17. SECURITY MODEL

Security requirements:

- server-verifiable wallet control for each bound account;
- replay-resistant challenge/nonce per proof;
- frontend non-authority;
- immutable Creator Identity during capsule lifecycle;
- explicit proof required for each network account association;
- no automatic cross-network account inference;
- Creator Credit binding is to Creator Identity, not raw address;
- wallet change/network change triggers identity re-establishment or
  lifecycle abortion.

### 17.1 Challenge / Nonce Security

All identity proof challenges and nonces MUST enforce:

- server generation;
- cryptographic unpredictability;
- single-use semantics;
- bounded expiration;
- context binding to the exact identity-proof or association operation;
- rejection after expiration or reuse;
- server-side authority over all validation.

### 17.2 Recommended Protections

The following protections are recommended but NON-BLOCKING unless required
by another canonical AETERNA document:

- rate limiting / throttling on identity proof endpoints;
- audit logging for identity creation, association, and lifecycle events.

## 18. DECISION SUMMARY

1. What exactly is Creator Identity?
- Server-verifiable, wallet-control-based identity bound to one or more
  independently proven network accounts.

2. How is it created?
- Server-issued challenge/nonce + wallet signature + server verification.

3. How is wallet control proven?
- Challenge/signature per network account, verified server-side.

4. How are EVM + Solana accounts associated if needed?
- Each account is independently proven and explicitly bound to the same
  Creator Identity by the server.

5. What data is stored server-side?
- Creator Identity record with bound network accounts and proof metadata.
- No private keys.

6. What is immutable during one capsule lifecycle?
- Creator Identity and its bound network accounts.

7. Can the same identity pay AETERNA in one network and Irys in another?
- Yes, provided the same Creator Identity is used and any additional
  network account proofs are verified as required.

8. What happens if the user changes wallet?
- New wallet must re-establish Creator Identity; old lifecycle/credit is
  separated; credit restored if CONSUMING.

9. What happens if the user changes network?
- Treated as new account/identity unless server explicitly verifies and
  binds; otherwise lifecycle rejected.

10. What should the user see?
- Clear connect/identity flow; clear separation of AETERNA $1 and Irys
  cost; clear warning if wallet/network change breaks lifecycle.

## 18. OPEN ISSUES

- Exact challenge/nonce format and expiration.
- Exact signing standard per provider/network.
- Whether provider-level multichain identity models can be safely adopted
  in future without explicit per-account proof.
- Exact UX for cross-network identity association.
- Final Cloudflare integration details for identity endpoints.
- Security review of cross-network binding flow.
- Legal review of identity model.

## 19. REFERENCES

- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- Irys official documentation:
  - https://docs.irys.xyz/build/d/features/supported-tokens
  - https://docs.irys.xyz/build/d/irys-in-the-browser
  - https://docs.irys.xyz/build/d/quickstart
  - https://docs.irys.xyz/build/d/sdk/setup
  - https://docs.irys.xyz/build/d/networks
