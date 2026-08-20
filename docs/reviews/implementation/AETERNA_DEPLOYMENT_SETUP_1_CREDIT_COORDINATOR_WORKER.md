# AETERNA — DEPLOYMENT-SETUP-1: Credit Coordinator Dedicated Worker

Status: IMPLEMENTED, LIVE VALIDATION PENDING  
Authority: Read-Only Architecture Review  
Version: 1.0

## 1. Current Pages Architecture

The AETERNA frontend is currently packaged as a Cloudflare Pages application:

- `pages_build_output_dir = "dist"` in root `wrangler.toml`
- Pages Functions located under `functions/api/*`
- SPA/runtime/emergency bundles built via Vite
- No existing dedicated Worker entrypoint found

## 2. Why Pages Alone Cannot Host the DO Class

Cloudflare Pages Functions does not provide Durable Object class definitions or `[[migrations]]`. A DO implementation requires a Worker with:

- explicit `main` entrypoint
- `[[durable_objects]]` bindings
- `[[migrations]]`
- Worker-level routing/hosting

While Pages Functions can call DO stubs, the DO class itself must be hosted by a Worker, not Pages runtime.

## 3. Dedicated Worker Architecture

New minimal Worker structure at `functions/do/`:

```
functions/do/
  src/
    index.ts          # Worker entrypoint
  creditOperationCoordinator.ts
  wrangler.toml
  tsconfig.json
```

This Worker:
- hosts the `CreditOperationCoordinator` DO class
- provides minimal fetch handler
- is not a substitute for Pages application logic
- is the sole authoritative DO host

## 4. Files Created/Modified

Created:
- `functions/do/src/index.ts`
- `functions/do/wrangler.toml`
- `docs/reviews/implementation/AETERNA_DEPLOYMENT_SETUP_1_CREDIT_COORDINATOR_WORKER.md`

Existing canonical implementation reused:
- `functions/do/creditOperationCoordinator.ts`
- `functions/do/tsconfig.json`
- `functions/api/creator/reserve-lifecycle.ts`
- `functions/api/creator/finalize-credit.ts`
- `functions/api/creator/recover-lifecycle.ts`

## 5. Wrangler Configurations

Dedicated Worker config (`functions/do/wrangler.toml`):

```toml
name = "aeterna-credit-coordinator"
main = "src/index.ts"
compatibility_date = "2026-03-13"
compatibility_flags = ["nodejs_compat"]

[durable_objects]
bindings = [
  { name = "CREDIT_OP_COORDINATOR", class_name = "CreditOperationCoordinator" }
]

[[migrations]]
tag = "v1"
new_classes = ["CreditOperationCoordinator"]
```

Pages config (`wrangler.toml`) updated to reference the dedicated Worker via remote DO binding.

## 6. Pages → DO Binding

The Pages Wrangler configuration now includes a remote Durable Object binding to the dedicated Worker, enabling Pages Functions to resolve `env.CREDIT_OP_COORDINATOR`.

## 7. Local Development Workflow

Terminal A — dedicated Worker:
```
cd functions/do
npx wrangler dev
```

Terminal B — Pages app:
```
cd <project-root>
npm run dev
```

Pages development connects to the running DO Worker via the remote binding.

## 8. Deployment Preflight

Run dedicated Worker dry-run:
```
cd functions/do
npx wrangler deploy --dry-run
```

Validate Pages configuration separately.

## 9. Authentication Result

Authentication check pending due to `npx wrangler whoami` failing on Pages wrangler.toml parsing. Dedicated Worker config may resolve wrangler config issue.

## 10. Deployment Result

Pending — dedicated Worker config created, not yet deployed.

## 11. Live Connectivity Result

Pending — requires successful deployment + auth.

## 12. Concurrency Validation

Pending — see DEPLOYMENT-VALIDATION-1.

## 13. Failure/Crash Validation

Pending — requires live deployment.

## 14. Remaining Blockers

1. Cloudflare authentication state unknown
2. Dedicated Worker not yet deployed
3. Pages remote DO binding not yet validated against live Worker

---

AUDIT REPORT

FINAL CONFIRMATION:

"DEPLOYMENT-SETUP-1 changed only the deployment packaging/binding required to host the already-approved CreditOperationCoordinator Durable Object. No business, payment, Creator Identity, crypto, storage, Vault, Manifest, Seal, Trusted Time, Heartbeat, or Emergency Runtime semantics were changed."
