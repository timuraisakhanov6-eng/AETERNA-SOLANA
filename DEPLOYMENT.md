# AETERNA DEPLOYMENT MODEL

Status: canonical operational documentation
Authority: deployment governance
Scope: production deployment + runtime integrity
Compatibility: canonical protocol documentation (docs/canonical/AETERNA_COMPLETE_SYSTEM_LOGIC.md)

---

# 1. PURPOSE

This document defines the canonical deployment requirements for AETERNA.

Deployment integrity is protocol-critical.

Operational deployment MUST preserve:

- runtime parity
- authority isolation
- fail-closed behavior
- cryptographic integrity
- trusted-time integrity

Deployment MUST remain subordinate to the canonical protocol.

---

# 2. DEPLOYMENT PRINCIPLE

Infrastructure MUST remain subordinate to protocol invariants.

Operational convenience MUST NEVER override:

- protocol invariants
- cryptographic correctness
- authority isolation
- temporal authority
- decrypt ordering
- runtime validation
- fail-closed behavior

---

# 3. ENVIRONMENT MODEL

Canonical environments:

| Environment | Purpose |
|---|---|
| Development | Local protocol development |
| Staging | Pre-production validation |
| Production | Canonical live deployment |

Environment drift MUST be minimized.

---

# 4. PRODUCTION REQUIREMENTS

Production deployments MUST preserve:

- HTTPS-only transport
- canonical Trusted Time authority
- immutable static asset delivery
- secure environment isolation
- runtime validation parity

Production deployments MUST fail closed on uncertainty.

---

# 5. SECRET HANDLING

Operational secrets MAY include:

- payment verification secrets
- storage credentials
- upload credentials
- webhook verification secrets

Operational secrets MUST NEVER include:

- recipientSecret
- creatorAuthority
- vault keys
- decrypted vault contents
- plaintext

Recipient decrypt authority remains entirely client-side.

---

# 6. STATIC ASSET REQUIREMENTS

Critical runtime assets include:

- creator runtime
- recipient runtime
- emergency runtime
- cryptographic logic
- validation logic

Deployments MUST preserve:

- immutable asset integrity
- deterministic runtime behavior
- runtime parity

Runtime drift is forbidden.

---

# 7. TRUSTED TIME REQUIREMENTS

Production deployments MUST preserve:

- canonical /api/time behavior
- UTC consistency
- Trusted Time exclusivity
- fail-closed temporal behavior

Trusted Time participates only in Open Authority.

Local infrastructure time MUST NOT replace Trusted Time authority.

---

# 8. AUTHORITY ISOLATION

Deployment MUST preserve separation of:

- Ciphertext Authority
- Open Authority
- Business Authority
- Storage Authority

Runtime Layer is NOT an Authority.

Deployment MUST NOT introduce authority leakage.

---

# 9. ENVIRONMENT ISOLATION

Production systems SHOULD isolate:

- development
- staging
- production
- webhook endpoints
- upload authority
- operational credentials

Cross-environment authority leakage is forbidden.

---

# 10. PAYMENT REQUIREMENTS

Production payment systems MUST preserve:

- Creator Service Quote authority
- payment verification ordering
- upload-after-payment enforcement
- transaction verification integrity
- 1 USDC fixed service fee
- one verified payment → at most one Creator Credit
- frontend non-authority

Payment integrations MUST NOT gain:

- decrypt authority
- protocol authority
- capability authority

---

# 11. STORAGE REQUIREMENTS

Production storage infrastructure MUST preserve:

- ciphertext-only persistence
- hostile gateway assumptions
- integrity verification ordering
- immutable storage semantics

Storage infrastructure remains hostile.

Storage providers MUST NOT gain:

- decrypt authority
- capability authority
- Business Authority
- Open Authority

---

# 12. RUNTIME PARITY

Deployments MUST preserve parity across:

- creator runtime
- recipient runtime
- emergency runtime

Parity includes:

- validation rules
- decrypt ordering
- Trusted Time semantics
- Heartbeat behavior
- fail-closed behavior

Runtime drift is forbidden.

---

# 13. STREAMING REQUIREMENTS

Deployment MUST preserve:

- Streaming Preview
- Streaming Upload
- Streaming Download
- Streaming Reconstruction
- Bounded Memory

Infrastructure MUST NOT require whole-capsule buffering.

---

# 14. DEPLOYMENT VALIDATION

Production deployments SHOULD validate:

- canonical API responses
- emergency runtime availability
- Heartbeat parity
- decrypt ordering parity
- Trusted Time integrity
- manifest validation parity
- runtime parity

Deployment verification is mandatory before release.

---

# 15. FAIL-CLOSED DEPLOYMENT MODEL

Operational uncertainty MUST fail closed.

Deployment MUST NOT:

- bypass validation
- bypass authority verification
- bypass unlock ordering
- weaken runtime parity

Availability MUST NOT override protocol guarantees.

---

# 16. FORBIDDEN CONDITIONS

The following deployment conditions are forbidden:

- local-time unlock authority
- backend decrypt authority
- plaintext persistence
- upload-before-payment
- runtime authority
- weakened emergency runtime validation
- runtime parity drift
- fail-open behavior
- insecure secret exposure

Any deployment introducing these conditions is invalid.

---

# 17. SECURITY RATIONALE

The deployment model preserves:

- protocol invariants
- runtime integrity
- operational consistency
- deterministic protocol behavior
- authority isolation
- runtime parity
- fail-closed operation

Deployment security derives from preserving canonical protocol invariants.

---

# 18. RELEASE RUNBOOK

This section records the deployment procedure evidenced by the October 2026
release (see the repository release evidence: wrangler 4.152.0 Pages direct
upload, deployment trigger `ad_hoc` on branch `main`). Commands below are
taken from `package.json` and `wrangler.toml` in this repository.

## 18.1 Deploy from a clean tree — never from dirty WIP

The October 26, 2026 production deployment was uploaded with uncommitted
working-tree changes (`commit_dirty: true` in the deployment metadata). The
deployed bytes are therefore not fully reproducible from any Git commit.

Before deploying:

1. Run `git status --short`. If it is not empty, either commit the changes or
   deploy from a separate, clean checkout of the exact commit you intend to
   release (the release-recovery process used a dedicated candidate
   directory for this reason).
2. Never deploy from a directory that contains temporary or generated
   material: `.release-recovery-*`, `.wb-*`, `dist-tmp-*`, `.tmp-*`,
   `benchmarks/`, probe files (`vite.probe.config.ts`, `probe_bundle.js`,
   `src/probe/`, `public/irys-probe.html`), or recovery archives. The
   published output directory is `dist/` (`pages_build_output_dir` in
   `wrangler.toml`); only what the build produces into `dist/` is uploaded.

## 18.2 Local validation before release

`package.json` provides:

- `npm run release:verify` — the full release gate:
  `typecheck:do` + `typecheck:broadcast` + `typecheck:emergency` + `build`
  (SPA + runtime + emergency) + `test` (vitest) + `lint` (eslint).
- `npm run typecheck` — full TypeScript check.
- `npm run build` — produces `dist/` (SPA), the emergency runtime, and the
  runtime bundle.

Record the outputs of these steps with the release.

## 18.3 Production build and deploy

1. Run `npm run build` from the clean tree.
2. Deploy the produced `dist/` with Wrangler Pages direct upload:

   `npx wrangler pages deploy dist`

   The project is `aeterna-solana` (`wrangler.toml`); production is served
   from branch `main`. Confirm the exact flags with
   `npx wrangler pages deploy --help` before first use. Preserve the command
   output (it names the new deployment and its preview URL) with the release
   evidence.

## 18.4 Post-deployment verification

Deployment success (the deploy command returned OK) is NOT proof that the
expected source and assets were deployed. Verify explicitly:

1. Fetch the production home page and confirm HTTP 200 and the expected
   security headers (the October release captured these as
   `deployment-headers-after.txt`).
2. Fetch `/api/time` and confirm a JSON body of the form
   `{"nowUtc": <integer milliseconds>}` — the Trusted Time endpoint.
3. Fetch `/emergency.html` and confirm it loads.
4. Source-level check: compute the SHA-256 of the built main bundle in
   `dist/assets/` (e.g. `sha256sum dist/assets/index-*.js`) and compare it
   against the same file fetched from the production URL. The October
   release verified `dist/assets/index-Df9KUk0n.js` this way
   (SHA-256 `514b022a…490270`). Hashes are recorded before deploying.

## 18.5 Identifying a known-good deployment and rolling back

- Every deployment has an id (for example
  `e19a34f4-ca54-485d-94c3-d58424fb3bd8` for the October 26, 2026 release,
  and `df65be24-8b37-4693-b1dc-ecc01f071160` for the previous known-good
  one). Record the deployment id of every release.
- A production deployment can be rolled back to a previous deployment via
  the Cloudflare Pages API:
  `POST /accounts/{account_id}/pages/projects/aeterna-solana/deployments/{deployment_id}/rollback`
  where `{deployment_id}` is the known-good deployment to restore. The
  account id is visible in the Cloudflare dashboard (it must not be treated
  as a secret, but do not publish it).
- Rollback re-points production at the old deployment's assets and
  functions. A rollback must be verified with the same checks as §18.4.

## 18.6 Verification after rollback

1. Repeat the §18.4 checks (home page, headers, `/api/time`, emergency page).
2. Confirm the served main-bundle hash matches the bundle recorded for the
   deployment that was rolled back TO, not the deployment that was rolled
   back FROM.
3. Record the rollback completion in the release evidence.

---

# 19. FINAL DEPLOYMENT PRINCIPLE

Protocol invariants override operational convenience.

Canonical architecture overrides infrastructure shortcuts.

Runtime parity overrides deployment optimization.

Fail-closed deployment behavior is mandatory across all environments.