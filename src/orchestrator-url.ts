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
 * Builds the URL for the embedded console iframe: the orchestrator's public
 * embed route, with the given query params appended. Robust to a trailing
 * slash on the orchestrator URL — a leading "/" in the relative reference
 * always resolves against the origin, not any existing path.
 */
export function buildEmbedUrl(orchestratorUrl: string, params: Record<string, string>): string {
  const url = new URL('/embed', orchestratorUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Reduces a list of URLs to the distinct origins they touch, preserving
 * first-seen order. Used to build the webview CSP frame-src. Unparseable
 * entries are skipped.
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
