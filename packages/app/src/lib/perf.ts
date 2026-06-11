/**
 * Performance instrumentation primitives for the DesignJS app.
 *
 * Pattern from docs/architecture/architecture-observability.md § 3.4 (F.85):
 * a thin wrapper that times every bridge handler with performance.now()
 * and logs a [designjs:perf] message. Output goes to console today; a TODO
 * marks the future PostHog .capture() call that lands with the
 * observability stack ADR (proposed ADR-0014, not yet drafted).
 *
 * The wrapper preserves the handler's return value and rethrows on error
 * (so the bridge dispatcher's error path still works). Errors are timed
 * too — the catch path measures, logs with `(error)` marker, then
 * rethrows.
 */

export type AsyncFn<T = unknown> = (params: unknown) => Promise<T> | T;

/**
 * Wrap an async function with a performance measurement that logs to
 * console under the [designjs:perf] prefix. Returns a new function with
 * the same call signature.
 *
 * Usage at the bridge dispatcher level: every MCP tool handler gets
 * wrapped automatically (via buildHandlers in bridge/handlers.ts) so we
 * see per-tool latency without per-handler boilerplate. To time an
 * ad-hoc operation (a save, a screenshot pipeline), use {@link measure}
 * instead.
 */
export function timeTool<T>(
  name: string,
  fn: AsyncFn<T>,
): (params: unknown) => Promise<T> {
  return async (params: unknown) => {
    const t0 = performance.now();
    try {
      const result = await fn(params);
      const dur = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log(`[designjs:perf] ${name}: ${dur.toFixed(0)}ms`);
      // TODO(ADR-0014): when PostHog lands, also emit:
      //   posthog?.capture("tool.executed", { tool: name, duration_ms: dur });
      return result;
    } catch (err) {
      const dur = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.warn(`[designjs:perf] ${name}: ${dur.toFixed(0)}ms (error)`);
      // TODO(ADR-0014): when PostHog lands, also emit:
      //   posthog?.capture("tool.failed", { tool: name, duration_ms: dur,
      //                                     error: (err as Error).message });
      throw err;
    }
  };
}

/**
 * Standalone measurement primitive for one-off perf checks (a save() call,
 * a screenshot pipeline, an export). Use {@link timeTool} for the bridge
 * handlers; use measure() for ad-hoc instrumentation.
 */
export async function measure<T>(
  name: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const t0 = performance.now();
  try {
    const result = await fn();
    const dur = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[designjs:perf] ${name}: ${dur.toFixed(0)}ms`);
    return result;
  } catch (err) {
    const dur = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.warn(`[designjs:perf] ${name}: ${dur.toFixed(0)}ms (error)`);
    throw err;
  }
}
