# AETERNA — Provider Setup 1 Readiness Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review verifies whether Alchemy and Chainstack are ready for the future
AETERNA Base Mainnet native USDC payment-verification integration.

This review does NOT modify production code.
This review does NOT modify wrangler.toml.
This review does NOT create Cloudflare secrets.
This review does NOT create provider accounts or API keys.
This review does NOT create wallets or send transactions.

---

## 2. ALCHEMY READINESS

Base Mainnet support: FACT — current official Alchemy documentation/pricing
surface explicitly includes Base among supported chains.

HTTPS RPC endpoint availability: FACT — core Alchemy offering.

WebSocket availability: FACT — Smart Websockets and Webhooks are documented
capabilities.

eth_getLogs support: FACT — increased `eth_getLogs()` ranges are documented
as a differentiator.

Transaction receipt lookup: FACT — standard RPC + Enhanced APIs.

Block lookup: FACT — standard.

Historical log access: FACT — full archive data is available.

Rate limits / quotas: FACT — compute-unit model documented; free tier includes
30M compute units/month; pay-as-you-go starts at $0.40/1M CUs.

Current pricing/tier: FACT/ESTIMATE — free tier and pay-as-you-go are
documented; exact enterprise-tier terms were not confirmed from live fetch.

Workload support: ESTIMATE — AETERNA verification workload can be supported
by Alchemy architecture; exact capacity confirmation requires dashboard/plan
review.

API key creation: FACT — Alchemy dashboard flow creates API keys/apps.

Key restriction to Base: FACT/ESTIMATE — Alchemy supports per-app endpoints;
chain-specific restriction behavior should be confirmed during app creation.

Readiness: READY for credential creation.

---

## 3. CHAINSTACK READINESS

Base Mainnet support: FACT — current official Chainstack Base docs page
confirms Base coverage and Base-specific guidance exists.

HTTPS RPC: FACT — core offering.

WebSocket: FACT — platform offers WebSocket endpoints.

eth_getLogs: FACT — supported via standard JSON-RPC log/tx APIs.

Transaction receipt lookup: FACT — supported.

Block lookup: FACT — supported.

Historical logs: FACT — Archive Data product is explicitly documented.

Quotas/rate limits: FACT/ESTIMATE — plan-dependent; Unlimited Node and
Global Node products target high throughput.

Current pricing/tier: FACT/ESTIMATE — Unlimited Node offers flat-rate model;
Global Node offers RPS-tiered performance; exact plan pricing must be obtained
from current Chainstack pricing page.

Endpoint/key creation: FACT — Chainstack console deploys nodes/projects and
issues endpoint credentials.

Endpoint restriction options: FACT/ESTIMATE — project/node endpoint
configuration is available; exact Base-only restriction options should be
confirmed during console setup.

Readiness: READY for credential creation.

---

## 4. PROVIDER INDEPENDENCE

Alchemy and Chainstack are separate managed infrastructure providers.

Current evidence:
- Alchemy operates independent managed node/RPC infrastructure.
- Chainstack operates independent managed node/RPC infrastructure with
  geo-balanced and archive products.

Failover suitability:
- PRIMARY: Alchemy
- SECONDARY: Chainstack
- OPTIONAL TERTIARY: QuickNode

Provider independence assessment:
- meaningfully independent for primary/secondary failover: PLAUSIBLE
- shared upstream infrastructure cannot be ruled out without explicit
  provider disclosures: UNKNOWN

Recommended action:
- treat failover as architectural necessity, not absolute guarantee;
- retain provider-disagreement fail-closed behavior from SPEC-WP-24.

---

## 5. REQUIRED FUTURE SECRET NAMES

Recommended Cloudflare secret names for production runtime:

Primary:
- ALCHEMY_BASE_RPC_URL

Secondary:
- CHAINSTACK_BASE_RPC_URL

Optional future additions:
- ALCHEMY_BASE_WS_URL
- CHAINSTACK_BASE_WS_URL

Notes:
- these names are recommendations only;
- exact names may be adjusted during implementation;
- do NOT create these secrets in this phase.

---

## 6. CLOUDFLARE PLACEMENT

Recommended placement:
- Cloudflare secret storage for Pages/Functions/Workers runtime.

Required boundaries:
- provider keys MUST NOT be placed in:
  - source code;
  - committed `.env` files;
  - GitHub;
  - KV.

These secrets should be bound at runtime through Cloudflare’s secret
management for Pages/Workers.

---

## 7. EXACT USER ACTIONS NEEDED BEFORE CREDENTIAL USE

1. Create or log into Alchemy account.
2. Create a Base Mainnet app/endpoint in the Alchemy dashboard.
3. Generate an Alchemy API key for the Base app.
4. Copy the HTTPS RPC endpoint; do NOT paste the key into any file.
5. Create or log into Chainstack account.
6. Create a Base Mainnet node/project in the Chainstack console.
7. Generate a Chainstack endpoint credential for Base.
8. Copy the HTTPS RPC endpoint; do NOT paste the key into any file.
9. Store both endpoint values in Cloudflare secret storage later:
   - ALCHEMY_BASE_RPC_URL
   - CHAINSTACK_BASE_RPC_URL
10. Confirm endpoint restrictions/plans/rate limits in each dashboard
    before production use.

---

## 8. VERDICT

PROVIDER-SETUP-1 = READY

Reason:
- both providers are ready for user-side credential creation;
- endpoint capabilities required by AETERNA verification architecture are
  documented/supported by both providers;
- provider independence is plausible for primary/secondary failover;
- secret names and Cloudflare placement are defined.

Exact user-side blocker if any:
- none identified in this read-only review.

---

FINAL CONFIRMATION:

"No production code, wrangler.toml, secrets, wallets, transactions,
Cloudflare resources, or legacy files were modified."
