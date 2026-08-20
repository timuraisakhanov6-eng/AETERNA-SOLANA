# AETERNA — Initial Wallet / Payment Selection Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- IRYS-RESEARCH-1 findings
- Irys official documentation:
  - https://docs.irys.xyz/build/d/features/supported-tokens
  - https://docs.irys.xyz/build/d/irys-in-the-browser
  - https://docs.irys.xyz/build/d/quickstart
  - https://docs.irys.xyz/build/d/sdk/setup
  - https://docs.irys.xyz/build/d/networks

---

## 1. PURPOSE

This document defines the initial wallet/provider architecture and initial
payment asset allowlist for AETERNA production launch.

This document does NOT implement the selected architecture.

## 2. ARCHITECTURAL CONTEXT

AETERNA uses a provider-neutral multi-provider architecture.

The initial launch uses one concrete provider/adapter inside that architecture.

The architecture remains extensible to additional providers and assets
without changing Creator Credit business rules.

## 3. CANDIDATES COMPARED

Candidates evaluated for initial launch:

A. EVM injected wallet/provider
B. Reown / WalletConnect-style EVM provider
C. Solana browser wallet provider
D. Provider-neutral multi-provider architecture
   - evaluated as architecture, not as initial-only implementation

## 4. CREATOR WALLET / PAYMENT BOUNDARY

One creator wallet identity = one creator identity = one capsule per paid
Creator Credit.

For one capsule, the creator uses the same wallet identity for the entire
creator journey.

AETERNA service payment asset and Irys publication payment asset are NOT
required to be the same.

Example:

Wallet A
→ pays AETERNA $1 in USDC
→ creates Capsule #1
→ pays Irys for Capsule #1 in ETH

This is allowed.

Using a different wallet within the same creator journey is forbidden:

Wallet A pays AETERNA $1
        ↓
Wallet B creates the capsule

This is forbidden.

The same authenticated creator wallet identity must remain bound to the
Creator Credit and the capsule creation lifecycle.

Do NOT say:

"AETERNA uses one payment asset for both AETERNA and Irys."

Instead say:

"The creator uses one wallet identity for the entire capsule lifecycle.
The payment asset used for the AETERNA service fee may differ from the
payment asset selected for Irys publication."

## 5. EVALUATION SUMMARY

### 4.1 EVM injected wallet/provider

1. Irys Mainnet browser compatibility: confirmed by Irys official documentation.
2. Supported Irys payment assets: EVM-network assets supported by Irys.
3. Creator-paid Irys publication: supported through browser WebUploader integrations.
4. Wallet control/signing: injected provider exposes address and signing capability.
5. Server verification: feasible via standard EVM message signing and transaction verification.
6. Desktop UX: strong; standard injected wallet flow.
7. Mobile UX: limited to wallets with mobile browser/injected support.
8. Number of wallet interactions: typically one connect + one confirmation per payment.
9. Cloudflare/browser compatibility: browser-side signing only; no Node-only dependency; compatible with Cloudflare Pages/Workers.
10. Security: server-side verification required; wallet spoofing resistance depends on provider security model; replay resistance must be server-side.
11. Implementation complexity: medium initial; medium maintenance.
12. Vendor/network lock-in: EVM-centric; explicit extension required for non-EVM assets.
13. Ease of adding providers later: can be encapsulated as one adapter in provider-neutral architecture.
14. Creator Credit suitability: suitable with proper server-side wallet binding and verification.

### 4.2 Reown / WalletConnect-style EVM provider

1. Irys Mainnet browser compatibility: EVM browser integrations confirmed; WalletConnect-style bridge is a known browser wallet pattern.
2. Supported Irys payment assets: EVM assets supported by wallets in the bridge ecosystem.
3. Creator-paid Irys publication: supported if wallet can sign/submit required transactions.
4. Wallet control/signing: WalletConnect provides session abstraction; server-verifiable control requires additional challenge/signature step.
5. Server verification: feasible with additional design.
6. Desktop UX: moderate; requires QR or companion app.
7. Mobile UX: strong via QR/deep-link.
8. Number of wallet interactions: typically one connect + one confirmation.
9. Cloudflare/browser compatibility: browser-side signing only; compatible with Cloudflare Pages/Workers.
10. Security: bridge/broker adds trust surface; server verification remains required.
11. Implementation complexity: medium-high initial; medium-high maintenance.
12. Vendor/network lock-in: WalletConnect/bridge dependency; EVM-centric.
13. Ease of adding providers later: can be added as adapter later.
14. Creator Credit suitability: suitable with proper design.

### 4.3 Solana browser wallet provider

1. Irys Mainnet browser compatibility: Irys documents Solana browser integration.
2. Supported Irys payment assets: Solana-network assets supported by Irys.
3. Creator-paid Irys publication: supported through browser wallet if Irys browser package supports it.
4. Wallet control/signing: Solana wallet adapters expose address and signing.
5. Server verification: feasible with Solana-specific signature verification.
6. Desktop UX: strong for Solana users.
7. Mobile UX: strong for Solana wallets.
8. Number of wallet interactions: typically one connect + one confirmation.
9. Cloudflare/browser compatibility: browser-side signing only; compatible with Cloudflare Pages/Workers.
10. Security: server verification of Solana signature/transaction required.
11. Implementation complexity: medium initial; medium maintenance.
12. Vendor/network lock-in: Solana-centric if sole path.
13. Ease of adding providers later: can be added as adapter later.
14. Creator Credit suitability: suitable with proper design, but as initial-only path would make AETERNA appear Solana-oriented.

### 4.4 Provider-neutral multi-provider architecture

1. Irys Mainnet browser compatibility: compatible with Irys provider-specific WebUploader integrations.
2. Supported Irys payment assets: multi-asset/multi-network by design.
3. Creator-paid Irys publication: supported per provider.
4. Wallet control/signing: abstract identity layer maps provider-specific proofs to server-verifiable identity.
5. Server verification: centralized across providers.
6. Desktop UX: depends on selected provider.
7. Mobile UX: depends on selected provider.
8. Number of wallet interactions: depends on selected provider.
9. Cloudflare/browser compatibility: browser-side signing per provider; compatible with Cloudflare Pages/Workers.
10. Security: server-side verification central; provider-specific risks isolated to adapters.
11. Implementation complexity: high initial; medium maintenance after initial adapters.
12. Vendor/network lock-in: minimal; AETERNA controls allowlist and adapter set.
13. Ease of adding providers later: high; new providers/assets added as adapters.
14. Creator Credit suitability: best fit; provider-independent.

## 6. RECOMMENDED INITAL PROVIDER

RECOMMENDED INITIAL PROVIDER:

EVM injected wallet/provider path, encapsulated inside the provider-neutral
multi-provider architecture.

Why this provider:

- Irys official documentation confirms EVM browser integrations through
  browser providers/adapters.
- EVM injected wallets are widely available and have strong desktop UX.
- The path is simpler to implement initially than Reown/WalletConnect or
  multi-provider launch.
- It can be implemented as the first adapter in the provider-neutral
  architecture, preserving future extensibility.
- It does not require a broker/bridge, reducing initial trust surface.
- Server-side verification patterns are well-understood for EVM.

Why not Reown/WalletConnect as initial provider:

- Reown/WalletConnect adds broker complexity that is unnecessary for initial
  launch.
- It is better suited as a future adapter for wallet-agnostic mobile/desktop
  coverage.
- Reown does not replace Irys; it is a wallet connection abstraction.

Why not Solana as initial provider:

- Irys documents Solana browser integration, so Solana is a valid future
  adapter.
- As the sole initial provider, Solana would make AETERNA appear
  Solana-oriented, which contradicts the decision that AETERNA must not be
  Solana-only.
- EVM browser flow is better documented by Irys for initial launch.

Why not multi-provider launch:

- Multi-provider launch increases initial complexity and risk.
- Starting with one adapter allows AETERNA to validate the payment/credit
  flow before expanding.
- The provider-neutral architecture ensures future adapters can be added
  without redesigning Creator Credit.

## 7. RECOMMENDED INITAL ASSETS

RECOMMENDED INITIAL ASSETS:

- ETH on Ethereum Mainnet
- USDC on Ethereum Mainnet

Why included:

- ETH: native EVM asset, simplest for payment transactions, universally
  supported by EVM wallets, high liquidity.
- USDC: stablecoin, predictable USD 1.00 equivalent, widely supported,
  reduces creator confusion about price volatility.

Wallet/provider support:

- Both assets are supported by standard EVM injected wallets.
- Irys EVM browser packages support these assets on Mainnet.

Irys compatibility:

- Both assets are on Irys-supported EVM Mainnet networks.
- Creator-paid Irys publication is supported through browser WebUploader
  integrations.

User experience:

- Clear, familiar wallet connect and confirmation flow.
- Stablecoin option reduces price uncertainty.
- Desktop UX is strong; mobile UX depends on wallet availability.

Operational risk:

- Network fees (gas) are variable and creator-paid.
- AETERNA $1 is separate from Irys publication cost and from network fees.
- Network congestion may affect confirmation timing.

## 8. INITIAL LAUNCH ASSET STRATEGY

RECOMMENDED INITIAL ASSETS:

- Base Mainnet: native USDC

Why included:
- USDC: stablecoin, predictable USD 1.00 equivalent, widely supported,
  reduces creator confusion about price volatility.
- Base: low-cost EVM network selected as the initial AETERNA service-payment
  network.
- Wallet/provider support: native USDC on Base is supported by standard EVM
  injected wallets and Irys EVM browser packages on Mainnet networks.
- Irys compatibility: USDC is an Irys-supported EVM asset; creator-paid
  Irys publication is supported through browser WebUploader integrations.
- User experience: clear, familiar wallet connect and confirmation flow;
  stablecoin option reduces price uncertainty.
- Operational risk: Base transaction fees are lower than Ethereum Mainnet,
  reducing creator friction for the $1 service payment; AETERNA $1 remains
  separate from Irys publication cost and from network fees.

FUTURE EXPANSION ASSETS:
- Ethereum Mainnet: ETH and USDC remain approved future assets to be
  activated through explicit canonical selection.
- Additional Irys-supported EVM assets on Ethereum Mainnet or other EVM
  networks.
- Additional stablecoins if approved by AETERNA and supported by Irys.
- Solana-network assets if Irys confirms production browser support and
  AETERNA approves.

ASSETS INTENTIONALLY EXCLUDED:
- Devnet faucet tokens: excluded from production.
- Any asset not explicitly approved by AETERNA, even if Irys supports it.
- Assets whose browser/provider integration is not officially supported or
  verified.
- Solana-only assets as the sole initial allowlist: excluded to avoid
  Solana-only positioning.

## 10. $1 CREATOR CREDIT FLOW

The selected provider/asset supports the canonical flow:

USD 1.00
→ server-side price conversion
→ exact atomic amount in selected asset
→ immutable payment quote
→ wallet confirmation
→ server verification
→ Creator Credit AVAILABLE

Frontend displays the amount.
Frontend does NOT determine the authoritative amount.
Server-side price conversion is required.

## 11. WALLET IDENTITY APPROACH

Conceptual authentication model:

- Server issues a challenge/nonce bound to the intended payment/quote context.
- Wallet signs the challenge using an officially supported signing method for
  the selected EVM provider/network.
- Server verifies the signature against the claimed wallet identity.
- This proof establishes authenticated creator identity for Creator Credit
  binding.

This document does NOT select:
- specific signing standard;
- specific message format;
- specific provider challenge protocol.

Those remain pending official provider/Irys confirmation.

## 12. IRYS FLOW

Conceptual production flow for selected provider/asset:

1. Creator opens AETERNA.
2. Creator connects EVM injected wallet.
3. Creator clicks CREATE CAPSULE.
4. If no AVAILABLE Creator Credit, payment modal appears.
5. AETERNA server issues Creator Service Payment Quote with USD 1.00
   service fee and exact asset amount.
6. Frontend displays the quote amount.
7. Creator confirms payment in wallet.
8. AETERNA server verifies payment against immutable quote.
9. Creator Credit becomes AVAILABLE.
10. Creator prepares capsule content.
11. When capsule is ready, Irys publication begins.
12. Irys determines actual publication/storage cost.
13. Creator confirms Irys publication/payment flow in wallet.
14. After successful Irys publication, sealing continues.
15. After successful seal, Creator Credit becomes CONSUMED.
16. For next capsule, new Creator Credit required.

This flow does NOT promise:
- one transaction;
- one signature;
- unified payment;
- instant publication.

## 13. UX

Recommended UX principles:

- Clear wallet connect button and status.
- Clear display of AETERNA $1 service fee.
- Clear display of Irys publication cost when known.
- Clear confirmation steps with explicit amounts.
- Clear error/cancel handling.
- Clear transition from AETERNA service payment to Irys publication.
- Clear successful result and Credit status.
- Do not require user to understand blockchain internals.

## 14. SECURITY

Security requirements for initial provider/asset:

- Server-side wallet ownership verification via challenge/signature.
- Server-side payment verification against immutable quote.
- Replay protection enforced server-side.
- Payment idempotency enforced server-side.
- Exact amount verification server-side.
- Recipient verification server-side.
- Network verification server-side.
- Asset verification server-side.
- Wallet-to-credit binding server-side.
- Frontend is never payment authority.
- Duplicate payment protection server-side.

## 15. DECISION SUMMARY

RECOMMENDED INITIAL PROVIDER:
EVM injected wallet/provider path, encapsulated inside the provider-neutral
multi-provider architecture.

RECOMMENDED INITIAL ASSETS:
- ETH on Ethereum Mainnet
- USDC on Ethereum Mainnet

SECONDARY/FUTURE PROVIDERS:
- Reown/WalletConnect-style EVM provider (for wallet-agnostic mobile/desktop coverage)
- Solana browser wallet provider (if Irys confirms production browser support and AETERNA approves)
- Additional EVM network providers as needed

FUTURE ASSETS:
- Additional Irys-supported EVM assets
- Additional stablecoins if approved by AETERNA
- Solana assets if Irys confirms and AETERNA approves

REJECTED OPTIONS:
- Solana-only initial provider: rejected because AETERNA must not be Solana-only, and EVM browser flow is better documented by Irys for initial launch.
- Reown/WalletConnect as sole initial provider: rejected because it adds unnecessary broker complexity for initial launch; better as future expansion.
- Multi-provider launch: rejected for initial launch due to complexity; provider-neutral architecture preserves future extensibility.
- Devnet faucet tokens in production: rejected because production must use Mainnet real tokens.

## 16. OPEN ITEMS

The following remain unresolved and require confirmation before implementation:

- Exact wallet authentication standard for EVM injected provider.
- Exact payment quote price source/oracle for USD 1.00 conversion.
- Exact Irys browser publication sequence for AETERNA capsule pipeline.
- Exact Cloudflare Pages/Workers integration for selected provider adapter.
- Final security review of wallet authentication flow.
- Final legal review by jurisdiction.
- Browser/device compatibility testing.
- Final confirmation of supported Irys assets from official Irys documentation.

## 17. REFERENCES

- AETERNA_CREATOR_CREDIT_SPEC.md
- AETERNA_WALLET_PAYMENT_ARCHITECTURE_SPEC.md
- AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- Irys official documentation:
  - https://docs.irys.xyz/build/d/features/supported-tokens
  - https://docs.irys.xyz/build/d/irys-in-the-browser
  - https://docs.irys.xyz/build/d/quickstart
  - https://docs.irys.xyz/build/d/sdk/setup
  - https://docs.irys.xyz/build/d/networks
- Reown official provider documentation:
  - https://docs.reown.com/advanced/providers/ethereum
  - https://docs.reown.com/advanced/walletconnectmodal/options
