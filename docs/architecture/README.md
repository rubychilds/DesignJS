# Architecture review — 2026-05-24

> Point-in-time staff-level review of the DesignJS codebase, conducted 2026-05-24. Read-only findings only — no code changes were made during the review. Recommendations are organized into tiers; the user decides what to act on.
>
> Distinct from [`docs/adr/`](../adr/), which captures **durable architectural decisions**. This directory captures **point-in-time assessments**. ADRs continue to be the source of truth for decisions; this review surfaces gaps and recommendations relative to them.

## Start here

**→ [`architecture-review-2026-05-24.md`](./architecture-review-2026-05-24.md)** — master synthesis. Executive summary, top recommendations, proposed new ADRs.

Read this first. Each section links to the relevant deep dive for detail.

## Deep dives

Eight documents, written in this order:

| # | Phase | Document | Focus |
|---|---|---|---|
| 1 | Recon | [`architecture-recon-2026-05-24.md`](./architecture-recon-2026-05-24.md) | As-built snapshot |
| 2 | 2.1 | [`architecture-codebase.md`](./architecture-codebase.md) | Monorepo, packages, GrapesJS coupling |
| 3 | 2.2 | [`architecture-testing.md`](./architecture-testing.md) | Pyramid, reliability, coverage |
| 4 | 2.3 | [`architecture-ci-dx.md`](./architecture-ci-dx.md) | CI workflows, release, ESLint gap |
| 5 | 2.4 | [`architecture-security.md`](./architecture-security.md) | Threat model, bridge auth gap |
| 6 | 2.5 | [`architecture-deployment.md`](./architecture-deployment.md) | npm publish, Chrome ext, Supabase |
| 7 | 2.6 | [`architecture-observability.md`](./architecture-observability.md) | Logging, errors, analytics |
| 8 | 2.7 | [`architecture-docs.md`](./architecture-docs.md) | ADR hygiene, doc drift, Mintlify |

## Convention

Findings are numbered `F.NN` continuously across all deep dives, starting at F.01 in Phase 2.1 and ending at F.100 in Phase 2.7. Each finding has a severity rating and effort estimate. The synthesis groups them into **four tiers**:

| Tier | Meaning |
|---|---|
| Tier 1 | Fix-this-week — small, high-leverage, low-risk |
| Tier 2 | Fix-this-quarter — before v0.2 ships |
| Tier 3 | Keep an eye on — situational; revisit when conditions change |
| Tier 4 | Strategic — bundle into ADR-class decisions |

## Why this is in `docs/architecture/` not `docs/adr/`

ADRs are immutable decision records. This review is a point-in-time analysis — it'll be outdated in 6 months and that's fine. New reviews go in new dated subdirectories or files (e.g., `architecture-review-2026-11-XX.md`). The pattern:

- **ADRs:** durable, additive, never moved. *"We decided X because Y in 2026-04."*
- **Architecture reviews:** dated, point-in-time, may become historical. *"As of 2026-05, X looks like Y; recommend Z."*

When the review prompts a new architectural decision, that decision lands as a new ADR.
