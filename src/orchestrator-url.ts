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
 * Returns the origin of `url` if — and only if — it's a well-formed http(s)
 * URL. Anything else (a bare host:port with no scheme, a non-web scheme, or
 * plain garbage) yields `null` rather than `new URL()`'s "null" string.
 *
 * This matters because `new URL()` does NOT throw for a string like
 * "localhost:3000" — it happily parses it as an opaque-origin URL whose
 * `.origin` is the literal string `"null"`. Callers that only guard with a
 * try/catch (or a truthiness check on the result) let that string slip
 * through as if it were a real origin, which is never the intent here: every
 * caller of this helper wants "is this a real, reachable http/https origin",
 * and a same-literal-string "null" is not one.
 */
export function safeHttpOrigin(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

/**
 * Reduces a list of URLs to the distinct http(s) origins they touch,
 * preserving first-seen order. Used to build the webview CSP frame-src.
 * Non-http(s) and unparseable entries are skipped (see `safeHttpOrigin`).
 */
export function distinctOrigins(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const origin = safeHttpOrigin(url);
    if (!origin) continue;
    if (!seen.has(origin)) {
      seen.add(origin);
      out.push(origin);
    }
  }
  return out;
}
