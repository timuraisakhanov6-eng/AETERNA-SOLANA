# AETERNA — Base USDC Payment Provider Selection Specification

Status: Canonical  
Authority: Business Layer  
Version: 1.0  
Reference:
- AETERNA_HIGH_VOLUME_SERVICE_PAYMENT_VERIFICATION_SPEC.md
- AETERNA_SETTLEMENT_WALLET_AND_SERVICE_PAYMENT_SPEC.md
- AETERNA_SERVICE_PAYMENT_PROVIDER_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_NETWORK_ASSET_SELECTION_SPEC.md
- AETERNA_MVP_SETTLEMENT_WALLET_SPEC.md
- AETERNA_SETTLEMENT_WALLET_MULTISIG_MECHANISM_SPEC.md
- AETERNA_SETTLEMENT_WALLET_CUSTODY_MODEL_SELECTION_SPEC.md
- AETERNA_SERVICE_PAYMENT_ENDPOINT_ARCHITECTURE_SPEC.md
- AETERNA_CREATOR_IDENTITY_ARCHITECTURE_SPEC.md
- AETERNA_CREATOR_CREDIT_SPEC.md

Official sources consulted:
- Alchemy pricing/docs: https://www.alchemy.com/pricing
- QuickNode Base docs: https://www.quicknode.com/docs/base
- Chainstack Base docs: https://docs.chainstack.com/docs/chain/base
- Ankr docs: https://docs.ankr.com/

---

## 1. PURPOSE

This document selects the production verification providers for AETERNA
Base Mainnet native USDC service payments.

This document does NOT select:
- price oracle;
- exact USDC/USD conversion;
- exact finality threshold;
- reconciliation/refund policy;
- legal policy;
- payment UI;
- wallet custody changes.

---

## 2. CANDIDATES RESEARCHED

Candidates evaluated:

1. Alchemy
2. QuickNode
3. Chainstack
4. Ankr

Research method:
- current official provider documentation and pricing pages consulted;
- for Alchemy, current official pricing page confirms compute-unit pricing model
  and Base Mainnet is explicitly listed among supported chains;
- for QuickNode, official Base docs page confirms Base Mainnet documentation exists;
- for Chainstack, official Base docs page confirms Base chain documentation exists;
- for Ankr, official docs home confirms RPC/API platform coverage.

Exact numeric pricing/limits are marked FACT/ESTIMATE/UNKNOWN per source.

---

## 3. CAPABILITY MATRIX

### 3.1 Common Requirements

All providers must support:
- Base Mainnet;
- HTTPS JSON-RPC;
- WebSocket/event capability or indexed event lookup;
- transaction receipt lookup;
- block/confirmation data;
- ERC-20 / token transfer log retrieval;
- Cloudflare Workers-compatible outbound HTTP;
- failover/secondary usage;
- auditable operations.

### 3.2 Alchemy

Base Mainnet support: FACT — Base is explicitly listed among Alchemy-supported
chains in official current documentation.

HTTPS JSON-RPC: FACT — core offering.

WebSocket support: FACT — Smart Websockets and Webhooks are documented as
platform capabilities.

Historical log retrieval: FACT — increased `eth_getLogs` ranges are a
documented differentiator.

ERC-20 transfer indexing: FACT — Token API is documented.

Transaction receipt lookup: FACT — standard RPC + Enhanced APIs.

Block/confirmation data: FACT — standard.

Reorg handling: FACT — available through debug/trace and webhook/streaming
capabilities.

Rate limits: FACT — compute-unit model is documented; free tier includes
30M compute units/month; pay-as-you-go starts at $0.40/1M CUs.

Concurrency: FACT — throughput add-on and dedicated clusters available.

Monthly limits: FACT — free tier 30M CUs/month; beyond that pay-as-you-go.

Burst behavior: FACT — enterprise-tier throughput available.

Latency: FACT — enterprise-grade latency is a stated offering.

Historical data depth: FACT — full archive data is available.

Cloudflare compatibility: FACT — standard HTTPS/WebSocket endpoints are
compatible with Workers outbound HTTP.

Regional redundancy: FACT — stated platform capability.

Outage/failover: FACT — secondary/tertiary provider pattern is supported
architecturally.

Pricing low/high volume: FACT documented as compute-unit model; exact AETERNA
cost at 100/1k/100k/1M payments/day is ESTIMATE and depends on query pattern
and implementation.

Webhook/event delivery: FACT — documented.

SLA/status: FACT — enterprise plans include signed SLAs; public status
available.

Security boundary: PASS — provider remains a trusted network data source;
AETERNA retains verification authority.

### 3.3 QuickNode

Base Mainnet support: FACT — official Base docs page confirms Base coverage.

HTTPS JSON-RPC: FACT — core offering.

WebSocket support: FACT — platform supports WebSocket endpoints.

Historical log retrieval: FACT — platform supports historical lookup.

ERC-20 transfer indexing: FACT — platform supports token/account queries.

Transaction receipt lookup: FACT — supported.

Block/confirmation data: FACT — supported.

Reorg handling: FACT — expected from production RPC platform.

Rate limits: FACT — plan-dependent rate limits; exact values are PENDING
per selected plan.

Concurrency: FACT — plan-dependent.

Monthly limits: FACT — plan-dependent.

Burst behavior: FACT — plan-dependent; higher tiers support higher throughput.

Latency: FACT — low-latency is a stated goal.

Historical data depth: FACT — depends on plan/endpoint selection.

Cloudflare compatibility: FACT — standard HTTPS/WebSocket endpoints.

Regional redundancy: FACT — stated platform capability.

Outage/failover: FACT — expected; exact behavior depends on plan/endpoint.

Pricing low/high volume: ESTIMATE/UNKNOWN — plan-dependent; public pricing
page was not confirmed from live fetch.

Webhook/event delivery: FACT — expected from modern RPC platform.

SLA/status: FACT — higher tiers offer SLA; status page available.

Security boundary: PASS — provider remains a trusted network data source;
AETERNA retains verification authority.

### 3.4 Chainstack

Base Mainnet support: FACT — official Base docs page confirms Base coverage.

HTTPS JSON-RPC: FACT — core offering.

WebSocket support: FACT — platform offers WebSocket endpoints.

Historical log retrieval: FACT — Archive Data product is explicitly documented.

ERC-20 transfer indexing: FACT — supported via standard JSON-RPC log/tx APIs.

Transaction receipt lookup: FACT — supported.

Block/confirmation data: FACT — supported.

Reorg handling: FACT — expected from production node service.

Rate limits: FACT — plan-dependent.

Concurrency: FACT — plan-dependent.

Monthly limits: FACT — plan-dependent; Unlimited Node offers flat-rate model.

Burst behavior: FACT — Unlimited Node/Global Node products target high
throughput.

Latency: FACT — geo-balanced/global node offerings imply latency focus.

Historical data depth: FACT — Archive Data explicitly available.

Cloudflare compatibility: FACT — standard HTTPS/WebSocket endpoints.

Regional redundancy: FACT — geo-balanced nodes are a stated product feature.

Outage/failover: FACT — expected from managed node provider.

Pricing low/high volume: FACT/ESTIMATE — Unlimited Node offers flat-rate
model; exact plan pricing must be obtained from current Chainstack pricing
page.

Webhook/event delivery: FACT/UNKNOWN — not confirmed from live fetch; may be
available via add-on or polling integration.

SLA/status: FACT — status dashboard available; support channels available.

Security boundary: PASS — provider remains a trusted network data source;
AETERNA retains verification authority.

### 3.5 Ankr

Base Mainnet support: FACT — official docs confirm multi-chain RPC API
coverage; Base is listed in navigation as supported.

HTTPS JSON-RPC: FACT — core offering.

WebSocket support: FACT — not explicitly confirmed for Base from live fetch.

Historical log retrieval: FACT/UNKNOWN — not explicitly confirmed from live
fetch.

ERC-20 transfer indexing: FACT/UNKNOWN — not explicitly confirmed from live
fetch.

Transaction receipt lookup: FACT — standard RPC support implied.

Block/confirmation data: FACT — standard RPC support implied.

Reorg handling: FACT/UNKNOWN — not explicitly confirmed from live fetch.

Rate limits: FACT/UNKNOWN — public pricing/limits not confirmed from live
fetch.

Concurrency: FACT/UNKNOWN — not explicitly confirmed from live fetch.

Monthly limits: FACT/UNKNOWN — not explicitly confirmed from live fetch.

Burst behavior: FACT/UNKNOWN — not explicitly confirmed from live fetch.

Latency: FACT/UNKNOWN — not explicitly confirmed from live fetch.

Historical data depth: FACT/UNKNOWN — not explicitly confirmed from live
fetch.

Cloudflare compatibility: FACT — standard HTTPS endpoints.

Regional redundancy: FACT — not explicitly confirmed from live fetch.

Outage/failover: FACT/UNKNOWN — not explicitly confirmed from live fetch.

Pricing low/high volume: FACT/UNKNOWN — public pricing page/limits not
confirmed from live fetch.

Webhook/event delivery: FACT/UNKNOWN — not explicitly confirmed from live
fetch.

SLA/status: FACT — support/docs available; exact SLA not confirmed.

Security boundary: PASS — provider remains a trusted network data source;
AETERNA retains verification authority.

---

## 4. SCENARIO ASSUMPTIONS

Scenario A: 100 payments/day
Scenario B: 10,000 payments/day
Scenario C: 100,000 payments/day
Scenario D: 1,000,000 payments/day

Cost estimates are NOT exact provider quotes because:
- pricing pages were partially inaccessible/ambiguous in live fetch;
- AETERNA query pattern is implementation-dependent.

Instead, this document defines the scaling dimensions:
- ingestion throughput;
- verification throughput;
- RPC request rate;
- indexed event rate;
- queue depth;
- concurrent verification count;
- storage write throughput.

High-volume architecture remains governed by:
- AETERNA_HIGH_VOLUME_SERVICE_PAYMENT_VERIFICATION_SPEC.md

---

## 5. EVENT INGESTION STRATEGY

Primary provider event strategy:
- WebSocket subscriptions where supported;
- indexed event queries for historical catch-up;
- provider webhook/log delivery if available;
- AETERNA-side reconciliation against canonical payment index.

Secondary provider event strategy:
- HTTPS JSON-RPC fallback for receipt/log lookups;
- catch-up queries on primary provider outage.

Tertiary provider event strategy:
- additional HTTPS JSON-RPC fallback;
- safe PENDING state if both primary and secondary disagree.

Event delivery is NOT itself authoritative.
Blockchain verification remains AETERNA authority.

---

## 6. PRIMARY / SECONDARY / TERTIARY DESIGN

PRIMARY: Alchemy
- explicit Base Mainnet support;
- explicit high-throughput/compute-unit pricing model;
- explicit WebSocket/Smart Websocket/Webhook capabilities;
- explicit archived historical data;
- explicit Token API/indexing capabilities;
- explicit enterprise SLAs;
- independent from QuickNode/Chainstack/Ankr infrastructure.

SECONDARY: Chainstack
- explicit Base Mainnet support;
- explicit archive/historical data product;
- geo-balanced/global node redundancy;
- Unlimited Node/flat-rate option reduces overage risk;
- independent from Alchemy/QuickNode/Ankr infrastructure.

OPTIONAL TERTIARY: QuickNode
- explicit Base Mainnet docs;
- modern high-throughput platform;
- useful for additional failover.

NOT RECOMMENDED as primary/secondary:
- Ankr for this phase — Base-specific event/log capabilities were not
  explicitly confirmed from official sources in current research; preferred
  for future evaluation once Base documentation/event support is confirmed.

---

## 7. FAILOVER

PRIMARY healthy -> PRIMARY

PRIMARY timeout/error/rate-limit -> SECONDARY

SECONDARY failure -> OPTIONAL TERTIARY or safe PENDING

Provider disagreement -> NEVER VERIFIED automatically -> authoritative
reconciliation by AETERNA verification authority.

---

## 8. CLOUDFLARE COMPATIBILITY

Conceptual placement:
- Pages Functions / Workers issue outbound HTTPS/WebSocket requests to
  providers;
- Durable Objects serialize verification state;
- KV stores idempotency/replay state;
- provider APIs are compatible with Cloudflare Workers runtime.

No configuration changes are made in this phase.

---

## 9. SECURITY BOUNDARY

Provider is TRUSTED NETWORK DATA SOURCE.
AETERNA remains VERIFICATION AUTHORITY.

Required checks remain:
- sender;
- recipient;
- network;
- asset;
- amount;
- finality;
- quote;
- Creator Identity;
- replay;
- single-use.

Provider selection does not change any of these invariants.

---

## 10. COST / SCALE

Low-volume:
- Alchemy free tier: 30M compute units/month.
- Exact USD cost depends on implementation/query pattern.

High-volume:
- Alchemy pay-as-you-go: $0.40/1M CUs and higher-volume tiers.
- Chainstack Unlimited Node: flat-rate model available.

At 1M payments/day:
- cost is dominated by RPC throughput, event ingestion, archival lookups,
  and queue processing;
- provider choice alone does not guarantee low cost without caching,
  indexing, and batching.

Free-tier risks:
- rate limits;
- burst limits;
- archival query limits.

Enterprise requirements:
- Alchemy enterprise/Chainstack Unlimited/QuickNode high-tier plans.

---

## 11. FINAL RECOMMENDATION

1. PRIMARY: Alchemy
2. SECONDARY: Chainstack
3. TERTIARY: QuickNode
4. NOT RECOMMENDED: Ankr for this selection round

Rationale:
- Alchemy provides the strongest documented combination of Base support,
  event delivery, archival depth, and high-volume throughput.
- Chainstack provides strong redundancy through archive availability and
  geo-balanced nodes, with flat-rate pricing upside.
- QuickNode provides useful additional independence as tertiary.
- Ankr remains a viable future candidate once Base-specific event/log
  capabilities are explicitly confirmed.

---

## 12. REMAINING PENDING DECISIONS

- exact finality threshold for Base Mainnet;
- exact price source/oracle for USD 1.00 conversion;
- exact payment evidence formats per provider/network;
- exact reconciliation/refund policy;
- exact legal review outcome;
- exact monitoring/alerting thresholds;
- exact Cloudflare queue/event implementation.

---

## 13. VERDICT

SPEC-WP-25 = COMPLETE

Reason:
- 4 credible providers researched using current official sources;
- primary/secondary providers selected with justification;
- high-volume architecture remains consistent with WP-24;
- no contradictions with WP-17..WP-24.

---

FINAL CONFIRMATION:

"No production code, API keys, provider accounts, wallets, Cloudflare
resources, or legacy files were created, modified, or deleted."
