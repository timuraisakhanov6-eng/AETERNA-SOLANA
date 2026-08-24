# AETERNA — DEPLOYMENT-SETUP-2: External Durable Object Worker Binding

Status: BLOCKED  
Authority: Read-Only Architecture Review  
Version: 1.0

## 1. Previous Assumption Corrected

Cloudflare documentation confirms:

- Pages Functions CAN bind to Durable Objects hosted by a separate Worker.
- Pages itself cannot create/deploy the DO class.
- Local development supports: `wrangler pages dev dist --do CREDIT_OP_COORDINATOR=CreditOperationCoordinator@aeterna-credit-coordinator`.

Reference: https://developers.cloudflare.com/pages/functions/bindings/

## 2. Verified Cloudflare-Supported Architecture

AETERNA Pages
    ↓
Pages Functions
    ↓
CREDIT_OP_COORDINATOR binding
    ↓
Dedicated Worker: aeterna-credit-coordinator
    ↓
CreditOperationCoordinator Durable Object

## 3. Dedicated Worker Structure

Not deployed. A minimal Worker wrapper was prepared for validation and then removed to avoid leaving an incomplete deployment artifact.

Temporary structure used for validation:

- `functions/do/src/index.ts` — Worker entrypoint exporting `CreditOperationCoordinator`
- `functions/do/wrangler.toml` — Worker config with DO binding + migration
- `functions/do/tsconfig.json` — existing Worker TS config

Cleanup performed:

- Removed `functions/do/src/index.ts`
- Removed `functions/do/wrangler.toml`
- Removed empty `functions/do/src` directory

The authoritative coordinator implementation remains singular:

- `functions/do/creditOperationCoordinator.ts`
- `functions/do/tsconfig.json`

## 4. Durable Object Configuration

Validated dedicated Worker configuration:

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

Dry-run result:

- PASS
- Total Upload: 21.82 KiB / gzip: 4.09 KiB
- Binding resolves: `env.CREDIT_OP_COORDINATOR (CreditOperationCoordinator)`

## 5. Pages External Binding

Updated `wrangler.toml` DO section from:

```toml
[[durable_objects]]
binding = "CREDIT_OP_COORDINATOR"
class_name = "CreditOperationCoordinator"
```

To:

```toml
[durable_objects]
[[durable_objects.bindings]]
name = "CREDIT_OP_COORDINATOR"
class_name = "CreditOperationCoordinator"
script_name = "aeterna-credit-coordinator"
```

This preserves `pages_build_output_dir = "dist"` and does not break Pages Functions.

## 6. Local Development Workflow

Documented workflow, not executed:

Terminal A:
```
cd functions/do
npx wrangler dev
```

Terminal B:
```
cd <project-root>
npx wrangler pages dev dist --do CREDIT_OP_COORDINATOR=CreditOperationCoordinator@aeterna-credit-coordinator
```

## 7. Authentication Result

`npx wrangler whoami` now passes after fixing wrangler.toml syntax.

Account: Aisakhanovtimur84@gmail.com's Account
Account ID: 9780051950084fdb960e3cb3b4f89d74
Token scopes include: workers (write), pages (write), offline_access

## 8. Dry-Run Result

Dedicated Worker dry-run: PASS

```
npx wrangler deploy --dry-run
```

Output confirms:

- Worker entrypoint resolves
- Durable Object class resolves
- Migration resolves
- Binding resolves

## 9. Deployment Result

Live deployment of the dedicated Worker is BLOCKED by Cloudflare account restriction, not by local configuration.

Error on `npx wrangler deploy`:

```
A request to the Cloudflare API failed.
In order to use Durable Objects with a free plan, you must create a namespace using a `new_sqlite_classes` migration.
[code: 10097]
```

This is an account-level/platform limitation. This phase does not authorize or perform account plan changes.

## 10. Pages → DO Connectivity

Cannot be validated because the dedicated Worker was not deployed. The Pages wrangler.toml binding is syntactically valid and references the intended external Worker name, but live connectivity is unverified.

## 11. Live Concurrency Results

Pending — blocked by deployment failure in step 9.

## 12. Remaining Limitations

- Cloudflare account/plan limitation prevents Durable Object deployment in the dedicated Worker.
- Live Pages → DO connectivity not validated.
- DEPLOYMENT-VALIDATION-1 concurrency tests cannot proceed until deployment succeeds.

---

AUDIT REPORT

FINAL CONFIRMATION:

"DEPLOYMENT-SETUP-2 changed only deployment packaging and external Durable Object binding configuration required to host the already-approved CreditOperationCoordinator. No business, payment, Creator Identity, crypto, storage, Vault, Manifest, Seal, Trusted Time, Heartbeat, or Emergency Runtime semantics were changed."
