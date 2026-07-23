import * as http from 'http';
import * as https from 'https';

export interface JsonResponse<T = unknown> {
  status: number;
  body: T;
}

/**
 * Minimal JSON HTTP client for extension-host network calls (matches this
 * codebase's existing `http`/`https` usage rather than adding a `fetch`
 * dependency). Resolves for any response the server sends valid JSON for —
 * including non-2xx statuses, since callers (e.g. device-code polling)
 * branch on structured error bodies carried on 4xx responses. Rejects only
 * for transport failures (timeout, connection refused, DNS) or a response
 * body that isn't valid JSON.
 */
export function requestJson<T = unknown>(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  timeoutMs = 10_000,
  headers: Record<string, string> = {}
): Promise<JsonResponse<T>> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }

    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.request(
      parsed,
      {
        method,
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf-8');
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          try {
            const parsedBody = raw ? (JSON.parse(raw) as T) : ({} as T);
            resolve({ status, body: parsedBody });
          } catch (err) {
            reject(
              new Error(
                `Invalid JSON response from ${url} (status ${status}): ${
                  err instanceof Error ? err.message : String(err)
                }`
              )
            );
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request to ${url} timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => reject(err));

    if (payload) req.write(payload);
    req.end();
  });
}
