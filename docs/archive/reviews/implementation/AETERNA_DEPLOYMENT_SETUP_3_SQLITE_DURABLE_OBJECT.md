# AETERNA — DEPLOYMENT-SETUP-3: SQLite-Backed Durable Object Deployment

Status: IMPLEMENTED, LIVE VALIDATION PENDING  
Authority: Read-Only Architecture Review  
Version: 1.0

## 1. Why Previous Deployment Failed

Cloudflare account requires SQLite-backed Durable Object namespaces for new classes. The previous attempt used `new_classes`, which is invalid for this account/project configuration. Error:

```
In order to use Durable Objects with a free plan, you must create a namespace using a `new_sqlite_classes` migration. [code: 10097]
```

## 2. SQLite-Backed DO Decision

Switched to required migration form:

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["CreditOperationCoordinator"]
```

This is the currently supported configuration for new Durable Object namespaces on this account.

## 3. Dedicated Worker Structure

Created minimal Worker at `functions/do/`:

- `src/index.ts` — Worker entrypoint exporting `CreditOperationCoordinator`
- `wrangler.toml` — Worker config with SQLite-backed DO binding + migration
- `creditOperationCoordinator.ts` — existing authoritative coordinator implementation
- `tsconfig.json` — existing Worker TS config

Single authoritative coordinator implementation; no second DO class introduced.

## 4. DO Configuration

`functions/do/wrangler.toml`:

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
new_sqlite_classes = ["CreditOperationCoordinator"]
```

## 5. Pages Binding

`wrangler.toml` retains external DO binding:

```toml
[durable_objects]
[[durable_objects.bindings]]
name = "CREDIT_OP_COORDINATOR"
class_name = "CreditOperationCoordinator"
script_name = "aeterna-credit-coordinator"
```

`pages_build_output_dir = "dist"` preserved. No Pages Functions broken.

## 6. Auth Result

`npx wrangler whoami` passes.

Account: Aisakhanovtimur84@gmail.com's Account
Account ID: 9780051950084fdb960e3cb3b4f89d74
Scopes include workers (write), pages (write), offline_access

## 7. Dry-Run Result

`npx wrangler deploy --dry-run` PASS from `functions/do/`.

- Worker entrypoint resolves
- Durable Object class resolves
- SQLite migration resolves
- Binding resolves

## 8. Deployment Result

Deployed:

- Worker name: `aeterna-credit-coordinator`
- DO class: `CreditOperationCoordinator`
- Migration: `v1` with `new_sqlite_classes`
- URL: https://aeterna-credit-coordinator.aisakhanovtimur84.workers.dev
- Version ID: `a9ab3c88-30fb-4477-ae97-478c53597489`

## 9. Pages → DO Connectivity

Pending live validation.

## 10. Live Concurrency Result

Pending — see DEPLOYMENT-VALIDATION-1.

## 11. Remaining Limitations

- Live Pages → DO connectivity unvalidated.
- Live concurrency validation pending.

---

AUDIT REPORT

FINAL CONFIRMATION:

"DEPLOYMENT-SETUP-3 changed only the dedicated Durable Object Worker deployment and SQLite-backed DO configuration/binding. No AETERNA business, payment, Creator Identity, Credit semantics, crypto, Vault, Manifest, storage, Seal, Trusted Time, Heartbeat, or Emergency Runtime semantics were changed."
