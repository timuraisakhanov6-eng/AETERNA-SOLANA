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
- Reown official provider documentation:
  - https://docs.reown.com/advanced/providers/ethereum
  - https://docs.reown.com/advanced/walletconnectmodal/options

---

## 1. PURPOSE

This document provides a canonical comparison of production wallet/provider
architecture candidates for AETERNA Web3 service payments.

This document selects a recommended initial architecture and initial asset
strategy.

This document does NOT implement the selected architecture.

## 2. CONFIRMED IRYS FACTS USED

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
- AETERNA should use abstract PaymentAsset + Provider architecture.

## 3. CANDIDATES

The following candidates are compared:

1. EVM injected/provider path
   Example class: MetaMask / browser injected provider

2. Reown/WalletConnect-style EVM path
   Example: wallet-agnostic EVM connection through bridge/deep-link/QR

3. Solana browser wallet path
   Example class: Phantom / compatible Solana wallet adapter

4. Provider-neutral multi-provider architecture
   Provider-neutral AETERNA wallet layer supporting multiple wallet/network
   adapters while keeping Creator Credit rules unchanged.

## 4. EVALUATION CRITERIA

Each candidate is evaluated against:

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

## 5. COMPARISON MATRIX

### 5.1 EVM injected/provider path

A. Irys compatibility
- Irys documents EVM browser integrations through browser providers/adapters.
- Token-specific browser packages exist for EVM assets.
- Mainnet support: confirmed for supported EVM assets.
- Creator-paid publication: supported through browser WebUploader integrations.

B. Payment asset coverage
- Covers EVM-network tokens supported by Irys.
- Does not inherently support non-EVM assets.
- Architecture would need explicit extension for non-EVM assets.

C. Wallet identity
- Injected provider exposes address and signing capability.
- Server-verifiable signatures possible via standard EVM message signing.
- Replay protection requires challenge/nonce design.
- Suitable for Creator Credit wallet binding with proper server-side verification.

D. Payment UX
- Connect: standard injected wallet connect.
- Confirmation: wallet sign/send flow.
- Rejection/cancel: handled by wallet.
- Mobile UX: limited to wallets with mobile browser/injected support.
- Desktop UX: generally strong.

E. Irys UX
- Creator can pay Irys directly via wallet-signed transaction.
- Publication flow is wallet-mediated.
- AETERNA $1 can remain separate from Irys cost with two distinct verifications.

F. Cloudflare compatibility
- Browser-side signing only.
- No Node-only dependency.
- Compatible with Cloudflare Pages/Workers.

G. Security
- Server verification of tx/receipt/signature required.
- Wallet spoofing resistance depends on provider security model.
- Replay resistance must be enforced server-side.

H. Implementation complexity
- Initial: medium.
- Maintenance: medium.
- Extensibility: requires explicit work for non-EVM assets.

I. Vendor/network lock-in
- Forces EVM ecosystem.
- Forces reliance on injected-provider security model.
- Not inherently multi-chain.

J. User experience
- Familiar to many web3 users.
- Requires wallet installation.
- Clear connect/pay/publish flow.

### 5.2 Reown/WalletConnect-style EVM path

A. Irys compatibility
- Irys documents EVM browser integrations.
- WalletConnect-style bridge/deep-link/QR is a known browser wallet pattern.
- Mainnet support: depends on wallets available through the bridge.
- Creator-paid publication: supported if wallet can sign/submit required transactions.

B. Payment asset coverage
- Covers EVM assets supported by wallets in the WalletConnect ecosystem.
- Does not inherently support non-EVM assets.
- Architecture extension required for non-EVM.

C. Wallet identity
- WalletConnect provides session/connection abstraction.
- Server-verifiable wallet control requires additional challenge/signature step.
- Replay protection requires server-side design.
- Suitable for Creator Credit binding with proper verification.

D. Payment UX
- Connect: QR/deep-link/bridge.
- Confirmation: wallet app confirmation.
- Rejection/cancel: handled by wallet/bridge.
- Mobile UX: strong via QR/deep-link.
- Desktop UX: moderate; requires QR or companion app.

E. Irys UX
- Creator can pay Irys directly.
- AETERNA $1 can remain separate.
- Two distinct wallet interactions likely required.

F. Cloudflare compatibility
- Browser-side signing only.
- No Node-only dependency.
- Compatible with Cloudflare Pages/Workers.

G. Security
- Bridge/broker security is an additional trust surface.
- Server verification remains required.
- Replay resistance must be server-side.

H. Implementation complexity
- Initial: medium-high.
- Maintenance: medium-high.
- Extensibility: similar to injected EVM.

I. Vendor/network lock-in
- Locks into WalletConnect/bridge ecosystem.
- Still EVM-centric.
- Adds broker dependency.

J. User experience
- More flexible across wallets/devices.
- More complex onboarding.
- Acceptable but not minimal-friction.

### 5.3 Solana browser wallet path

A. Irys compatibility
- Irys documents Solana browser integration.
- Browser support exists for Solana wallets.
- Mainnet support: confirmed if Irys Mainnet supports Solana payment assets.
- Creator-paid publication: supported through browser wallet if Irys browser package supports it.

B. Payment asset coverage
- Covers Solana-network tokens supported by Irys.
- Does not cover EVM or other assets.
- AETERNA would be Solana-capable but not Solana-only if additional adapters are added.

C. Wallet identity
- Solana wallet adapters expose address and signing.
- Server-verifiable proof requires Solana-specific message signing.
- Replay protection requires challenge/nonce.
- Suitable for Creator Credit binding with proper design.

D. Payment UX
- Connect: standard Solana wallet connect.
- Confirmation: wallet sign/send.
- Rejection/cancel: handled by wallet.
- Mobile UX: generally strong for Solana wallets.
- Desktop UX: strong.

E. Irys UX
- Creator can pay Irys directly via Solana wallet.
- AETERNA $1 can remain separate.
- Two interactions likely required.

F. Cloudflare compatibility
- Browser-side signing only.
- No Node-only dependency.
- Compatible with Cloudflare Pages/Workers.

G. Security
- Server verification of Solana signature/transaction required.
- Wallet spoofing resistance depends on adapter/wallet security.
- Replay resistance must be server-side.

H. Implementation complexity
- Initial: medium.
- Maintenance: medium.
- Extensibility: requires separate adapter for non-Solana assets.

I. Vendor/network lock-in
- Locks into Solana ecosystem for this path.
- Not inherently multi-chain.
- Would require additional adapters for multi-chain.

J. User experience
- Familiar to Solana users.
- Unfamiliar to non-Solana users.
- AETERNA would appear Solana-oriented if this is the only initial path.

### 5.4 Provider-neutral multi-provider architecture

A. Irys compatibility
- Compatible with Irys provider-specific WebUploader integrations.
- Each provider/adapter maps to Irys token-specific package.
- Mainnet support: as broad as supported adapters.
- Creator-paid publication: supported per provider.

B. Payment asset coverage
- Inherently multi-asset/multi-network by design.
- AETERNA can maintain its own allowlist over any Irys-supported asset.
- No forced chain assumption.

C. Wallet identity
- Abstract identity layer maps provider-specific proofs to server-verifiable
  authenticated creator identity.
- Replay protection enforced centrally.
- Best fit for Creator Credit wallet binding.

D. Payment UX
- Connect: provider-agnostic selector.
- Confirmation: delegated to selected provider.
- Rejection/cancel: handled by provider.
- Mobile UX: depends on selected provider.
- Desktop UX: depends on selected provider.

E. Irys UX
- Creator pays Irys directly via selected provider.
- AETERNA $1 remains separate.
- One coordinator can orchestrate both verifications.

F. Cloudflare compatibility
- Browser-side signing only per provider.
- No Node-only dependency.
- Compatible with Cloudflare Pages/Workers.

G. Security
- Server-side verification remains central.
- Provider-specific risks are isolated to adapters.
- Centralized replay/idempotency enforcement.

H. Implementation complexity
- Initial: high.
- Maintenance: medium after initial adapters.
- Extensibility: high; new providers/assets added as adapters.

I. Vendor/network lock-in
- Minimizes lock-in.
- AETERNA controls allowlist and adapter set.
- Future providers/assets added without changing Creator Credit rules.

J. User experience
- Can offer choice, which may confuse some users.
- Can constrain initial UX to one provider while preserving extensibility.
- Best long-term UX when paired with a clear initial default.

## 6. RANKING

#1 Provider-neutral multi-provider architecture
Reason: Best satisfies all decision principles. Keeps Creator Credit provider-independent, supports multi-asset without redesign, isolates provider risk, and matches Irys provider-specific architecture. Higher initial complexity is justified by long-term flexibility and non-custodial safety.

#2 EVM injected/provider path
Reason: EVM browser support is documented by Irys. It is simpler than multi-provider initially and familiar to users, but it creates chain lock-in and limits future asset expansion unless explicitly extended.

#3 Reown/WalletConnect-style EVM path
Reason: Adds wallet flexibility over injected EVM, but introduces broker dependency and moderate-high complexity. Still EVM-centric and does not inherently solve multi-chain needs.

#4 Solana browser wallet path
Reason: Irys documents Solana browser integration, so it is a valid supported path. However, as an initial-only strategy it would make AETERNA appear Solana-oriented and would limit asset coverage. Better as an additional adapter inside the provider-neutral architecture than as the sole initial path.

## 7. RECOMMENDATION

Recommended architecture:

Provider-neutral multi-provider architecture with an initial concrete provider.

Why this matches Irys:
- Irys uses token-specific browser/SDK packages and WebUploader integrations.
- AETERNA can map each supported Irys asset to an adapter without changing Creator Credit.
- Irys does not require a single wallet provider.

Why this is safest for Creator Credit:
- Server-side authority remains centralized.
- Wallet binding is abstracted and verifiable.
- Idempotency, replay protection, and failure recovery are enforced centrally.

Why this preserves non-custodial model:
- Wallet signing stays in the browser.
- AETERNA never holds user wallet credentials.
- Publication and payment remain creator-mediated.

Why this minimizes future redesign:
- New Irys-supported assets/providers are added as adapters.
- Creator Credit state machine and business rules are unchanged.

Why this gives the best creator UX:
- Initial implementation can expose one clear default provider path.
- Future providers can be added without disrupting existing users.
- Clear separation of AETERNA $1 and Irys publication costs.

## 8. INITIAL LAUNCH ASSET STRATEGY

A. Initial launch assets
- A limited set of Irys-supported Mainnet payment assets explicitly approved by AETERNA.
- Selection must be based on official Irys supported-token documentation, browser package availability, and AETERNA operational requirements.
- Exact initial allowlist is a separate configuration decision pending final provider selection.

B. Assets that can be added later
- Any additional Irys-supported Mainnet asset that passes AETERNA approval.
- Added through the provider/adapter layer without changing Creator Credit semantics.

C. Assets that should NOT be supported
- Devnet faucet tokens in production.
- Any asset not explicitly approved by AETERNA, even if Irys supports it.
- Assets whose browser/provider integration is not officially supported or verified.

## 9. AUTHENTICATION RECOMMENDATION

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

## 10. ANSWERS TO EXPLICIT QUESTIONS

1. Is an EVM browser flow currently better documented by Irys than a Solana flow?
- Irys official documentation confirms EVM browser integrations through browser providers/adapters.
- Irys official documentation also confirms Solana browser integration.
- EVM browser flow appears broader in documented provider/adapters, but both are documented as supported directions.
- Final comparison requires exact provider-by-provider verification against current Irys docs.

2. Is Reown useful as a provider abstraction for EVM wallets?
- Yes. Reown provides wallet-agnostic EVM connection through bridge/deep-link/QR.
- It can serve as one concrete provider inside the provider-neutral architecture.
- It does NOT replace Irys.

3. Does Reown itself replace Irys?
- NO.
- Reown is a wallet connection abstraction.
- Irys is the publication/storage layer.
- They solve different problems and can be composed.

4. Does Irys require AETERNA to use a single wallet provider?
- NO.
- Irys architecture is provider-specific package based.
- AETERNA can support multiple providers through adapters.

5. Can AETERNA maintain its own allowlist of Irys-supported assets?
- YES.
- This is an architecture decision.
- Irys support is a prerequisite, not automatic inclusion.

6. Can Creator Credit remain provider-independent?
- YES.
- Creator Credit rules are defined independently in AETERNA_CREATOR_CREDIT_SPEC.md.
- Provider changes do not alter the state machine, idempotency, or consumption rules.

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

## 12. CLOUDFLARE / BROWSER ASSESSMENT

- All compared candidates operate browser-side for wallet signing.
- No candidate requires Node-only runtime assumptions.
- Cloudflare Pages Functions/Workers can host server-side verification, quote issuance, and credit authority.
- Browser-to-Worker communication remains standard HTTPS/JSON.
- Provider adapters must be browser-compatible and avoid Node-specific APIs.

## 13. IRYS PAYMENT/PUBLICATION ASSESSMENT

- Irys publication cost is separate from AETERNA $1.
- Irys browser WebUploader integrations support creator-paid publication.
- AETERNA should not calculate Irys storage price as its own business price.
- AETERNA should not pre-fund Irys unless final Irys integration explicitly requires it.
- AETERNA $1 and Irys cost should remain separate user-facing charges unless future official confirmation allows unified flow.

## 14. SECURITY ASSESSMENT

- Server-side verification is mandatory for all candidates.
- Frontend is never payment authority.
- Replay protection must be server-side.
- Payment idempotency must be server-side.
- Quote immutability must be server-side.
- Wallet identity binding must be server-verifiable.
- Provider-specific browser risks are isolated to adapters.
- Creator Credit authority remains server-side regardless of provider.

## 15. UX ASSESSMENT

- Provider-neutral architecture can start with one default provider and expand.
- Users should see clear AETERNA $1 service fee before wallet interaction.
- Irys publication cost should be shown separately when known.
- Multiple wallet interactions are acceptable if clearly explained.
- Do not promise one transaction or one signature.
