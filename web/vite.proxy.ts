// Origins of the Vite dev server itself. Only these are rewritten to the
// proxy target, so a cross-site request that reaches the server through the
// proxy keeps its foreign Origin and still fails the server's CSRF check.
export const DEV_ORIGINS: readonly string[] = ['http://127.0.0.1:5173', 'http://localhost:5173'];

/**
 * Returns the Origin header to forward to `target`: the target's own origin
 * when the request came from the dev server, otherwise the incoming value
 * unchanged (including undefined when the browser sent none).
 */
export function proxiedOrigin(incoming: string | undefined, target: string): string | undefined {
  if (incoming !== undefined && DEV_ORIGINS.includes(incoming)) {
    return new URL(target).origin;
  }
  return incoming;
}
