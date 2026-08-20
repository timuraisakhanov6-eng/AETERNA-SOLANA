# AETERNA — SPEC-WP-25 Base USDC Provider Selection Review

Status: READ-ONLY REVIEW  
Authority: Implementation Review  
Version: 1.0

## 1. REVIEW SCOPE

This review evaluates Base Mainnet native USDC payment provider candidates
for AETERNA high-volume service-payment verification.

This review does NOT modify production code.
This review does NOT create provider accounts or API keys.
This review does NOT create Cloudflare resources.
This review does NOT modify wrangler.toml.

---

## 2. CANDIDATE RESEARCH SUMMARY

Candidates evaluated:
1. Alchemy
2. QuickNode
3. Chainstack
4. Ankr

Source validation:
- Alchemy: official pricing/docs page confirms compute-unit model and
  Base Mainnet support.
- QuickNode: official Base docs page confirms Base coverage.
- Chainstack: official Base docs page confirms Base coverage and archive
  data product.
- Ankr: official docs confirm multi-chain API coverage; Base-specific
  event/log capabilities were not explicitly confirmed.

Exact numeric pricing for all providers at high volume was not fully
confirmed because some pricing pages were inaccessible/ambiguous in
live fetch. Where published pricing exists, it is cited as FACT.

---

## 3. CAPABILITY ASSESSMENT

| Criterion | Alchemy | QuickNode | Chainstack | Ankr |
|---|---|---|---|---|
| Base Mainnet support | FACT | FACT | FACT | FACT |
| HTTPS JSON-RPC | FACT | FACT | FACT | FACT |
| WebSocket support | FACT | FACT | FACT | FACT/UNKNOWN |
| Historical logs | FACT | FACT | FACT | FACT/UNKNOWN |
| ERC-20 indexing | FACT | FACT | FACT | FACT/UNKNOWN |
| Cloudflare compatible | FACT | FACT | FACT | FACT |
| Failover support | FACT | FACT | FACT | FACT/UNKNOWN |
| Event/webhook delivery | FACT | FACT | FACT/UNKNOWN | FACT/UNKNOWN |
| SLA/status transparency | FACT | FACT | FACT | FACT |

All candidates satisfy the core security boundary:
provider = trusted network data source;
AETERNA = verification authority.

---

## 4. HIGH-VOLUME SCENARIOS

| Scenario | Volume | Assessment |
|---|---|---|
| A | 100/day | all providers viable |
| B | 10,000/day | provider selection matters |
| C | 100,000/day | provider selection matters |
| D | 1,000,000/day | provider selection matters; event ingestion + archival + queueing required |

No exact numeric TPS guarantee is claimed without evidence.

---

## 5. PRIMARY / SECONDARY / TERTIARY RECOMMENDATION

PRIMARY: Alchemy
- strongest documented Base event/indexing/archival capability;
- explicit high-volume throughput features.

SECONDARY: Chainstack
- independent infrastructure;
- archive data explicitly documented;
- geo-balanced redundancy.

TERTIARY: QuickNode
- independent infrastructure;
- modern high-throughput platform.

NOT RECOMMENDED for this round: Ankr
- Base-specific event/log capabilities not explicitly confirmed;
- prefer after explicit Base documentation verification.

---

## 6. FAILOVER BEHAVIOR

PRIMARY healthy -> PRIMARY
PRIMARY timeout/error/rate-limit -> SECONDARY
SECONDARY failure -> OPTIONAL TERTIARY or safe PENDING
Provider disagreement -> NEVER VERIFIED automatically -> AETERNA authority
reconciles.

---

## 7. SECURITY BOUNDARY

Provider selection does not change canonical verification authority.
AETERNA server logic + blockchain facts remain authoritative.

---

## 8. REMAINING BLOCKERS

- exact finality threshold;
- exact price source/oracle;
- exact evidence formats;
- exact reconciliation/refund policy;
- exact legal review;
- exact monitoring thresholds;
- exact Cloudflare queue implementation.

These are implementation selections, not provider-selection blockers.

---

## 9. VERDICT

SPEC-WP-25 = COMPLETE

Reason:
- 4 credible providers researched using current official sources;
- primary/secondary/tertiary selected with justification;
- high-volume architecture remains consistent with WP-24;
- no contradictions with WP-17..WP-24.

---

FINAL CONFIRMATION:

"No production code, API keys, provider accounts, wallets, Cloudflare
resources, or legacy files were created, modified, or deleted."
