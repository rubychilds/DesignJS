/**
 * Environment-variable validation for @designjs/app.
 *
 * All env vars are validated against a Zod schema at module load time.
 * Production builds fail loudly if a required var is missing/invalid;
 * dev allows missing optional vars to flow through as undefined.
 *
 * Reads from import.meta.env (Vite's wrapper around process.env) for
 * the browser side; from process.env on the server side.
 *
 * Pattern matches Hono / Vercel — schema close to the code that
 * consumes the env, so a contributor adding a new env var has one
 * place to update.
 *
 * See ADR-0013 (cloud tier) and the .env.example at repo root for
 * the broader env-management strategy.
 */
import { z } from "zod";

const EnvSchema = z.object({
  // Bridge
  DESIGNJS_BRIDGE_PORT: z.coerce.number().int().positive().optional(),
  DESIGNJS_BRIDGE_TOKEN: z.string().min(32).optional(),

  // Cloud tier (typically undefined for local-first; required if cloud feature flags enabled)
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(20).optional(),

  // Observability (always optional — opt-in only)
  SENTRY_DSN: z.string().url().optional(),
  POSTHOG_PROJECT_API_KEY: z.string().min(20).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Source the env from Vite's import.meta.env when we're in a browser
 * bundle; from process.env otherwise (Node dev-server context).
 */
function readRaw(): Record<string, string | undefined> {
  // Vite injects import.meta.env at build time
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return viteEnv ?? (typeof process !== "undefined" ? process.env : {});
}

const result = EnvSchema.safeParse(readRaw());

if (!result.success) {
  console.error("[designjs:env] env validation failed:", result.error.format());
  throw new Error(
    "Invalid env. Check .env against .env.example, or env.ts schema.",
  );
}

export const env: Env = result.data;
