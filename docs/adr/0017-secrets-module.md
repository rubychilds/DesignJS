# ADR-0017: Secrets module — `~/.designjs/secrets.json`

**Status:** Proposed
**Date:** 2026-06-10
**Owner:** Architecture
**Related:** [`docs/architecture/architecture-security.md`](../architecture/architecture-security.md) §3 (F.58 — secrets-storage gap), §4 (data-classification table), §6.2 (redaction policy); [`docs/architecture/architecture-review-2026-05-24.md`](../architecture/architecture-review-2026-05-24.md) (Tier-4 ADR proposal); [`docs/specs/ai-chat.md`](../specs/ai-chat.md) "Three-tier key storage" + per-provider auth methods; [`docs/specs/repo-connection.md`](../specs/repo-connection.md) (GitHub OAuth-PKCE access token storage); [`SECURITY.md`](../../SECURITY.md) §"Currently out of scope" item 3 (forward-looking secrets policy); coupled with [ADR-0013](./0013-cloud-tier-supabase.md) (cloud-tier secrets share the same surface — but `SUPABASE_SERVICE_ROLE_KEY` and `GITHUB_APP_PRIVATE_KEY` are server-side, not client-side, and live in Edge Function env not in `secrets.json`) and [ADR-0015](./0015-bridge-protocol-v2.md) (bridge auth must land at the same time so the bridge has been hardened *before* any code that handles secrets ever runs against it)

---

## Context

DesignJS today (v0.1) does not handle user-supplied secrets. The bridge has no auth, the canvas has no API-key UI, the MCP server has no credentials. Everything is local-first; nothing is sensitive past the user's workspace files.

**v0.2 changes this.** The forward-looking specs introduce two distinct classes of secret the local app needs to read and write:

1. **AI provider API keys.** The chat panel's BYOK pattern (per [`docs/specs/ai-chat.md`](../specs/ai-chat.md)) lets a user paste an OpenRouter / Anthropic / OpenAI / Gemini key into Settings → AI Providers and have agents call those providers directly. Some providers also support non-key auth methods (Bedrock IAM, Vertex service-account JSON, Azure tenant + client + secret, Claude Code CLI subprocess) — the storage surface needs to be general enough to hold those structured credentials, not just opaque strings.
2. **GitHub OAuth-PKCE access tokens.** The repo-connection v1 spec ([`docs/specs/repo-connection.md`](../specs/repo-connection.md)) acquires a GitHub access token via in-browser OAuth-PKCE. The token authorizes `git fetch` / `git push` against a connected repo and lives across sessions — when the user reopens the canvas they shouldn't have to re-auth.

Both classes share the same requirements: durable single-user storage on the local filesystem, strict file permissions, explicit redaction discipline so secrets never leak into the artifacts the canvas does serialize (`.designjs.json`, screenshots, exports, logs, telemetry, support bundles).

`docs/specs/ai-chat.md` references a `~/.designjs/secrets.json` file. It is mentioned but never specified — no schema, no permission policy, no redaction discipline, no answer to "what does `getSecret('openrouter')` actually return when the env var is set instead of the file?" This ADR locks all of that down **before** any code that handles secrets lands. F.58 in the architecture-security deep dive called this out as the highest-priority secrets-handling gap to close before v0.2.

This ADR is the third leg of the v0.2 security gate. The bridge token (ADR-0015) closes the path by which a malicious localhost process could *read* a `~/.designjs/secrets.json` it doesn't own. The cloud-tier ADR-0013 covers server-side secrets that never enter this file. This ADR covers what's *in* the file, who can read it, and how it never leaks into anything else.

## Decision

### Storage

- **Path:** `~/.designjs/secrets.json`, resolved via `os.homedir()` (Node) at process start. The `~/.designjs/` directory is created if missing.
- **File permissions:** `0o600` (owner read+write only). Verified on every read; if the perms are wider, the loader logs `[designjs:secrets] secrets.json is world/group-readable — refusing to load; chmod 600 first`, and treats the file as absent. Refusing rather than silently fixing prevents a confused-deputy: if some other process wrote the file with wrong perms, we don't want to claim the contents are trustworthy.
- **Directory permissions:** `0o700` (owner only). Created with these perms on first write.
- **Process boundary:** the file is read by Node-side code only (the Vite dev server's bridge plugin, the persistence middleware, the MCP server subprocess). It is **never** read from the browser-rendered canvas — keys are exposed to the canvas only as redacted fingerprints (`"sk-…7Q2x"`) for the Settings UI's "key set" indicator. The actual key value reaches an LLM API by way of the chat panel's server-side proxy or the MCP server's outbound HTTP, never by way of `import.meta.env`.

### Schema

Zod-validated. Single root with two top-level sections — provider credentials and a per-provider `apiKeyHelper` escape hatch:

```ts
const Secrets = z.object({
  // Per-provider credentials. Each provider's value is loosely typed so we
  // can hold opaque api keys (OpenRouter, Anthropic, OpenAI, Gemini), IAM
  // tuples (Bedrock), service-account JSON (Vertex), tenant+client+secret
  // bundles (Foundry/Azure), and OAuth access tokens (GitHub) without a
  // schema-rev each time a provider lands.
  providers: z.record(
    z.string(),
    z.record(z.string(), z.string()),
  ).default({}),

  // Optional per-provider shell command that prints the credential to
  // stdout. When set, the loader spawns the command, reads stdout, and
  // uses the result instead of `providers[name][field]`. Pattern from
  // opencode's auth.json — lets users hook 1Password CLI, Vault,
  // aws-vault, etc. without DesignJS shipping per-tool plugins.
  apiKeyHelper: z.record(
    z.string(),
    z.string(),  // shell command
  ).optional(),
});
```

Example file:

```json
{
  "providers": {
    "openrouter": { "apiKey": "sk-or-v1-…" },
    "anthropic":  { "apiKey": "{env.ANTHROPIC_API_KEY}" },
    "bedrock":    { "accessKeyId": "AKIA…", "secretAccessKey": "…", "region": "us-east-1" },
    "vertex":     { "serviceAccountJson": "/Users/me/.vertex/sa.json", "projectId": "designjs-pilot" },
    "github":     { "accessToken": "gho_…", "scope": "repo,read:user" }
  },
  "apiKeyHelper": {
    "anthropic": "op read 'op://Personal/Anthropic API key/credential'"
  }
}
```

### `{env.VAR}` substitution

Any string value (anywhere in the schema) of the form `{env.<NAME>}` is resolved at read time against `process.env[<NAME>]`. The resolved value is returned to the caller as a plain string; `process.env` is read once per call (no caching that would make rotation invisible). If the env var is unset, the call returns `undefined` and logs `[designjs:secrets] {env.<NAME>} unresolved`.

This pattern is borrowed from opencode's `auth.json` and matches the experience CI users expect — drop a `{env.OPENROUTER_API_KEY}` placeholder into `secrets.json`, commit `secrets.json` to a private dotfiles repo, set the env var in the shell, and it works without storing the key in the file at all.

### Read API

```ts
// All async because apiKeyHelper invokes a subprocess.
getSecret(provider: string, field: string): Promise<string | undefined>
getProviderConfig(provider: string): Promise<Record<string, string> | undefined>
listProviders(): Promise<string[]>
```

- `getSecret` is the single primitive the chat panel and bridge dispatcher call. Returns plaintext only inside the Node process; never serialized to a renderer message, never logged.
- Resolution precedence: `apiKeyHelper[provider]` (subprocess, if defined for the requested field) → `{env.VAR}` substitution → literal value in `providers[provider][field]` → `undefined`.
- The loader holds the parsed object in process memory for the lifetime of the Node process; reads after the first don't hit disk. A file-watcher invalidates the cache when `secrets.json` changes (handles `chmod 600` + edit + save without restarting `pnpm dev`).

### Write API

```ts
setProviderConfig(provider: string, fields: Record<string, string>): Promise<void>
removeProviderConfig(provider: string): Promise<void>
```

- Atomic via the temp-file-and-rename pattern: write to `secrets.json.<random>.tmp` with mode `0o600`, fsync, `rename()` over the target. Crash-resistant — either the old or new file exists at any point, never a partial file.
- A single in-process mutex serializes writes so two concurrent `setProviderConfig` calls don't race on read-modify-write.
- The write API does **not** automatically resolve `{env.VAR}` placeholders. The caller chooses whether to store the literal credential or the placeholder; storing a placeholder is the right choice for CI, storing the literal is the right choice for an interactive user pasting a key in the Settings UI.

### Redaction

The Zod schema for every artifact DesignJS serializes (`.designjs.json`, exports, screenshots' EXIF, support bundles, telemetry events) carries a `.refine()` that asserts no string field contains a known secret-bearing pattern. The known patterns are:

- Anthropic: `/^sk-ant-/`
- OpenAI: `/^sk-[A-Za-z0-9]{40,}/`
- OpenRouter: `/^sk-or-/`
- GitHub: `/^(gh[opsu]_|github_pat_)/`
- AWS: `/^AKIA[0-9A-Z]{16}/`
- A custom "anything from `secrets.json`" check — at startup the secrets module computes the SHA-256 of every loaded credential string into an in-memory set; redaction checks `set.has(sha256(field))` and rejects on hit. Catches custom OAuth tokens and any future provider whose key shape doesn't match the regex panel.

A Zod `.refine()` rather than a one-off scrub means the check runs at the same point every other invariant runs (on the way out) and a missed serialization site fails loudly at the schema boundary rather than leaking quietly.

### What is *not* allowed

- Reading secrets from process.argv (would leak to `ps`). Helpers requiring secrets accept them via env or stdin.
- Writing secret values to log lines, including debug logs. `console.log('[designjs:secrets] loaded provider', name)` is fine; `console.log('[designjs:secrets] loaded openrouter:', value)` is forbidden by code review and lint (an internal eslint rule rejects any template literal that interpolates a `getSecret(...)` call into `console.*`).
- Sending the file's parsed contents over the bridge. Bridge messages carry redacted fingerprints (last-4 + length) for UI; the actual key value never leaves Node.

## Threat model

**What this protects against:**

- Accidental leak via the visible artifacts the canvas creates — `.designjs.json` committed to a public repo, a screenshot pasted into a Slack thread, an export shared by URL, a support-bundle attachment, a telemetry event. The Zod-refinement redaction is the single backstop for all of these.
- World-readable secrets on a multi-user machine — explicit `0o600` check on every read with refuse-rather-than-fix.
- Hostile localhost processes — addressed by the bridge token in [ADR-0015](./0015-bridge-protocol-v2.md), which must land at the same time. Without bridge auth, any localhost process could ask the canvas's bridge-routed-MCP-server for a `getSecret` proxy. With it, only the paired peers can.

**What this does NOT protect against:**

- An attacker who can already run code as the user. They own the machine; they can `cat ~/.designjs/secrets.json` whether DesignJS is running or not. Same trust boundary as `~/.ssh/id_rsa`, `~/.aws/credentials`, `~/.npmrc`. Outside our threat model.
- A maliciously installed browser extension that captures Settings → AI Providers keystrokes during paste. Mitigation lives elsewhere (CSP, isolated input elements) and is not in scope for the secrets module.
- A compromised npm dependency that exfiltrates `process.env`. The `{env.VAR}` substitution path inherits this risk — the file path doesn't help if a malicious dep already reads `process.env.OPENROUTER_API_KEY`. Out of scope; the broader supply-chain mitigation is Dependabot grouping + `pnpm audit` (committed in F.47).

## Consequences

**Positive**

- One module owns the read/write surface for every secret. New providers add an entry to the `providers` record; no schema changes, no migration.
- Redaction is a Zod refinement that runs at the serialization boundary — a missed scrub turns into a noisy schema failure, not a silent leak.
- The `apiKeyHelper` escape hatch enables enterprise integration (1Password CLI, Vault, aws-vault, `gcloud auth`) without DesignJS shipping per-vendor plugins or carrying their auth libraries as deps. Matches an established pattern (opencode, aws-cli).
- The `{env.VAR}` substitution covers the CI use case without forcing two storage modes; `secrets.json` itself becomes the only thing the loader knows about.
- The Node-only boundary makes the renderer's threat surface meaningfully smaller — a third-party React component can't sniff `import.meta.env` to find a key that isn't there.

**Negative**

- One more init concern at process start (parse the file, validate permissions, fail loudly on bad perms). Adds maybe 5–10ms to `pnpm dev` startup.
- The `apiKeyHelper` subprocess spawn adds latency per key fetch when the helper is in use — a `1password` CLI call is typically 50–200ms. Cache the resolution for the process lifetime; bust the cache on `secrets.json` changes. Users with `apiKeyHelper` set accept this trade-off explicitly.
- File-format migrations become a thing we have to plan for. The schema's top-level `providers` + `apiKeyHelper` shape is loose enough that adding fields under a provider doesn't break old files, but a structural change (e.g. introducing per-workspace scoping) would need a migration step. Document the migration policy in this ADR's addendum the first time it bites.

**Risks**

- A bug in the atomic-write path that loses the user's keys. Mitigation: write to temp + fsync + rename is the standard durable-write recipe; unit-test the write path with crash simulations (kill mid-temp, kill mid-rename).
- An incomplete redaction-pattern set lets a leak past the refinement. Mitigation: the sha256-set check covers anything in `secrets.json` regardless of key shape; the regex panel is the second layer for keys that *aren't* in the file (e.g. a user-pasted curl command in an LLM prompt).
- A future provider's auth flow doesn't fit the `Record<string, string>` shape (e.g. a provider that wants a binary blob). Mitigation: hold off on that until a real need surfaces; encode as base64 in the meantime.

## Open questions

1. **OS keychain integration for a future desktop wrapper.** When DesignJS ships as Electron / Tauri (a date that hasn't been decided), the OS keychain (macOS Keychain, Windows Credential Manager, libsecret) is the better store than `~/.designjs/secrets.json`. The right path is probably: keep `~/.designjs/secrets.json` as the universal fallback and check the OS keychain first when in a desktop-wrapped binary. Defer the implementation until the desktop wrapper is on the roadmap.
2. **Per-project vs global secrets.** A user with two side projects each using different OpenRouter accounts has no way to express that today; the file is global. Start global, revisit if users ask. The likely path: a `secrets.workspace.json` checked into a `~/.designjs/projects/<id>/` directory, layered over the global file with project-specific overrides.
3. **Rotation policy.** The file has no notion of expiry or rotation reminders. For long-lived API keys this is fine; for OAuth tokens that expire it is not — the GitHub access token has an explicit expiry, and the file should hold the expiry alongside the token so the bridge can refresh before the request fails. Captured in the GitHub provider's schema. Other providers don't need this today; add when they do.
4. **Importing from existing tool config.** Users coming from another agent tool likely have an `~/.openrouter`, `~/.anthropic/credentials`, etc. A `designjs secrets import` CLI subcommand could read these. Out of scope for this ADR but worth a follow-up if users ask.
5. **Should the `apiKeyHelper` invocation be sandboxed?** The shell command runs as the user with no sandboxing. A malicious `secrets.json` could embed a destructive helper. Mitigation today: the file is owner-only-writable, so this only matters if the user themselves wrote a bad helper — same trust boundary as `~/.bashrc`. Could be revisited if `secrets.json` becomes machine-shared (it shouldn't, but: open question).
