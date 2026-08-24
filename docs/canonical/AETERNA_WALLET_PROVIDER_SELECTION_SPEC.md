# AETERNA — Wallet Provider Selection Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- IRYS-RESEARCH-1 findings
- Irys official documentation:
  - https://docs.irys.xyz/build/d/features/supported-tokens
  - https://docs.irys.xyz/build/d/irys-in-the-browser
  - https://docs.irys.xyz/build/d/quickstart
  - https://docs.irys.xyz/build/d/sdk/setup
  - https://docs.irys.xyz/build/d/networks

---

## 1. NAME

Wallet Provider Selection Specification

## 2. PURPOSE

This document defines the canonical active wallet/provider selection for
AETERNA Web3 service payments and documents pending future expansions.

This document does NOT implement the selected architecture.

Business rule context:
- AETERNA Service Payment = exactly 1 USDC;
- one verified payment = one capsule creation entitlement;
- supported payment rails: Base Mainnet + native USDC, Solana Mainnet + native USDC.

Network is a payment-rail policy, not the business price.

Current implementation status:
- ACTIVE: Base Mainnet / native USDC via minimal EIP-1193 browser provider.
- PENDING: additional wallet/provider expansions.

## 3. CONFIRMED IRYS FACTS USED

The following facts from official Irys documentation are used as the
source of truth for this specification:

- Irys Mainnet supports multiple payment networks/assets.
- Browser support exists for many of those assets.
- Irys provides WebUploader browser integrations.
- Irys uses token-specific browser/SDK packages.
- Irys documents EVM browser integrations through browser providers/adapters.
- Irys documents Solana browser integration.
- Mainnet uses real payment tokens.
- Devnet uses faucet tokens.
- Production AETERNA must target Mainnet.
- AETERNA must not become Solana-only.
- AETERNA initial production service payment is selected as Base Mainnet
  + native USDC.
- AETERNA is NOT permanently USDC-only; additional assets/networks may be
  added through explicit future canonical selection.

## 4. ACTIVE WALLET/PROVIDER SELECTION

Canonical active selection:

Minimal EIP-1193 browser provider for Base Mainnet / native USDC.

Rationale:
- This is the current active implementation.
- It satisfies the initial production requirement.
- It preserves server-side verification, replay protection, and
  payment idempotency.
- It keeps AETERNA $1 separate from Irys publication cost.
- It avoids unnecessary broker dependencies.

## 5. PENDING WALLET/PROVIDER EXPANSIONS

The following are NOT active canonical selections:

- Reown/WalletConnect-style EVM path;
- Solana browser wallet path;
- provider-neutral multi-provider architecture.

These may become canonical only through explicit future canonical selection.

Each pending candidate must be evaluated against:

A. Irys compatibility
B. Payment asset coverage
C. Wallet identity
D. Payment UX
E. Irys UX
F. Cloudflare compatibility
G. Security
H. Implementation complexity
I. Vendor/network lock-in
J. User experience

Pending evaluation summary:

- Reown/WalletConnect-style EVM path:
  - STATUS: PENDING EVALUATION
  - Adds broker complexity; not required for initial launch.

- Solana browser wallet path:
  - STATUS: PENDING IMPLEMENTATION
  - Canonical target rail; active only after explicit canonical selection.

- Provider-neutral multi-provider architecture:
  - STATUS: PENDING EVALUATION
  - Possible future expansion; not initial active architecture.

## 6. RECOMMENDATION

Recommended initial architecture:
- Minimal EIP-1193 browser provider for Base Mainnet / native USDC.

Future expansion:
- Additional wallet/provider adapters may be added only through explicit canonical selection.
- Any new adapter must preserve:
  - server-side verification;
  - replay protection;
  - payment idempotency;
  - Creator Credit authority;
  - separation of AETERNA $1 and Irys cost.

This document does NOT promise:
- one transaction;
- one signature;
- one wallet provider;
- instant Irys publication;

until confirmed by the final implementation.

## 7. AUTHENTICATION MODEL

Conceptual wallet authentication model:

- Server issues a challenge/nonce bound to the intended payment/quote context.
- Wallet signs the challenge using an officially supported signing method for the selected provider/network.
- Server verifies the signature against the claimed wallet identity.
- This proof establishes authenticated creator identity for Creator Credit binding.

This document does NOT select:
- specific signing standard;
- specific message format;
- specific provider challenge protocol.

Those remain pending official provider/Irys confirmation.

## 8. PAYMENT IDENTITY RULE

During landing payment:

- NO REAL CAPSULE EXISTS YET.
- paymentIntentId is the canonical pre-capsule payment identity.
- paymentIntentId != capsuleId.
- Never document capsuleId="landing".
- Never document synthetic/fake capsule IDs.

Canonical sequence:
- paymentIntentId -> immutable service quote -> payment verification -> Creator Credit -> entitlement -> /create
- real capsuleId exists only after actual capsule creation begins.

## 9. IRYS BOUNDARY

- AETERNA $1 service payment is separate from Irys publication/storage.
- Irys publication cost is paid by the creator through the supported Irys flow.
- AETERNA does NOT bundle Irys cost into the $1 service fee.
- Executor Hot is NOT the canonical target creator-payment architecture.
- Current implementation may use Executor Hot as publication authority; target is creator-paid Irys economics.
- STATUS: IRYS DIRECT CREATOR PAYMENT = PENDING IMPLEMENTATION

## 10. SECURITY REQUIREMENTS

- Server-side verification is mandatory.
- Frontend is never payment authority.
- Replay protection must be server-side.
- Payment idempotency must be server-side.
- Quote immutability must be server-side.
- Wallet identity binding must be server-verifiable.
- Provider-specific browser risks are isolated to adapters.
- Creator Credit authority remains server-side regardless of provider.

## 11. OPEN ISSUES

The following remain unresolved:

- Final wallet provider selection for initial launch.
- Final wallet authentication/signing standard.
- Final supported asset allowlist.
- Final price source/oracle for USD 1.00 conversion.
- Exact Irys browser flow for AETERNA capsule pipeline.
- Whether AETERNA $1 and Irys publication can be combined into one user wallet flow.
- Final API boundaries between payment, credit, and publication.
- Cloudflare Pages/Workers integration details for selected provider adapters.
- Security review of selected provider authentication flow.
- Legal review of service entitlement in selected jurisdictions.
