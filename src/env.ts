// env.ts — small env-var helpers, kept side-effect-free so they unit-test
// without importing bridge.ts (which evaluates paths + reads config on load).

/**
 * Read an env var by its current name, falling back to a deprecated legacy
 * alias. Empty strings are treated as unset (so `FORTYTWO_ROOT= ` falls through
 * to the legacy var or the caller's default). Used to rename the historical
 * `FORD_*` vars to `FORTYTWO_*` without breaking existing deployments.
 */
export function envCompat(
  env: Record<string, string | undefined>,
  current: string,
  legacy: string,
): string | undefined {
  return env[current] || env[legacy] || undefined;
}
