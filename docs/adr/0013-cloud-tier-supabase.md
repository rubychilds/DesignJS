# ADR-0013: Cloud tier — Supabase as the backbone

**Status:** Proposed
**Date:** 2026-06-10
**Owner:** Architecture
**Related:** [`docs/architecture/architecture-deployment.md`](../architecture/architecture-deployment.md) §6 (F.76 + F.77); [`docs/architecture/architecture-review-2026-05-24.md`](../architecture/architecture-review-2026-05-24.md) (Tier-4 ADR proposal); [`docs/specs/ai-chat.md`](../specs/ai-chat.md) (optional cloud key sync); [`docs/specs/repo-connection.md`](../specs/repo-connection.md) (GitHub App, Supabase auth, Storage, Postgres); [`docs/specs/projects.md`](../specs/projects.md) (multi-machine sync of `projects.json` index); [`docs/specs/sandbox-preview.md`](../specs/sandbox-preview.md) (CodeSandbox SDK free tier); related to [ADR-0015](./0015-bridge-protocol-v2.md) (bridge auth — precondition for any cloud-tier identity flow) and [ADR-0017](./0017-secrets-module.md) (cloud-tier secrets share the secrets-module surface)

---

## Context

DesignJS today is local-first by design. Everything ships against the user's machine: the Vite dev server, the WebSocket bridge on `127.0.0.1:29170`, the persistence middleware writing `.designjs.json` to disk, the MCP server spawned per-agent, the browser extension capturing pages into the local canvas. No DesignJS-owned cloud service exists. No Supabase code exists today. SECURITY.md's threat model is built around localhost trust; the deployment posture is "npm install + load-unpacked + go."

The forward-looking v0.2/v0.3 specs in [`docs/specs/`](../specs/) introduce features that don't fit a purely local model:

- **`ai-chat.md`** — optional cloud-hosted Settings → AI Providers backup so users don't lose keys when they swap machines. Tier 1 (OS keychain) and Tier 2 (`~/.designjs/secrets.json`) cover the single-machine cases; only a cloud surface covers multi-machine.
- **`repo-connection.md`** — v1 ships OAuth-PKCE direct from the browser (backend-free, matches local-first positioning). The cloud tier adds a GitHub *App* (not OAuth App) for per-repo permissions, short-lived installation tokens, and webhooks. The App's private key (`.pem`) must live in a server-side environment.
- **`projects.md`** — `~/.designjs/projects.json` is the local recents index. Multi-machine "one merged list" requires a synced server-side copy.
- **`sandbox-preview.md`** — CodeSandbox SDK ships free-tier sandboxes via a DesignJS-provided API key (BYOK for power users); the provided key has to live somewhere agents can reach without being baked into the OSS app bundle.
- **`swarm.md`** — possibly a hosted MCP relay for SWARM agents that run server-side; not explicitly required but on the table.

The deployment deep dive (F.76) called the right move: **lock the cloud-tier architecture in an ADR *before* implementation**, so when Track A and Track B start touching cloud code, deployment is calibrated and the secrets/identity/observability primitives are already chosen. This ADR does that — it picks the backbone, the surface allocation, the env-var story, the migration shape, and the cost/privacy posture. It does **not** pick an implementation timeline; that depends on which v0.2/v0.3 feature lands first.

This ADR is load-bearing because:

1. **Auth is the central spine.** Once a Supabase Auth identity exists, every other surface (Storage for `.designjs.json` blobs, Postgres for the `projects.json` mirror, Edge Functions for the GitHub App webhook) keys off the same user-id. Picking the wrong backbone means re-doing the identity model later.
2. **The cloud tier is a new attack surface.** It must be designed with ADR-0015 (bridge protocol v2 — token + capabilities) and ADR-0017 (secrets module — `~/.designjs/secrets.json`) as preconditions. The local-first defenses (localhost-only bridge, file-mode 0o600 on disk) don't apply server-side; new defenses are needed.
3. **Vendor choice locks pricing, regions, compliance.** Picking Supabase vs Firebase vs Convex vs Cloudflare D1+Workers vs custom Postgres+API isn't a small decision — it cascades into every cost-monitoring, data-residency, and incident-response decision downstream.

---

## Decision

Adopt **Supabase as the cloud-tier backbone**. The cloud tier ships only when a v0.2/v0.3 feature genuinely needs it (chat key sync, GitHub App for repo connection, multi-machine projects index, free-tier sandbox); the OSS local-first canvas continues to work without it.

### 1. Why Supabase over alternatives

| Option | Why not |
|---|---|
| **Firebase** | Firestore is a poor fit for the relational shape we need (`projects.json` index → user_id → project_id rows; team-membership joins). No Postgres. Vendor lock-in to Google's auth ecosystem. Pricing harder to predict at scale. |
| **AWS Amplify** | Power and breadth come with operational complexity that doesn't match a solo-dev + Claude cadence. IAM + CloudFormation + Cognito is multi-week setup; Supabase is multi-hour. |
| **Convex** | Reactive query model is interesting but unfamiliar; we'd be a beta-tier dependent on Convex's roadmap. Not open-source (closed Rust runtime). No clean self-host story. |
| **Cloudflare D1 + Workers** | D1 is SQLite; the row count + JSON-blob shape we need pushes against SQLite's strengths. No managed auth equivalent — we'd have to roll our own JWT/OAuth flows. |
| **Custom Postgres + API server** | Highest control; highest ops burden. Provisioning Postgres + writing the API layer + managing migrations + standing up auth + Storage equivalent is multi-week. Defer until cloud usage justifies the build-vs-buy flip. |

**Supabase wins on:**

- **Managed Postgres** is the right primitive for the data shapes we need (`projects` table, `team_members` table, `recent_projects` index, blob references). Plain SQL; no learning curve beyond standard Postgres.
- **Auth, Storage, Edge Functions in one platform.** Single dashboard, single billing, single set of secrets to manage. Reduces operational surface vs assembling four vendors.
- **Edge Functions are the right primitive for the GitHub App webhook handlers.** Deno runtime; standard `Request`/`Response` interface; deploys via `supabase functions deploy`.
- **Open-source.** The core is Apache 2.0; the platform can be self-hosted later via the `supabase/supabase` Docker compose stack if a user needs full data sovereignty (enterprise, sensitive industries). Reduces "what if Supabase goes away" risk to "self-host the Docker image."
- **Pricing is predictable.** Free tier (500 MB Postgres, 1 GB Storage, 50 K MAU on Auth, 500 K Edge Function invocations) covers early users. Pro tier is a flat $25/month per project, then linear usage charges. No surprise bill spikes.
- **Compatible with Postgres ecosystem.** Standard `psql`, `pg_dump`, `pg_restore`, Prisma, Drizzle, Kysely — anything that speaks Postgres works. No proprietary client library lock-in beyond convenience.

The trade-off Supabase makes that we accept: it's a **vendor managed service** rather than a self-hosted-by-default stack. We mitigate via the open-source escape hatch (Docker self-host) and by not coupling our schema to Supabase-specific Postgres extensions (we use `pgcrypto` and `pgjwt` if needed, both standard; we avoid `pg_graphql` to keep the schema portable).

### 2. Surface allocation

| Supabase surface | DesignJS use |
|---|---|
| **Auth** | User identity. Email/password + GitHub OAuth (the same OAuth-App from `repo-connection.md` v1 doubles as the sign-in provider — one consent screen for the user). JWTs issued by Supabase Auth; RLS (row-level security) policies on every table key off `auth.uid()`. |
| **Storage** | `.designjs.json` blobs for multi-machine project sync. One bucket per user (path: `users/{user_id}/projects/{project_id}.designjs.json`); RLS-protected; up to 50 MB per blob (covers any realistic design file). |
| **Postgres** | Project metadata table (project_id, owner_user_id, name, last_modified, blob_path); recents index (mirror of `projects.json`); team membership table (project_id, member_user_id, role); future: tokens table for sandbox-preview API key allocation. |
| **Edge Functions** | GitHub App webhook handlers (`/webhooks/github/installation`, `/webhooks/github/push`); OAuth callback (`/auth/github/callback` for the cloud sign-in flow); Sentry server-side ingestion if we route through our own proxy (deferred to ADR-0014). |
| **Realtime** | Not used in v0.3. Reserved for multi-user collab if that ever lands (v1.0+). |

**What stays out of Supabase:**

- The OSS canvas itself (`@designjs/app`) continues to run locally. Supabase is a *companion* to the local canvas, not a replacement.
- The MCP server stays in-process (stdio). No cloud-hosted MCP relay in v0.3 unless SWARM forces it (separate ADR if so).
- The bridge WebSocket stays on `127.0.0.1`. ADR-0015 (bridge protocol v2) closes the localhost-bridge auth gap — that's independent of this ADR.
- Browser-extension capture remains local. The Chrome Web Store distribution path doesn't touch Supabase.

### 3. Environment management — dev / staging / prod

Three separate Supabase *projects* (the platform's term for an isolated instance — its own Postgres, Auth users, Storage buckets, Edge Functions, dashboard):

- **`designjs-dev`** — solo-dev sandbox. Resettable. Used for local testing of Edge Functions via `supabase functions serve`.
- **`designjs-staging`** — mirrors prod schema; populated with synthetic data. Used to verify migrations + Edge Function deploys before production. Deletable + recreatable.
- **`designjs-prod`** — real user data. Migrations gated through PR review + the staging deploy succeeding first.

Each project has its own `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. The app reads these from environment variables:

```
# .env.example
SUPABASE_URL=
SUPABASE_ANON_KEY=
# SERVICE_ROLE_KEY is never read by the browser — Edge Function env only.
```

A **`packages/app/src/env.ts`** Zod schema validates env at boot. Pattern matches the well-deployed Hono / Vercel pattern flagged in F.77:

```ts
// packages/app/src/env.ts (proposed)
import { z } from "zod";

const Env = z.object({
  SUPABASE_URL: z.string().url().optional(),  // optional — local-first canvas runs without it
  SUPABASE_ANON_KEY: z.string().optional(),
});

export const env = Env.parse(import.meta.env);
```

Cloud-tier features check `env.SUPABASE_URL` at boot; if absent, they degrade to local-only (chat key sync disabled, projects sync disabled, etc.). The OSS canvas remains usable without any Supabase env set.

### 4. Secrets

| Secret | Where it lives | How it's read |
|---|---|---|
| `SUPABASE_URL` | `.env.production` for the hosted cloud surface; user's local `.env` if they self-host | `import.meta.env.SUPABASE_URL` via Vite (browser-safe — public URL) |
| `SUPABASE_ANON_KEY` | Same as above | `import.meta.env.SUPABASE_ANON_KEY` (browser-safe — designed to be public, RLS does the enforcement) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Supabase Edge Function env only** — never in browser, never in CI logs | `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` inside the Edge Function runtime |
| `GITHUB_APP_PRIVATE_KEY` (`.pem`) | Supabase Edge Function env (multi-line) | `Deno.env.get("GITHUB_APP_PRIVATE_KEY")` |
| `GITHUB_APP_WEBHOOK_SECRET` | Same | Used to verify webhook payload signatures |
| `SENTRY_DSN` (Edge Function) | Same; separate from the browser DSN (ADR-0014) | `Deno.env.get("SENTRY_DSN_SERVER")` |

The browser bundle never sees `SERVICE_ROLE_KEY` or any GitHub App secret. Every privileged write goes through an Edge Function that does the privileged work server-side. This is the standard Supabase pattern (the docs make it explicit) and aligns with ADR-0017's "renderer never sees secrets" principle.

User-provided API keys (OpenRouter / Anthropic / OpenAI / Gemini / GitHub OAuth tokens) **do not live in Supabase** by default — they live in the user's `~/.designjs/secrets.json` per ADR-0017. The cloud-tier *optional* sync (ai-chat.md's "don't lose keys on machine swap") encrypts the secrets blob client-side before uploading and stores ciphertext only — Supabase never holds plaintext keys. The decryption key derives from the user's password via PBKDF2 / Argon2; on a new machine the user re-enters their password to decrypt. (Implementation detail; not load-bearing for this ADR but flagged so the schema reserves a `secrets_blob` column.)

### 5. Database migrations

`supabase/migrations/` directory at the repo root. Migrations versioned as timestamped SQL files (the Supabase CLI's default — `20260710120000_initial_schema.sql`). Supabase CLI added to root `devDependencies`:

```jsonc
// package.json (root, proposed)
"devDependencies": {
  "supabase": "^1.x"
}
```

Workflow:

1. Schema change → write SQL migration locally → `supabase db push` against `designjs-dev`
2. Verify behavior → commit the migration file in a PR
3. PR review checks the migration alongside the application code change
4. Merge → CI deploys migration to `designjs-staging` automatically (verified there)
5. Manual `supabase db push --linked` against `designjs-prod` after staging confirmed

No auto-deploy to prod; migrations are the highest-blast-radius change we'll make. The manual gate is intentional.

**RLS policies are migrations too.** Every table gets `enable row level security` + explicit policies for `select` / `insert` / `update` / `delete`. The default-deny stance is the right one for user-data tables.

### 6. Domain + DNS

The cloud tier needs a real domain. The current `opencanvas.mintlify.app` is docs-only and pre-rebrand; the cloud tier is its own surface.

Proposed: **`app.designjs.dev`** for the cloud-tier API surface (Edge Functions + auth callbacks) and **`designjs.dev`** as the marketing/root.

- **Registrar:** the team's preferred registrar (Cloudflare Registrar or Namecheap — TBD; pick whichever the user already has the account at).
- **DNS:** Cloudflare DNS for both apex and `app.` subdomain. Cloudflare proxying *off* for the Supabase custom-domain mapping (Supabase needs direct DNS for SSL handling per their docs).
- **Supabase custom domain:** mapped via the Supabase dashboard. Costs $10/mo per project on the Pro tier (Supabase pricing as of 2026); free-tier Supabase uses the auto-assigned `*.supabase.co` subdomain (acceptable for staging, not ideal for prod).
- **Edge Function paths:** mapped under `app.designjs.dev/functions/v1/*` per Supabase's URL shape.

The OSS canvas continues to ship without any domain dependency — it points at `127.0.0.1:29170` by default and only reaches `app.designjs.dev` when the user opts into cloud features.

### 7. Cost monitoring

Supabase provides per-project cost dashboards. The cost-monitoring posture:

- **Free tier first.** Each environment (dev / staging / prod) starts on the free tier ($0). The free tier covers ~50 K MAU on Auth + 500 MB Postgres + 1 GB Storage + 500 K Edge Function invocations. Sufficient for the first ~1000 cloud-tier users.
- **Pro tier when free tier is exceeded.** $25/mo per project, then linear usage above the included quotas. Predictable.
- **Alert thresholds:** Supabase dashboard alerts configured at **50% / 80% / 100%** of monthly budget. Budget = $50/mo per environment in the early phase; revisit when usage justifies (the alert at 100% is the "stop and decide" point, not the bill ceiling).
- **Monthly cost review.** Solo dev + Claude flow: a recurring journal entry to check the Supabase dashboard once a month and note any cost trajectory changes. No automation in v0.3.
- **Hard guard against runaway costs:** Supabase Pro tier supports per-project spend caps; enable at $200/mo per environment to prevent a runaway Edge Function loop from generating a $5000 bill.

If cloud-tier usage exceeds ~$500/mo total across environments, that's the signal that the cloud tier is real and warrants a dedicated review (not just a continued dev side-project).

### 8. Observability for the cloud tier

Three layers — each has its own ADR or addendum:

- **Supabase Logs** (built into the platform) — every Edge Function invocation, every Auth event, every Postgres query above a threshold. Free with the platform; first stop for debugging.
- **Sentry for Edge Functions** — exception capture in the Deno runtime. Separate Sentry project from the browser DSN. **ADR-0014 (Observability stack) covers Sentry + PostHog selection;** this ADR commits to *using* Sentry, deferring the *justification* to ADR-0014.
- **PostHog for product analytics** — cloud-tier feature usage events (`cloud_chat_key_sync_enabled`, `cloud_repo_connected`, `cloud_project_synced`). Opt-in only, scrubbed of PII in `beforeSend`. Same ADR-0014 governs the PostHog selection.

The cloud-tier Edge Functions emit structured logs (JSON, with `trace_id` + `user_id` fields). Supabase Logs ingests them; Sentry receives only the exceptions. The browser canvas reports its own client-side errors through a separate Sentry browser DSN (ADR-0014 scope).

### 9. GDPR + data residency

The cloud tier holds PII (email address, GitHub OAuth tokens, project blobs that may include personal designs). Posture:

- **EU users get an EU-region Supabase project.** Supabase supports multi-region by deploying separate projects (one per region) and routing users by their declared region on signup. Defer the multi-region split until ≥10 EU users actually sign up — single `us-east-1` `designjs-prod` is fine until then. The schema is identical; the routing is the only new piece.
- **Opt-in for analytics.** Aligns with the privacy-conscious DesignJS user base (the local-first positioning attracts users who care about data sovereignty). PostHog's `opt_in_capturing` flag stays false until the user explicitly enables analytics in Settings.
- **PII scrubbing in Sentry/PostHog `beforeSend`.** Email addresses, GitHub OAuth tokens, file contents — all stripped client-side before any telemetry leaves the user's machine. The scrub list is exhaustive; a unit test asserts that a synthetic payload containing each PII field comes out scrubbed.
- **Data export + delete.** Users can request their data via Settings → Account → Export (downloads a JSON of all their cloud-tier data) and Settings → Account → Delete (cascades through Postgres tables and Storage buckets). Both endpoints land as Edge Functions before the cloud tier ships to non-dev users.
- **Privacy policy on `designjs.dev`** — covers what's collected, why, retention period, and the export/delete flows. Lands alongside cloud-tier launch.

The local-first OSS canvas continues to ship with **no telemetry, no collection, nothing leaves the user's machine** unless the user opts into cloud features. That posture is the differentiator vs Figma / Onlook / Dessn and should not be diluted.

---

## Consequences

### Positive

- **Managed platform, one mental model.** Auth + Storage + Postgres + Edge Functions all live in one dashboard. Beats assembling four vendors.
- **Free tier suffices for early users.** $0 until we cross ~1000 active cloud-tier users. The cloud tier can ship without a real spend commitment.
- **Postgres is the right primitive.** Standard SQL, ecosystem-compatible, no proprietary client library lock-in. If we ever leave Supabase, the data shape comes with us.
- **Open-source escape hatch.** Self-host the same Supabase stack via Docker if vendor lock-in concerns surface. Reduces "what if Supabase changes pricing or goes away" risk.
- **GitHub App webhooks fit Edge Functions cleanly.** Deno runtime, standard `Request`/`Response`; no separate API server to stand up.
- **Local-first stays the default.** The OSS canvas works without any Supabase env set. Cloud is opt-in.

### Negative

- **Vendor lock-in to Supabase's Postgres dialect** — though it's standard Postgres, we accumulate Supabase-specific Auth flows (`auth.uid()` in RLS policies, the `supabase-js` client library). Migrating off Supabase later means rewriting auth + RLS, even if the schema is portable.
- **The cloud tier is a new attack surface.** Localhost-trust assumptions don't apply. Server-side auth, RLS policies, Edge Function input validation, rate limiting, and incident response all become real. ADR-0015 and ADR-0017 are preconditions, not nice-to-haves.
- **Operational burden grows.** Migrations, monthly cost review, alert response, GDPR data-export/delete flows — none of these exist today. A solo-dev + Claude cadence can carry it but the cadence shifts (no more "ship and forget").
- **Two distribution stories to maintain.** OSS local-first (npm + load-unpacked) and cloud-hosted (`app.designjs.dev`). Docs need to cover both clearly; bugs may surface in one and not the other.

### Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Supabase pricing changes | Med | Open-source self-host as the escape hatch. Annual review of pricing trajectory. |
| Supabase outage = cloud-tier outage | Med | Cloud-tier features degrade gracefully — chat key sync just doesn't sync; projects gallery falls back to local `projects.json`. The OSS canvas keeps working. |
| Cloud-tier schema migration mistake corrupts production data | High | Staging-first migration workflow; manual prod-push gate; `pg_dump` backups daily (Supabase Pro tier ships these); rollback playbook documented before prod-deploy ever happens. |
| GitHub App private key leak | Critical | Edge Function env only; rotated every 6 months; key rotation runbook documented; revoke + reissue procedure tested in staging. |
| GDPR audit finds unscrubbed PII in Sentry / PostHog | Med | Unit test on the `beforeSend` scrub list with synthetic PII payloads; quarterly review of what we collect vs what the privacy policy claims. |
| Cloud-tier cost runaway from a Function bug | Med | $200/mo hard spend cap per environment; alerts at 50% / 80% / 100% of budget. |

---

## Open questions

1. **Does the cloud tier ship as a separate `cloud.designjs.dev` deployment, or as a per-user opt-in inside the OSS canvas?** Per-user opt-in keeps the surface unified (one app, one settings panel, cloud features grayed out until you sign in). Separate deployment is cleaner for billing + SOC2 scope but doubles the maintenance. Leaning toward per-user opt-in — but the answer depends on whether we ever need to gate cloud features behind a paid tier (separate deployment makes that cleaner). Resolve before Track A or B starts touching cloud code.

2. **Self-hosted Supabase option for enterprise users?** The OSS escape hatch is real (Supabase's Apache 2.0 license + Docker compose), but supporting it as a first-class option means documenting the deploy, testing migrations against both Supabase Cloud and self-host, and answering support questions. Defer until an enterprise user actually asks. Reserve a "Self-hosting the DesignJS cloud tier" doc slot.

3. **What's the right region split timing?** Single `us-east-1` covers North American + most international users. EU regions matter when ≥10 EU users sign up; APAC when ≥10 APAC users. The trigger is real demand, not preemptive optimization.

4. **Does the GitHub OAuth identity (from `repo-connection.md` v1, browser-only PKCE) double as the cloud-tier sign-in?** If yes, one OAuth consent screen covers both. If no, the user signs in twice (once for repo access, once for cloud account). One-consent is the better UX but requires the cloud tier to reuse the OAuth client + receive the access token. Resolve when Track B (repo connection) starts.

5. **What's the right cloud-tier observability granularity?** PostHog event schema for cloud-tier features needs design alongside ADR-0014; this ADR defers that.

6. **Per-tier feature gating** — chat key sync free, GitHub App enterprise? — is a product decision, not architecture. Defer.

---

## References

### Authoritative
- [Supabase docs](https://supabase.com/docs) — Auth, Storage, Edge Functions, Postgres, RLS, custom domains
- [Supabase pricing](https://supabase.com/pricing) — free tier limits + Pro tier flat fee
- [GitHub Apps docs](https://docs.github.com/en/apps) — per-repo permissions, installation tokens, webhook signature verification

### Internal prior art
- [`docs/architecture/architecture-deployment.md`](../architecture/architecture-deployment.md) §6 — F.76 (cloud-tier ADR needed before implementation) + F.77 (`.env.example` + Zod validation)
- [`docs/architecture/architecture-security.md`](../architecture/architecture-security.md) §8 — forward-looking security considerations for the cloud tier
- [`docs/specs/repo-connection.md`](../specs/repo-connection.md) — Supabase + GitHub App architecture in the spec
- [`docs/specs/projects.md`](../specs/projects.md) — multi-machine sync of `projects.json` index
- [`docs/specs/ai-chat.md`](../specs/ai-chat.md) — three-tier key storage; cloud-tier is the optional fourth backup

### Coupled ADRs (preconditions)
- [ADR-0015](./0015-bridge-protocol-v2.md) — bridge auth (token + capabilities). The cloud tier needs the local bridge already hardened before any cloud-side identity flows.
- [ADR-0017](./0017-secrets-module.md) — secrets module (`~/.designjs/secrets.json`). The cloud tier reuses the secrets-module surface for any client-held secrets.

### Deferred companion ADRs
- ADR-0014 — Observability stack (Sentry + PostHog) — defers cloud-tier observability instrumentation.
- ADR-0016 — Doc drift remediation — separate concern.

---

*End of ADR-0013.*
