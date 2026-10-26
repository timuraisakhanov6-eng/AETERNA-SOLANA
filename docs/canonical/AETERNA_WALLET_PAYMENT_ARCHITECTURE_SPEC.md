# AETERNA — Wallet / Payment Architecture Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Supersedes: legacy Paddle / card / Base-USDC-only architecture notes

Active canonical creator rail:
- supported Solana-compatible wallet on Solana Mainnet.

Base rail status:
- FROZEN / RESERVED FOR FUTURE ACTIVATION.
- Base remains in repository for future reactivation.
- Base is NOT the active canonical creator rail.

---

## 1. NAME

Wallet / Payment Architecture Specification

## 2. PURPOSE

This document defines the canonical architecture for how AETERNA accepts
Web3 service payments and grants Creator Credit.

This document defines wallet abstraction, payment asset abstraction,
payment verification, and the boundary between AETERNA service payment
and Irys publication/storage.

This document does NOT implement those behaviors.

## 3. SCOPE BOUNDARY

This specification covers only the AETERNA service payment flow that
grants Creator Credit.

This specification explicitly excludes:

- Irys publication/storage payment flow;
- capsule creation semantics;
- sealing semantics;
- crypto semantics;
- storage semantics;
- frontend UI implementation;
- Protocol page content;
- CapsuleHold behavior.

## 4. REFERENCE AUTHORITY

This specification is subordinate to:

- AETERNA_CREATOR_CREDIT_SPEC.md

If this document conflicts with the Creator Credit Specification,
the Creator Credit Specification is authoritative.

## 5. WALLET ABSTRACTION

AETERNA defines an abstract Wallet Provider layer.

The Wallet Provider layer is responsible for wallet-level capabilities
required by the service payment flow.

The concrete wallet provider, wallet protocol, blockchain, and signing
mechanism are NOT selected at the protocol layer. (Model 01 selects Phantom
as its sole supported wallet provider at the UX/integration layer; see
AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md §4.1.)

This document defines only the abstract capabilities the Wallet Provider
MUST expose:

### 5.1 Required Capabilities

- connect wallet
- disconnect wallet
- identify creator
- prove wallet control
- request payment/signature
- expose selected network/asset
- report transaction/reference
- detect rejected/cancelled action

### 5.2 Requirements

- The Wallet Provider layer MUST be replaceable without changing
  Creator Credit business rules.
- The Wallet Provider layer MUST NOT be hardcoded to any specific wallet
  provider in a way that makes the layer itself provider-dependent:
  - MetaMask;
  - Reown;
  - WalletConnect;
  - Solana wallets;
  - EVM wallets;
  - any specific wallet provider.
- Model 01 MAY restrict the supported wallet provider to Phantom as a
  UX/integration policy (see AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md §4.1)
  without violating this requirement, because the layer remains replaceable
  and Creator Credit business rules are unchanged.
- The concrete Wallet Provider selection belongs to a separate
  implementation decision.

## 6. AUTHENTICATED CREATOR IDENTITY

AETERNA conceptually establishes:

"This creator controls this wallet."

### 6.1 Requirements

Server-side creator identity MUST be:

- server-verifiable;
- replay-resistant;
- bound to a challenge/nonce or equivalent;
- not reliant solely on an address sent by the frontend;
- not reliant on localStorage;
- not reliant on React state.

### 6.2 Pending Decisions

The concrete wallet authentication and signing standard are NOT YET
SELECTED.

This document records only the requirement, not the implementation.

## 7. PAYMENT ASSET ABSTRACTION

AETERNA Web3 payment architecture MUST support payment assets that are:

1. supported by the production Irys payment/publication flow;
2. explicitly approved by AETERNA.

### 7.1 Irys Support vs AETERNA Approval

Irys support for an asset does NOT automatically mean AETERNA supports
that asset.

AETERNA-approved assets form the active service payment allowlist.

### 7.2 Abstract PaymentAsset

The following abstract fields represent a payment asset:

- network
- asset identifier
- symbol
- decimals
- payment capabilities
- wallet capability
- Irys compatibility
- pricing source
- active/disabled status

The concrete asset allowlist is a separate configuration decision.

## 8. AETERNA SERVICE FEE QUOTE

AETERNA service price is fixed at exactly 1 USDC.

AETERNA uses a server-side commercial entitlement object for payment
validation:

Creator Service Payment Quote

### 8.1 Required Fields

The quote MUST contain only commercial/payment values required for
verification and entitlement:

- quoteId
- creator identity binding
- serviceFeeUsdc = 1
- selected payment asset
- exact atomic payment amount
- recipient
- createdAt
- expiresAt
- status

### 8.2 Quote vs Credit

Payment Quote expiration and Creator Credit expiration are different
concepts.

- Payment Quote may expire.
- Creator Credit does NOT expire.

A Creator Credit is granted only after a verified payment against an
immutable quote.

## 9. NO PRICE CONVERSION

The AETERNA service fee is natively denominated and settled in USDC. No price
conversion applies:

1 USDC
-> fixed atomic amount (1,000,000 atomic units)
-> immutable payment quote

### 9.1 Requirements

There is no price source, exchange rate, or oracle for the AETERNA service fee.

### 9.2 Frontend Role

The frontend MAY DISPLAY the amount.

The frontend does NOT determine the authoritative amount.

### 9.3 Pending Decisions

None for the AETERNA service fee denomination: it is fixed at exactly 1 USDC.

## 10. PAYMENT VERIFICATION

Server-side payment verification checks the actual payment against the
immutable Creator Service Payment Quote.

### 10.1 Minimum Verification Requirements

Verification MUST confirm:

- correct network;
- correct asset;
- correct recipient;
- correct amount;
- correct creator identity;
- correct transaction/reference;
- correct quote;
- valid status/finality;
- no replay.

### 10.2 Idempotency

One verified payment event may produce maximum 1 Creator Credit.

Duplicate verification of the same payment MUST return the existing
entitlement or an equivalent already-processed result.

### 10.3 Abstraction Requirement

The exact chain transaction format is rail-specific.
For the active Solana rail, this is SPL Token transfer evidence.
For future rails, the exact format remains implementation-selection PENDING.

### 10.4 Released Solana transaction-validation protections

Released implementation (verified against the released source; src/lib/wallet/solanaWallet.ts, functions/api/solana/broadcast.ts, functions/lib/solana/legacyTransaction.ts). These protections are factual descriptions of the released code, not new policy.

Client message-identity guard. After the wallet returns a signed message, the client requires it to be byte-identical to the message AETERNA prepared. The only accepted alternative is the narrowly defined Phantom delta described below. Anything else — a single changed account, amount, mint, authority, destination, blockhash, or instruction — raises WalletModifiedTransactionError (code WALLET_MODIFIED_TRANSACTION) and the signed bytes never leave the browser. An unparseable returned message is never acceptable. Optional diagnostics (dumping the structured difference) are enabled only with `?aeternaWalletDiag=1`.

Phantom allowance (bounded). The wallet may:

- append at most two ComputeBudget instructions — one `setComputeUnitLimit` (limit must not exceed 1,400,000 CU) and one `setComputeUnitPrice`;
- the worst-case priority fee they can request, ceil(limit × price / 1,000,000) lamports using the protocol maximum of 1,400,000 CU when the wallet sets no limit, must not exceed MAX_WALLET_PRIORITY_FEE_LAMPORTS = 1,000,000 lamports (0.001 SOL);
- append Lighthouse assertions ONLY as the exact two-instruction pair, in order, after the payment: AssertAccountInfoMulti on the payer (KnownOwner(System), DataLength==0), then AssertTokenAccountMulti on the transfer's source token account (Amount >= lower bound, Delegate == null, DelegatedAmount <= 0, TokenAccountOwnerIsDerived). The Lighthouse program is L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95. Unknown versions, variants, discriminators, values, extra assertions, extra accounts, duplicates, or a different order are refused. These assertions are read-only: they cannot move tokens, and the payment transfer itself is still compared exactly;
- every instruction AETERNA prepared must still match exactly — same program, same resolved account keys in the same order, same data bytes; the fee payer, blockhash, and signer count must be unchanged; every prepared account key must keep its exact signer/writable role;
- the only account keys the wallet may append are the ComputeBudget and Lighthouse program IDs, each unsigned and read-only, and only when the corresponding instructions were actually added.

Server validation contract — POST /api/solana/broadcast. The server independently re-validates everything before broadcasting:

- strict legacy-message parsing with a hard cap of six instructions (MAX_LEGACY_INSTRUCTIONS = 6; zero instructions or seven or more are rejected with INVALID_INSTRUCTION_COUNT);
- exactly one required signature (a message with numRequiredSignatures !== 1 is refused);
- the payment must be an SPL Token transfer of exactly SERVICE_PAYMENT_ATOMIC = 1,000,000 atomic units (1 USDC) of mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v to the settlement address 6Ku9wGoYBwGDBAK3D7XxoXMYosDBtoadGWUQg4aZ2MBu (UNEXPECTED_AMOUNT otherwise); optional ATA-create for the settlement account is recognized;
- the RPC endpoint is server-configured only, and mainnet-beta is proven via genesis hash before any submission;
- the priority-fee ceiling is re-enforced server-side (PRIORITY_FEE_TOO_HIGH);
- the Lighthouse pair, if present, is re-validated independently: info first, token second, exactly two, and the token-assertion target must equal the transfer's source ATA resolved by address;
- a per-account signer/writable privilege table is enforced: no unknown, duplicate, or differently-privileged account keys; ComputeBudget and Lighthouse program keys are legitimate only when their instructions were actually added, and stray keys are refused;
- the creator identity is resolved server-side, and the payment signature is bound atomically through the CreditOperationCoordinator before submission; a refused binding means sendTransaction is never called;
- on any rejection the endpoint fails closed and nothing is broadcast. Every refusal carries an explicit broadcastAttempted flag: false means the request was refused before sendTransaction was ever called; true means the refusal happened at or after the RPC call, so the on-chain outcome is unknown.

Provenance limitation: these protections are documented from the released candidate source. The exact original 27-byte Phantom assertion payload observed during development was not independently recovered (a synthetic fixture was used during development), and the deployed Worker bytes were not independently downloaded; the server-side description reflects the released source, not a byte-level verification of the deployed Worker.

## 11. CREATOR CREDIT BOUNDARY

The Wallet/Payment Architecture grants Creator Credit.

The Wallet/Payment Architecture does NOT define capsule creation
semantics.

Creator Credit rules remain authoritative in:

- AETERNA_CREATOR_CREDIT_SPEC.md

The boundary is:

verified service payment
-> grant one Creator Credit

Payment system behavior after granting credit is governed by the
Creator Credit Specification, not this document.

## 12. IRYS SEPARATION

AETERNA service payment and Irys publication/storage are separate layers.

AETERNA 1 USDC service payment:

- grants Creator Credit;
- is NOT a storage price;
- is NOT Irys gas;
- is NOT Irys publication cost;
- is NOT capsule size pricing.

Irys publication/storage:

- determines actual publication/storage cost;
- is paid by the creator through the supported Irys flow;
- Irys creator-paid storage/publication flow is implemented and deployed in the current runtime;
- protocol/runtime implementation = ACTIVE;
- live real-money end-to-end validation = NOT YET COMPLETED.

Wallet identity rule:

- The same authenticated creator wallet identity MUST be used for both
  the AETERNA service payment and the subsequent Irys publication and
  capsule creation lifecycle.
- A different wallet MUST NOT be used after the AETERNA service payment.
- Current canonical active rail: supported Solana-compatible wallet.
- Base rail is frozen and reserved for future activation.

Payment asset rule:

- The payment asset used for the AETERNA service fee MAY differ from the
  payment asset selected for Irys publication.
- AETERNA service payment asset selection does NOT determine Irys
  publication payment asset.
- Irys publication payment asset selection does NOT determine AETERNA
  service payment asset.

Do NOT say:

- "AETERNA uses one payment asset for both AETERNA and Irys."
- "The same token must be used for AETERNA and Irys."

Correct statement:

- "The creator uses one wallet identity for the entire capsule lifecycle.
  The payment asset used for the AETERNA service fee may differ from the
  payment asset selected for Irys publication."

This document does NOT define the final Irys browser/wallet/signing
flow.

## 13. USER EXPERIENCE

The canonical human-readable flow is:

1. User opens AETERNA.
2. User enters /create and prepares the capsule.
3. User clicks the first-stage creation action.
4. If no valid AETERNA Creator Credit is available for the creator's final creation action, the AETERNA Service Payment flow appears.
5. User sees fixed 1 USDC AETERNA service fee.
6. System displays exact amount in selected supported asset.
7. User confirms in wallet.
8. AETERNA verifies payment.
9. Creator Credit becomes AVAILABLE.
10. User returns to the same prepared /create workspace.
11. Final CREATE CAPSULE consumes the existing Creator Credit.
12. Irys publication happens separately when capsule is ready.
13. Irys determines its actual publication/storage cost.
14. User completes the Irys publication flow.
15. Successful publication + Seal consumes the Credit.

The released implementation (see §10.4) pins the active Solana rail to exactly one payment transaction with exactly one signature. This document still does NOT promise:

- one wallet provider at the protocol layer (Model 01 intentionally supports a single wallet provider; see AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md §4.1);
- instant Irys publication;

until confirmed by the final implementation.

## 14. SECURITY REQUIREMENTS

The architecture MUST include:

- server-side wallet authentication;
- replay protection;
- payment idempotency;
- quote immutability;
- exact amount verification;
- recipient verification;
- network verification;
- asset verification;
- creator identity binding;
- frontend non-authority;
- duplicate payment protection;
- auditability.

## 15. LEGAL / PRODUCT BOUNDARY

AETERNA sells a digital service entitlement:

- 1 USDC Creator Credit.

AETERNA does not price storage by capsule size.

Irys storage/publication cost is a separate external infrastructure cost.

Legal classification of the service entitlement requires
jurisdiction-specific legal review.

This document does not constitute legal advice.

## 16. OPEN DECISIONS

The following decisions remain unresolved:

- wallet provider (protocol layer; Model 01 resolved as Phantom-only);
- wallet connection protocol;
- wallet authentication/signing standard;
- supported asset allowlist;
- blockchain/network set;
- settlement recipient model;
- payment transaction format (resolved for the active Solana rail by the released implementation; see §10.4);
- exact Irys browser flow;
- exact Irys wallet/signing flow;
- whether AETERNA $1 and Irys publication can be combined in one
  user wallet flow;
- final storage for Creator Credit;
- final API boundaries.
