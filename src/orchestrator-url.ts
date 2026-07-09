/**
 * The hosted ClusterCode orchestrator console. Used whenever a developer has
 * not pointed the extension elsewhere via the ORCHESTRATOR_URL env var.
 */
export const PROD_ORCHESTRATOR_URL = 'https://console.clustercode.io';

/**
 * Resolves the orchestrator URL: the ORCHESTRATOR_URL environment variable if a
 * developer set one (e.g. to target a local/UAT environment), otherwise the
 * hosted console. There is intentionally no user-facing setting.
 */
export function resolveOrchestratorUrl(env: string | undefined): string {
  return env?.trim() || PROD_ORCHESTRATOR_URL;
}

/**
 * Reduces a list of (possibly redirecting) URLs to the distinct origins they
 * touch, preserving first-seen order. Used to build the webview CSP frame-src
 * so the iframe can follow the orchestrator's auth redirect (e.g. to a portal
 * login on a different port/host). Unparseable entries are skipped.
 */
export function distinctOrigins(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      continue;
    }
    if (!seen.has(origin)) {
      seen.add(origin);
      out.push(origin);
    }
  }
  return out;
}
