# AETERNA — SPEC-WP-18R Canonical Reconciliation Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review documents the canonical reconciliation of Base Mainnet + native
USDC as the initial production AETERNA Service Payment route.

This review does NOT create a wallet.
This review does NOT generate an address.
This review does NOT connect a payment provider.
This review does NOT modify production code.
This review does NOT create Cloudflare resources.

---

## 2. PROPOSED RECONCILIATION

Initial production AETERNA Service Payment route:
- Network: Base Mainnet
- Asset: native USDC
- Commercial service fee: USD 1.00
- Settlement Wallet custody: 2-of-3 multisig + hardware-backed keys
- Application runtime: NO private-key access, NO signing authority
- Irys payment: independent/separate

---

## 3. CONFLICTING STATEMENTS FOUND

### 3.1 AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md

Conflict A:
- Old statement: "AETERNA must not become USDC-only."

Resolution:
- Replaced with: "AETERNA initial production service payment is selected as
  Base Mainnet + native USDC. AETERNA is NOT permanently USDC-only;
  additional assets/networks may be added through explicit future canonical
  selection."
- Underlying intent preserved: AETERNA must remain multi-network/multi-asset
  capable. The old blanket prohibition on USDC-only is no longer needed as
  an absolute barrier because the canonical documents now explicitly define
  USDC as the initial production asset while preserving future extensibility.

Document modified:
- docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md

### 3.2 AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md

Conflict B:
- Old statement: "RECOMMENDED INITAL ASSETS: ETH on Ethereum Mainnet, USDC on
  Ethereum Mainnet"
- Old statement: "RECOMMENDED INITAL PROVIDER: EVM injected wallet/provider
  path"

Resolution:
- Updated "RECOMMENDED INITAL ASSETS" to: "Base Mainnet: native USDC"
- Preserved Ethereum Mainnet assets as "FUTURE EXPANSION ASSETS"
- Preserved the provider-neutral architecture; initial provider remains
  EVM injected wallet/provider path as the first adapter
- Explicitly stated Base is the initial network, Ethereum Mainnet remains a
  future option
- Document remains historical; the revision reflects the current canonical
  initial production selection

Document modified:
- docs/canonical/AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md

### 3.3 AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md

Conflict C:
- Old statement: "old Base/USDC-only assumptions unless explicitly reselected
  by current canonical documents after this specification is published."

Resolution:
- Replaced with: "historical Base/USDC-only assumptions that predate canonical
  reconciliation in SPEC-WP-18R; current canonical initial production
  selection is documented in AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md"
- This explicitly anchors the exception to the new canonical selection rather
  than leaving it as an open-ended exclusion

Document modified:
- docs/canonical/AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md

### 3.4 AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md

Conflict D:
- Old statement: "PENDING CANONICAL DECISION — exact AETERNA payment network
  for initial production"
- Old statement: "PENDING CANONICAL DECISION — exact AETERNA payment asset
  allowlist for initial production"
- Old statement: "NOT YET CANONICALIZED due to contradiction with existing
  canonical documents"
- Old statement: "AETERNA must not become USDC-only"
- Old statement: "old Base/USDC-only assumptions unless explicitly reselected
  by current canonical documents"

Resolution:
- Changed sections 1 and 2 from PENDING to "INITIAL PRODUCTION SELECTION"
- Changed compatibility notes from "NOT YET CANONICALIZED due to
  contradiction" to "This selection supersedes the earlier recommendation..."
- Removed "USDC-only" prohibition language
- Added explicit statements that AETERNA is NOT permanently USDC-only or
  Solana-only; additional assets/networks may be added through explicit
  future canonical selection
- Moved Ethereum Mainnet + ETH/USDC from "recommended initial" to "future
  expansion" status
- Removed network/asset from pending lists

Document modified:
- docs/canonical/AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md

---

## 4. DOCUMENTS MODIFIED

- docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- docs/canonical/AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md

---

## 5. DOCUMENTS INTENTIONALLY PRESERVED AS HISTORICAL

- docs/reviews/implementation/AETERNA_SPEC_WP_18_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_REVIEW.md
  - Contains historical findings from SPEC-WP-18; intentionally preserved
    as the record of the prior blocked state.
- docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md sections
  documenting EVM injected wallet/provider path ranking remain intact;
  only the USDC-only prohibition was reconciled.
- docs/canonical/AETERNA_INITIAL_WALLET_PAYMENT_SELECTION.md structure
  preserved; only the recommended initial assets were updated.

---

## 6. CONSISTENCY CHECK

Post-reconciliation canonical state:

| Item | Status |
|---|---|
| Initial production network | SELECTED: Base Mainnet |
| Initial production asset | SELECTED: native USDC |
| Future extensibility | PRESERVED: multi-network/multi-asset architecture intact |
| Provider-neutral architecture | PRESERVED |
| Settlement Wallet custody | SELECTED: 2-of-3 multisig + hardware-backed keys |
| Wallet creation | PENDING |
| Settlement Wallet address | PENDING |
| Price oracle | PENDING |
| Provider/RPC/adapter | PENDING |
| Finality thresholds | PENDING |
| Evidence formats | PENDING |
| Reconciliation/refund policy | PENDING |
| Legal review | PENDING |
| Irys payment separation | PRESERVED |
| Creator Identity authority | PRESERVED |
| Creator Credit authority | PRESERVED |
| Fail-closed verification | PRESERVED |

No current canonical document contradicts the new initial production route.
Provider-neutral/multi-network architecture remains intact.
Irys remains separate.

---

## 7. VERDICT

SPEC-WP-18R = COMPLETE

Reason:
- Base Mainnet + native USDC is explicitly the initial production AETERNA
  Service Payment route.
- No current canonical document contradicts that initial route.
- Provider-neutral/multi-network architecture remains intact.
- Irys remains separate.
- Settlement Wallet custody remains 2-of-3 multisig + hardware-backed keys.
- Wallet creation is still pending.
- Provider/RPC/oracle/finality/evidence/reconciliation/legal decisions
  remain explicitly PENDING where unresolved.

---

FINAL CONFIRMATION:

"SPEC-WP-18R modified canonical documentation only. No wallet was created,
no address was generated or reused, no payment provider was connected, and
no production code, Cloudflare resources, crypto, storage, Vault, Manifest,
Seal, Trusted Time, Heartbeat, or legacy files were modified."
